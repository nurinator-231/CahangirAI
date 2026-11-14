pub mod clipboard;
pub mod db;
pub mod p2p;
pub mod reminders;
pub mod sync;
pub mod sysinfo;

use db::storage::{now_ms, AppConfig, ChatMessageRecord, Database, TransferRecord};
use p2p::client::{PeerAuth, SendFileResult};
use p2p::server::{start_p2p_server, P2pServerState};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use sysinfo::monitor::{SysMonitor, SystemMetrics};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartExt};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Notify;

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

pub struct AppState {
    pub db: Database,
    pub sys_monitor: Arc<tokio::sync::Mutex<SysMonitor>>,
    pub cancel_flag: Arc<AtomicBool>,
    pub last_clipboard_hash: Arc<Mutex<String>>,
    pub download_dir: Arc<Mutex<PathBuf>>,
    pub sync_notify: Arc<Notify>,
    pub reminder_notify: Arc<Notify>,
    pub sync_lock: Arc<tokio::sync::Mutex<()>>,
    pub peers: Arc<Mutex<Vec<Value>>>,
}

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build().map_err(e2s)
}

fn local_changed(state: &AppState) {
    state.sync_notify.notify_one();
    state.reminder_notify.notify_one();
}

// ---------------- Config & pairing ----------------
#[tauri::command]
fn get_app_config(state: State<'_, AppState>) -> Result<AppConfig, String> {
    let mut cfg = state.db.get_config().map_err(e2s)?;
    cfg.mesh_key = if cfg.mesh_key.is_empty() { String::new() } else { "(set)".into() };
    cfg.device_token = if cfg.device_token.is_empty() { String::new() } else { "(paired)".into() };
    Ok(cfg)
}

#[tauri::command]
fn save_app_config(cfg: AppConfig, state: State<'_, AppState>, app: AppHandle) -> Result<AppConfig, String> {
    // Secrets and sync bookkeeping are owned by the backend, never overwritten from the UI.
    let saved = state
        .db
        .update_config(|c| {
            c.server_url = cfg.server_url.trim().trim_end_matches('/').to_string();
            c.device_name = cfg.device_name.trim().chars().take(100).collect();
            c.p2p_port = if cfg.p2p_port >= 1024 { cfg.p2p_port } else { 8767 };
            c.download_dir = cfg.download_dir.clone();
            c.clipboard_sync_enabled = cfg.clipboard_sync_enabled;
            c.clipboard_auto_share = cfg.clipboard_auto_share;
            c.auto_start = cfg.auto_start;
            c.minimize_to_tray = cfg.minimize_to_tray;
            c.theme = cfg.theme.clone();
            c.language = cfg.language.clone();
            c.auto_sync_minutes = cfg.auto_sync_minutes.min(24 * 60);
            c.planner_day_start = cfg.planner_day_start.clone();
            c.planner_day_end = cfg.planner_day_end.clone();
        })
        .map_err(e2s)?;
    *state.download_dir.lock().unwrap() = PathBuf::from(&saved.download_dir);
    // Start with Windows: really register/unregister the OS login item.
    let al = app.autolaunch();
    let res = if saved.auto_start { al.enable() } else { al.disable() };
    if let Err(e) = res {
        return Err(format!("Ayarlar saxlandı, amma avtomatik başlanğıc dəyişdirilə bilmədi: {}", e));
    }
    state.sync_notify.notify_one();
    get_app_config(state)
}

#[tauri::command]
fn get_autostart_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(e2s)
}

#[tauri::command]
async fn test_server_connection(server_url: String) -> Result<Value, String> {
    let res = http()?
        .get(format!("{}/api/health", server_url.trim().trim_end_matches('/')))
        .send()
        .await
        .map_err(|e| format!("Serverə qoşulmaq olmadı: {}", e))?;
    if res.status().is_success() {
        res.json().await.map_err(e2s)
    } else {
        Err(format!("Server HTTP {} qaytardı", res.status()))
    }
}

#[tauri::command]
async fn register_device_api(server_url: String, admin_token: String, device_name: String, state: State<'_, AppState>) -> Result<Value, String> {
    let url = server_url.trim().trim_end_matches('/').to_string();
    let cfg = state.db.get_config().map_err(e2s)?;
    let name = if device_name.trim().is_empty() { cfg.device_name.clone() } else { device_name.trim().to_string() };
    let res = http()?
        .post(format!("{}/api/auth/register-device", url))
        .header("X-Admin-Token", admin_token.trim())
        .json(&json!({"device_id": cfg.device_id, "device_name": name, "platform": std::env::consts::OS}))
        .send()
        .await
        .map_err(|e| format!("Sorğu uğursuz oldu: {}", e))?;
    let status = res.status();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(match status.as_u16() {
            403 => "Admin token yanlışdır.".into(),
            429 => "Çox uğursuz cəhd — 10 dəqiqə sonra yenidən yoxlayın.".into(),
            _ => format!("Qeydiyyat alınmadı: HTTP {} {}", status, body),
        });
    }
    let token = body["api_token"].as_str().ok_or("Server token qaytarmadı")?.to_string();
    let server_changed = cfg.server_url.trim_end_matches('/') != url;
    state
        .db
        .update_config(|c| {
            c.server_url = url.clone();
            c.device_token = token;
            c.device_name = name.clone();
            c.admin_token.clear(); // the pairing secret is not kept on the device
            if server_changed {
                c.last_server_rev = 0; // full initial sync from a different server
            }
        })
        .map_err(e2s)?;
    state.sync_notify.notify_one();
    Ok(json!({"success": true, "device_id": cfg.device_id, "device_name": name}))
}

#[tauri::command]
async fn unpair_device(state: State<'_, AppState>) -> Result<(), String> {
    state
        .db
        .update_config(|c| {
            c.device_token.clear();
            c.mesh_key.clear();
            c.last_server_rev = 0;
            c.last_sync_status = "never".into();
        })
        .map_err(e2s)?;
    Ok(())
}

/// Paired devices (with P2P addresses) using this device's own token.
#[tauri::command]
async fn list_paired_devices(state: State<'_, AppState>) -> Result<Value, String> {
    let v = sync::server_get(&state.db, "/api/devices").await?;
    if let Some(arr) = v.as_array() {
        *state.peers.lock().unwrap() = arr.clone();
    }
    Ok(v)
}

#[tauri::command]
async fn list_devices_api(server_url: String, admin_token: String, state: State<'_, AppState>) -> Result<Value, String> {
    let url = if server_url.is_empty() { state.db.get_config().map_err(e2s)?.server_url } else { server_url };
    let res = http()?
        .get(format!("{}/api/auth/devices", url.trim_end_matches('/')))
        .header("X-Admin-Token", admin_token.trim())
        .send()
        .await
        .map_err(e2s)?;
    if res.status().is_success() {
        res.json().await.map_err(e2s)
    } else {
        Err(format!("Cihazlar alınmadı: HTTP {}", res.status()))
    }
}

#[tauri::command]
async fn revoke_device_api(admin_token: String, target_device_id: String, state: State<'_, AppState>) -> Result<Value, String> {
    let url = state.db.get_config().map_err(e2s)?.server_url;
    let res = http()?
        .post(format!("{}/api/auth/revoke-device", url.trim_end_matches('/')))
        .header("X-Admin-Token", admin_token.trim())
        .json(&json!({"device_id": target_device_id}))
        .send()
        .await
        .map_err(e2s)?;
    let st = res.status();
    if st.is_success() {
        res.json().await.map_err(e2s)
    } else if st.as_u16() == 403 {
        Err("Admin token yanlışdır.".into())
    } else {
        Err(format!("Ləğv alınmadı: HTTP {}", st))
    }
}

// ---------------- Sync ----------------
fn pending_count(db: &Database) -> usize {
    db::storage::ENTITIES.iter().map(|e| db.pending(e.name).map(|v| v.len()).unwrap_or(0)).sum()
}

async fn run_sync(app: &AppHandle) -> Result<sync::SyncReport, String> {
    let state = app.state::<AppState>();
    let _guard = state.sync_lock.lock().await;
    let cfg = state.db.get_config().map_err(e2s)?;
    let info = sync::P2pInfo { hosts: sync::local_ipv4s(), port: cfg.p2p_port, platform: std::env::consts::OS.into(), app_version: APP_VERSION.into() };
    let _ = app.emit("sync://status", json!({"status": "syncing"}));
    let result = sync::sync_once(&state.db, Some(info)).await;
    match &result {
        Ok(rep) => {
            let _ = state.db.update_config(|c| {
                c.last_sync_status = "ok".into();
                c.last_sync_error.clear();
            });
            if !rep.changed_entities.is_empty() {
                let _ = app.emit("data://changed", json!({"entities": rep.changed_entities}));
                state.reminder_notify.notify_one();
            }
            handle_incoming_clipboard(app, &rep.incoming_clipboard);
            if let Ok(Value::Array(devs)) = sync::server_get(&state.db, "/api/devices").await {
                *state.peers.lock().unwrap() = devs;
            }
        }
        Err(e) => {
            let _ = state.db.update_config(|c| {
                c.last_sync_status = "error".into();
                c.last_sync_error = e.clone();
            });
        }
    }
    let cfg = state.db.get_config().unwrap_or_default();
    let _ = app.emit(
        "sync://status",
        json!({"status": cfg.last_sync_status, "error": cfg.last_sync_error, "last_sync_time": cfg.last_sync_time, "pending": pending_count(&state.db),
               "conflicts": result.as_ref().map(|r| r.conflicts.len()).unwrap_or(0)}),
    );
    result
}

#[tauri::command]
async fn trigger_delta_sync(app: AppHandle) -> Result<sync::SyncReport, String> {
    run_sync(&app).await
}

#[tauri::command]
fn get_sync_status(state: State<'_, AppState>) -> Result<Value, String> {
    let cfg = state.db.get_config().map_err(e2s)?;
    Ok(json!({
        "configured": !cfg.server_url.is_empty() && !cfg.device_token.is_empty(),
        "server_url": cfg.server_url, "status": cfg.last_sync_status, "error": cfg.last_sync_error,
        "last_sync_time": cfg.last_sync_time, "pending": pending_count(&state.db), "auto_sync_minutes": cfg.auto_sync_minutes,
        "p2p_ready": !cfg.mesh_key.is_empty(), "device_id": cfg.device_id
    }))
}

#[tauri::command]
async fn list_conflicts(state: State<'_, AppState>) -> Result<Value, String> {
    sync::server_get(&state.db, "/api/sync/conflicts").await
}

// ---------------- Generic entities ----------------
const ALLOWED: [&str; 7] = ["reminders", "memories", "projects", "tasks", "events", "plan_blocks", "clipboard_items"];
fn check_entity(e: &str) -> Result<(), String> {
    if ALLOWED.contains(&e) {
        Ok(())
    } else {
        Err(format!("unknown entity {}", e))
    }
}

#[tauri::command]
fn entity_list(entity: String, include_deleted: Option<bool>, state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    check_entity(&entity)?;
    state.db.list(&entity, include_deleted.unwrap_or(false)).map_err(e2s)
}

#[tauri::command]
fn entity_save(entity: String, item: Value, state: State<'_, AppState>) -> Result<Value, String> {
    check_entity(&entity)?;
    let v = state.db.save_local(&entity, &item).map_err(e2s)?;
    if entity == "reminders" {
        // Editing the time re-arms the alarm on this device.
        if let Some(id) = v["id"].as_str() {
            if item.get("due").is_some() || item.get("snooze").is_some() {
                let _ = state.db.set_reminder_fired(id, None);
            }
        }
    }
    local_changed(&state);
    Ok(v)
}

#[tauri::command]
fn entity_save_many(entity: String, items: Vec<Value>, state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    check_entity(&entity)?;
    let out: Result<Vec<Value>, String> = items.iter().map(|i| state.db.save_local(&entity, i).map_err(e2s)).collect();
    local_changed(&state);
    out
}

#[tauri::command]
fn entity_delete(entity: String, id: String, state: State<'_, AppState>) -> Result<bool, String> {
    check_entity(&entity)?;
    let r = state.db.delete_local(&entity, &id).map_err(e2s)?;
    local_changed(&state);
    Ok(r)
}

// Legacy typed commands (kept for compatibility with existing views).
#[tauri::command]
fn get_memories(include_deleted: bool, state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    entity_list("memories".into(), Some(include_deleted), state)
}
#[tauri::command]
fn save_memory(mem: Value, state: State<'_, AppState>) -> Result<Value, String> {
    entity_save("memories".into(), mem, state)
}
#[tauri::command]
fn delete_memory(id: String, state: State<'_, AppState>) -> Result<bool, String> {
    entity_delete("memories".into(), id, state)
}
#[tauri::command]
fn get_reminders(include_deleted: bool, state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    entity_list("reminders".into(), Some(include_deleted), state)
}
#[tauri::command]
fn save_reminder(rem: Value, state: State<'_, AppState>) -> Result<Value, String> {
    entity_save("reminders".into(), rem, state)
}
#[tauri::command]
fn complete_reminder(id: String, state: State<'_, AppState>) -> Result<(), String> {
    reminders::complete(&state.db, &id)?;
    local_changed(&state);
    Ok(())
}
#[tauri::command]
fn snooze_reminder(id: String, minutes: Option<i64>, state: State<'_, AppState>) -> Result<i64, String> {
    let r = reminders::snooze(&state.db, &id, minutes.unwrap_or(10), now_ms())?;
    local_changed(&state);
    Ok(r)
}
#[tauri::command]
fn delete_reminder(id: String, state: State<'_, AppState>) -> Result<bool, String> {
    entity_delete("reminders".into(), id, state)
}
#[tauri::command]
fn get_projects(include_deleted: bool, state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    entity_list("projects".into(), Some(include_deleted), state)
}
#[tauri::command]
fn save_project(prj: Value, state: State<'_, AppState>) -> Result<Value, String> {
    entity_save("projects".into(), prj, state)
}
#[tauri::command]
fn delete_project(id: String, state: State<'_, AppState>) -> Result<bool, String> {
    entity_delete("projects".into(), id, state)
}

#[tauri::command]
async fn get_notification_permission(app: AppHandle) -> Result<String, String> {
    app.notification().permission_state().map(|p| format!("{:?}", p).to_lowercase()).map_err(e2s)
}

#[tauri::command]
fn test_notification(app: AppHandle) -> Result<(), String> {
    app.notification().builder().title("Cahangir").body("Bildirişlər işləyir ✓").show().map_err(e2s)
}

// ---------------- AI (via the Debian AI router; keys never leave the server) ----------------
#[tauri::command]
async fn ai_providers(state: State<'_, AppState>) -> Result<Value, String> {
    sync::server_get(&state.db, "/api/ai/providers").await
}

#[tauri::command]
async fn ai_chat(messages: Value, context: Option<String>, state: State<'_, AppState>) -> Result<Value, String> {
    let (status, v) = sync::server_post(&state.db, "/api/ai/chat", &json!({"messages": messages, "context": context}), 60).await?;
    Ok(json!({"status": status, "body": v}))
}

#[tauri::command]
async fn ai_parse(text: String, now_local: String, tz_offset_minutes: i64, weekday: String, state: State<'_, AppState>) -> Result<Value, String> {
    let (status, v) = sync::server_post(
        &state.db,
        "/api/ai/parse",
        &json!({"text": text, "now_local": now_local, "tz_offset_minutes": tz_offset_minutes, "weekday": weekday}),
        45,
    )
    .await?;
    Ok(json!({"status": status, "body": v}))
}

// ---------------- File transfer ----------------
fn peer_auth(db: &Database) -> PeerAuth {
    let cfg = db.get_config().unwrap_or_default();
    PeerAuth { mesh_key: cfg.mesh_key, device_id: cfg.device_id }
}

#[tauri::command]
async fn ping_peer(peer_ip: String, peer_port: u16, state: State<'_, AppState>) -> Result<Value, String> {
    p2p::client::ping_peer(&peer_ip, peer_port, &peer_auth(&state.db)).await
}

#[tauri::command]
async fn start_file_send(peer_ip: String, peer_port: u16, file_path: String, peer_name: Option<String>, state: State<'_, AppState>, app: AppHandle) -> Result<SendFileResult, String> {
    let cfg = state.db.get_config().unwrap_or_default();
    state.cancel_flag.store(false, Ordering::Relaxed);
    let started = std::sync::atomic::AtomicBool::new(false);
    let app2 = app.clone();
    let fname = std::path::Path::new(&file_path).file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
    let res = p2p::client::send_file(&peer_ip, peer_port, &peer_auth(&state.db), &file_path, &cfg.device_name, state.cancel_flag.clone(), |tid, sent, total, pct, speed| {
        if !started.swap(true, Ordering::Relaxed) {
            let _ = app2.emit("p2p://transfer-started", json!({"transfer_id": tid, "filename": fname, "file_size": total, "peer": peer_ip, "direction": "send"}));
        }
        let _ = app2.emit("p2p://transfer-progress", json!({"transfer_id": tid, "sent": sent, "total": total, "percent": pct, "speed_mbps": speed, "direction": "send"}));
    })
    .await;
    let record = TransferRecord {
        id: if res.transfer_id.is_empty() { uuid::Uuid::new_v4().to_string() } else { res.transfer_id.clone() },
        filename: res.filename.clone(),
        file_size: res.file_size as i64,
        direction: "send".into(),
        peer_device: peer_name.unwrap_or(peer_ip),
        status: if res.success { "completed" } else if res.canceled { "canceled" } else { "failed" }.into(),
        speed_mbps: res.speed_mbps,
        sha256: res.sha256.clone(),
        timestamp: now_ms(),
    };
    let _ = state.db.add_transfer(&record);
    let ev = if res.success { "p2p://transfer-complete" } else { "p2p://transfer-failed" };
    let _ = app.emit(ev, json!({"transfer_id": record.id, "filename": res.filename, "file_size": res.file_size, "speed_mbps": res.speed_mbps,
        "sha256": res.sha256, "direction": "send", "verified": res.verified, "error": res.error}));
    Ok(res)
}

#[tauri::command]
fn cancel_file_transfer(state: State<'_, AppState>) -> Result<(), String> {
    state.cancel_flag.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn get_transfer_history(state: State<'_, AppState>) -> Result<Vec<TransferRecord>, String> {
    state.db.get_transfers().map_err(e2s)
}

#[tauri::command]
fn clear_transfer_history(state: State<'_, AppState>) -> Result<(), String> {
    state.db.clear_transfers().map_err(e2s)
}

#[tauri::command]
async fn pick_file_dialog(app_handle: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app_handle.dialog().file().pick_file(move |p| {
        let _ = tx.send(p.map(|p| p.to_string()));
    });
    rx.await.map_err(e2s)
}

#[tauri::command]
async fn pick_folder_dialog(app_handle: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app_handle.dialog().file().pick_folder(move |p| {
        let _ = tx.send(p.map(|p| p.to_string()));
    });
    rx.await.map_err(e2s)
}

// ---------------- Clipboard ----------------
fn other_peers(state: &AppState) -> Vec<(String, u16, String)> {
    let me = state.db.get_config().map(|c| c.device_id).unwrap_or_default();
    state
        .peers
        .lock()
        .unwrap()
        .iter()
        .filter(|d| d["device_id"].as_str() != Some(me.as_str()) && d["p2p_port"].as_i64().unwrap_or(0) > 0)
        .filter_map(|d| {
            let host = d["p2p_hosts"].as_array()?.first()?.as_str()?.to_string();
            Some((host, d["p2p_port"].as_i64()? as u16, d["device_name"].as_str().unwrap_or("").to_string()))
        })
        .collect()
}

/// Shares text with all paired devices: stored as a synced clipboard item (delivered via
/// the server to offline devices later) and pushed directly to reachable peers.
async fn share_clipboard_text(app: &AppHandle, text: String) -> Result<Value, String> {
    let state = app.state::<AppState>();
    if text.trim().is_empty() {
        return Err("Pano boşdur".into());
    }
    if text.len() > 100_000 {
        return Err("Mətn çox uzundur (maksimum 100 KB)".into());
    }
    let cfg = state.db.get_config().map_err(e2s)?;
    let hash = clipboard::sync::hash_text(&text);
    *state.last_clipboard_hash.lock().unwrap() = hash.clone();
    let item = state.db.save_local("clipboard_items", &json!({"text": text, "hash": hash, "origin_name": cfg.device_name})).map_err(e2s)?;
    let id = item["id"].as_str().unwrap_or_default().to_string();
    let auth = peer_auth(&state.db);
    let mut delivered = Vec::new();
    let mut failed = Vec::new();
    for (host, port, name) in other_peers(&state) {
        match p2p::client::send_clipboard(&host, port, &auth, &id, &text, &cfg.device_name).await {
            Ok(_) => delivered.push(name),
            Err(e) => failed.push(json!({"device": name, "error": e})),
        }
    }
    state.sync_notify.notify_one();
    let _ = app.emit("clipboard://shared", json!({"id": id}));
    Ok(json!({"id": id, "delivered_direct": delivered, "failed_direct": failed, "queued_for_sync": true}))
}

#[tauri::command]
async fn share_clipboard(text: Option<String>, app: AppHandle) -> Result<Value, String> {
    let t = match text {
        Some(t) => t,
        None => app.clipboard().read_text().map_err(|e| format!("Pano oxunmadı: {}", e))?,
    };
    share_clipboard_text(&app, t).await
}

#[tauri::command]
async fn send_clipboard_to_peer_cmd(peer_ip: String, peer_port: u16, text: String, state: State<'_, AppState>) -> Result<Value, String> {
    let cfg = state.db.get_config().unwrap_or_default();
    let hash = clipboard::sync::hash_text(&text);
    *state.last_clipboard_hash.lock().unwrap() = hash.clone();
    let item = state.db.save_local("clipboard_items", &json!({"text": text, "hash": hash, "origin_name": cfg.device_name})).map_err(e2s)?;
    state.sync_notify.notify_one();
    p2p::client::send_clipboard(&peer_ip, peer_port, &peer_auth(&state.db), item["id"].as_str().unwrap_or_default(), &text, &cfg.device_name).await
}

#[tauri::command]
fn copy_to_clipboard(text: String, state: State<'_, AppState>, app: AppHandle) -> Result<(), String> {
    *state.last_clipboard_hash.lock().unwrap() = clipboard::sync::hash_text(&text);
    app.clipboard().write_text(text).map_err(e2s)
}

#[tauri::command]
fn set_last_clipboard_hash(hash: String, state: State<'_, AppState>) -> Result<(), String> {
    *state.last_clipboard_hash.lock().unwrap() = hash;
    Ok(())
}

fn handle_incoming_clipboard(app: &AppHandle, items: &[Value]) {
    let state = app.state::<AppState>();
    let cfg = state.db.get_config().unwrap_or_default();
    let newest = match items.last() {
        Some(n) => n,
        None => return,
    };
    let _ = app.emit("clipboard://received", json!({"count": items.len()}));
    // Only very recent text is put on the clipboard; older history is just listed.
    let fresh = now_ms() - newest["created_at"].as_i64().unwrap_or(0) < 10 * 60 * 1000;
    if !cfg.clipboard_sync_enabled || !fresh {
        return;
    }
    let text = newest["text"].as_str().unwrap_or_default().to_string();
    let hash = clipboard::sync::hash_text(&text);
    {
        let mut last = state.last_clipboard_hash.lock().unwrap();
        if *last == hash {
            return;
        }
        *last = hash;
    }
    let _ = app.clipboard().write_text(text);
}

// ---------------- System / chat / misc ----------------
#[tauri::command]
async fn get_system_metrics(state: State<'_, AppState>) -> Result<SystemMetrics, String> {
    let cfg = state.db.get_config().unwrap_or_default();
    let mut monitor = state.sys_monitor.lock().await;
    Ok(monitor.collect_metrics(&cfg.server_url).await)
}

#[tauri::command]
fn get_chat_sessions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    state.db.get_chat_sessions().map_err(e2s)
}
#[tauri::command]
fn get_chat_history(session_id: String, state: State<'_, AppState>) -> Result<Vec<ChatMessageRecord>, String> {
    state.db.get_chat_history(&session_id).map_err(e2s)
}
#[tauri::command]
fn save_chat_message(mut msg: ChatMessageRecord, state: State<'_, AppState>) -> Result<(), String> {
    if msg.id.is_empty() {
        msg.id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    }
    if msg.timestamp == 0 {
        msg.timestamp = now_ms();
    }
    state.db.add_chat_message(&msg).map_err(e2s)
}
#[tauri::command]
fn delete_chat_session(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.db.delete_chat_session(&session_id).map_err(e2s)
}

#[tauri::command]
fn restart_app(app: AppHandle) {
    app.restart();
}

#[tauri::command]
fn app_version() -> String {
    APP_VERSION.to_string()
}

// ---------------- Background services ----------------
fn spawn_sync_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        let notify = app.state::<AppState>().sync_notify.clone();
        loop {
            let minutes = app.state::<AppState>().db.get_config().map(|c| c.auto_sync_minutes).unwrap_or(5);
            if minutes > 0 {
                let _ = run_sync(&app).await;
            }
            let wait = if minutes > 0 { minutes as u64 * 60 } else { 3600 };
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(wait)) => {},
                _ = notify.notified() => {
                    // Debounce bursts of local edits.
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                }
            }
        }
    });
}

fn spawn_reminder_loop(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let notify = app.state::<AppState>().reminder_notify.clone();
        loop {
            let db = app.state::<AppState>().db.clone();
            let fired = reminders::process_due(&db, now_ms());
            for f in &fired {
                let title = if f.missed { "Cahangir — qaçırılmış xatırlatma" } else { "Cahangir — xatırlatma" };
                let _ = app.notification().builder().title(title).body(&f.text).show();
                let _ = app.emit("reminder://fired", f);
            }
            if !fired.is_empty() {
                app.state::<AppState>().sync_notify.notify_one();
                let _ = app.emit("data://changed", json!({"entities": ["reminders"]}));
            }
            let next = reminders::ms_until_next(&db, now_ms()).unwrap_or(60_000);
            // Wake at the next due time (at most every 30 s to handle clock/timezone changes).
            let wait = next.clamp(250, 30_000) as u64;
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(wait)) => {},
                _ = notify.notified() => {},
            }
        }
    });
}

fn spawn_clipboard_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut was_enabled = false;
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
            let state = app.state::<AppState>();
            let cfg = match state.db.get_config() {
                Ok(c) => c,
                Err(_) => continue,
            };
            if !cfg.clipboard_auto_share {
                was_enabled = false;
                continue;
            }
            let text = match app.clipboard().read_text() {
                Ok(t) => t,
                Err(_) => continue,
            };
            let hash = clipboard::sync::hash_text(&text);
            if !was_enabled {
                // Do not share what was already on the clipboard when sharing was switched on.
                was_enabled = true;
                *state.last_clipboard_hash.lock().unwrap() = hash;
                continue;
            }
            let changed = { *state.last_clipboard_hash.lock().unwrap() != hash };
            if changed && !text.trim().is_empty() && text.len() <= 100_000 {
                let _ = share_clipboard_text(&app, text).await;
            } else if changed {
                *state.last_clipboard_hash.lock().unwrap() = hash;
            }
        }
    });
}

pub fn run() {
    let db = Database::init().expect("Failed to initialize local SQLite database");
    let cfg = db.get_config().unwrap_or_default();
    let last_clipboard_hash = Arc::new(Mutex::new(String::new()));
    let download_dir = Arc::new(Mutex::new(PathBuf::from(&cfg.download_dir)));
    let start_minimized = std::env::args().any(|a| a == "--minimized");

    let app_state = AppState {
        db: db.clone(),
        sys_monitor: Arc::new(tokio::sync::Mutex::new(SysMonitor::new())),
        cancel_flag: Arc::new(AtomicBool::new(false)),
        last_clipboard_hash: last_clipboard_hash.clone(),
        download_dir: download_dir.clone(),
        sync_notify: Arc::new(Notify::new()),
        reminder_notify: Arc::new(Notify::new()),
        sync_lock: Arc::new(tokio::sync::Mutex::new(())),
        peers: Arc::new(Mutex::new(Vec::new())),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .manage(app_state)
        .setup(move |app| {
            let handle = app.handle().clone();
            if start_minimized {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            // Keep the stored setting in line with the real OS login item.
            if let Ok(enabled) = handle.autolaunch().is_enabled() {
                if enabled != cfg.auto_start {
                    let _ = db.update_config(|c| c.auto_start = enabled);
                }
            }
            let sink_handle = handle.clone();
            let sink: p2p::server::ClipboardSink = Arc::new(move |t: &str| {
                let _ = sink_handle.clipboard().write_text(t.to_string());
            });
            let p2p_state = P2pServerState {
                db: db.clone(),
                download_dir,
                app_handle: Some(handle.clone()),
                sessions: Arc::new(tokio::sync::Mutex::new(Default::default())),
                last_clipboard_hash,
                nonces: Arc::new(Default::default()),
                clipboard_sink: Some(sink),
            };
            let port = cfg.p2p_port;
            let err_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = start_p2p_server(port, p2p_state).await {
                    eprintln!("[P2P] Server failed to start: {}", e);
                    let _ = err_handle.emit("p2p://server-error", json!({"error": e.to_string(), "port": port}));
                }
            });
            spawn_sync_loop(handle.clone());
            spawn_reminder_loop(handle.clone());
            spawn_clipboard_watcher(handle.clone());

            let quit_i = MenuItem::with_id(app, "quit", "Çıxış", true, None::<&str>)?;
            let sync_i = MenuItem::with_id(app, "sync", "İndi sinxron et", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Pəncərəni aç", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &sync_i, &quit_i])?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Cahangir")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "sync" => {
                        let h = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = run_sync(&h).await;
                        });
                    }
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        if let Some(win) = tray.app_handle().get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    if state.db.get_config().map(|c| c.minimize_to_tray).unwrap_or(true) {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_config,
            save_app_config,
            get_autostart_enabled,
            test_server_connection,
            register_device_api,
            unpair_device,
            list_paired_devices,
            list_devices_api,
            revoke_device_api,
            trigger_delta_sync,
            get_sync_status,
            list_conflicts,
            entity_list,
            entity_save,
            entity_save_many,
            entity_delete,
            get_memories,
            save_memory,
            delete_memory,
            get_reminders,
            save_reminder,
            complete_reminder,
            snooze_reminder,
            delete_reminder,
            get_projects,
            save_project,
            delete_project,
            get_notification_permission,
            test_notification,
            ai_providers,
            ai_chat,
            ai_parse,
            ping_peer,
            start_file_send,
            cancel_file_transfer,
            get_transfer_history,
            clear_transfer_history,
            pick_file_dialog,
            pick_folder_dialog,
            share_clipboard,
            send_clipboard_to_peer_cmd,
            copy_to_clipboard,
            set_last_clipboard_hash,
            get_system_metrics,
            get_chat_sessions,
            get_chat_history,
            save_chat_message,
            delete_chat_session,
            restart_app,
            app_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running cahangir desktop application");
}
