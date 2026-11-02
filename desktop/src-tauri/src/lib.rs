pub mod clipboard;
pub mod db;
pub mod p2p;
pub mod sysinfo;

use db::storage::{
    AppConfig, ChatMessageRecord, Database, MemoryRecord, ProjectRecord, ReminderRecord,
    TransferRecord,
};
use p2p::client::{send_clipboard_to_peer, send_file_to_peer, SendFileResult};
use p2p::server::start_p2p_server;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use sysinfo::monitor::{SysMonitor, SystemMetrics};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State,
};
use tauri_plugin_dialog::DialogExt;

pub struct AppState {
    pub db: Database,
    pub sys_monitor: Arc<tokio::sync::Mutex<SysMonitor>>,
    pub cancel_flag: Arc<AtomicBool>,
    pub last_clipboard_hash: Arc<Mutex<String>>,
}

// ---------------- 1. Config & Auth Commands ----------------
#[tauri::command]
fn get_app_config(state: State<'_, AppState>) -> Result<AppConfig, String> {
    state.db.get_config().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_app_config(cfg: AppConfig, state: State<'_, AppState>) -> Result<(), String> {
    state.db.save_config(&cfg).map_err(|e| e.to_string())
}

#[tauri::command]
async fn test_server_connection(server_url: String) -> Result<Value, String> {
    let clean_url = server_url.trim_end_matches('/');
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .get(format!("{}/api/health", clean_url))
        .send()
        .await
        .map_err(|e| format!("Server connection failed: {}", e))?;

    if res.status().is_success() {
        let json: Value = res.json().await.map_err(|e| e.to_string())?;
        Ok(json)
    } else {
        Err(format!("Server returned HTTP {}", res.status()))
    }
}

#[tauri::command]
async fn register_device_api(
    server_url: String,
    admin_token: String,
    device_id: String,
    device_name: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let clean_url = server_url.trim_end_matches('/');
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    let body = serde_json::json!({
        "admin_token": admin_token.trim(),
        "device_id": device_id.trim(),
        "device_name": device_name.trim()
    });

    let res = client
        .post(format!("{}/api/auth/register-device", clean_url))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if res.status().is_success() {
        let json: Value = res.json().await.map_err(|e| e.to_string())?;
        if let Some(token) = json.get("api_token").and_then(|t| t.as_str()) {
            let mut cfg = state.db.get_config().map_err(|e| e.to_string())?;
            cfg.server_url = clean_url.to_string();
            cfg.admin_token = admin_token;
            cfg.device_token = token.to_string();
            cfg.device_id = device_id;
            cfg.device_name = device_name;
            state.db.save_config(&cfg).map_err(|e| e.to_string())?;
        }
        Ok(json)
    } else {
        let err_text = res.text().await.unwrap_or_default();
        Err(format!("Device registration failed: {}", err_text))
    }
}

#[tauri::command]
async fn list_devices_api(server_url: String, admin_token: String) -> Result<Value, String> {
    let clean_url = server_url.trim_end_matches('/');
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("{}/api/auth/devices?admin_token={}", clean_url, admin_token.trim());
    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if res.status().is_success() {
        let json: Value = res.json().await.map_err(|e| e.to_string())?;
        Ok(json)
    } else {
        Err(format!("Error fetching devices: HTTP {}", res.status()))
    }
}

#[tauri::command]
async fn revoke_device_api(
    server_url: String,
    admin_token: String,
    target_device_id: String,
) -> Result<Value, String> {
    let clean_url = server_url.trim_end_matches('/');
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let body = serde_json::json!({
        "admin_token": admin_token.trim(),
        "device_id": target_device_id.trim()
    });

    let res = client
        .post(format!("{}/api/auth/revoke-device", clean_url))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if res.status().is_success() {
        let json: Value = res.json().await.map_err(|e| e.to_string())?;
        Ok(json)
    } else {
        Err(format!("Revocation failed: HTTP {}", res.status()))
    }
}

// ---------------- 2. Delta Synchronization ----------------
#[tauri::command]
async fn trigger_delta_sync(state: State<'_, AppState>) -> Result<Value, String> {
    let mut cfg = state.db.get_config().map_err(|e| e.to_string())?;
    if cfg.server_url.is_empty() || cfg.device_token.is_empty() {
        return Err("Server və ya cihaz açarı tənzimlənməyib (Oflayn rejim)".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let all_mem = state.db.get_memories(true).map_err(|e| e.to_string())?;
    let all_rem = state.db.get_reminders(true).map_err(|e| e.to_string())?;
    let all_prj = state.db.get_projects(true).map_err(|e| e.to_string())?;

    let pending_mem: Vec<_> = all_mem.into_iter().filter(|m| m.sync_status == 1).collect();
    let pending_rem: Vec<_> = all_rem.into_iter().filter(|r| r.sync_status == 1).collect();
    let pending_prj: Vec<_> = all_prj.into_iter().filter(|p| p.sync_status == 1).collect();

    let push_body = serde_json::json!({
        "device_id": cfg.device_id,
        "client_timestamp": cfg.last_sync_time,
        "memories": pending_mem,
        "reminders": pending_rem,
        "projects": pending_prj
    });

    let sync_url = format!("{}/api/sync", cfg.server_url.trim_end_matches('/'));
    let res = client
        .post(&sync_url)
        .header("Authorization", format!("Bearer {}", cfg.device_token))
        .json(&push_body)
        .send()
        .await
        .map_err(|e| format!("Sinxronizasiya sorğusu uğursuz oldu: {}", e))?;

    let status = res.status();
    if !status.is_success() {
        let err_body = res.text().await.unwrap_or_default();
        return Err(format!("Server xətası HTTP {}: {}", status, err_body));
    }

    let full_res: Value = res.json().await.map_err(|e| e.to_string())?;

    for mut m in pending_mem {
        m.sync_status = 0;
        let _ = state.db.upsert_memory(&m);
    }
    for mut r in pending_rem {
        r.sync_status = 0;
        let _ = state.db.upsert_reminder(&r);
    }
    for mut p in pending_prj {
        p.sync_status = 0;
        let _ = state.db.upsert_project(&p);
    }

    if let Some(delta) = full_res.get("delta") {
        if let Some(mems) = delta.get("memories").and_then(|v| v.as_array()) {
            for m_val in mems {
                if let Ok(mut m) = serde_json::from_value::<MemoryRecord>(m_val.clone()) {
                    m.sync_status = 0;
                    let _ = state.db.upsert_memory(&m);
                }
            }
        }
        if let Some(rems) = delta.get("reminders").and_then(|v| v.as_array()) {
            for r_val in rems {
                if let Ok(mut r) = serde_json::from_value::<ReminderRecord>(r_val.clone()) {
                    r.sync_status = 0;
                    let _ = state.db.upsert_reminder(&r);
                }
            }
        }
        if let Some(prjs) = delta.get("projects").and_then(|v| v.as_array()) {
            for p_val in prjs {
                if let Ok(mut p) = serde_json::from_value::<ProjectRecord>(p_val.clone()) {
                    p.sync_status = 0;
                    let _ = state.db.upsert_project(&p);
                }
            }
        }
    }

    let server_time = full_res
        .get("server_timestamp")
        .and_then(|t| t.as_i64())
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());

    cfg.last_sync_time = server_time;
    let _ = state.db.save_config(&cfg);

    Ok(full_res)
}

// ---------------- 3. Memories Commands ----------------
#[tauri::command]
fn get_memories(include_deleted: bool, state: State<'_, AppState>) -> Result<Vec<MemoryRecord>, String> {
    state.db.get_memories(include_deleted).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_memory(mut mem: MemoryRecord, state: State<'_, AppState>) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    if mem.id.is_empty() {
        mem.id = format!("mem_{}", uuid::Uuid::new_v4().simple());
        mem.created_at = now;
    }
    mem.updated_at = now;
    mem.sync_status = 1;
    state.db.upsert_memory(&mem).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_memory(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let list = state.db.get_memories(true).map_err(|e| e.to_string())?;
    if let Some(mut m) = list.into_iter().find(|item| item.id == id) {
        m.deleted = 1;
        m.updated_at = chrono::Utc::now().timestamp_millis();
        m.sync_status = 1;
        state.db.upsert_memory(&m).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------- 4. Reminders Commands ----------------
#[tauri::command]
fn get_reminders(include_deleted: bool, state: State<'_, AppState>) -> Result<Vec<ReminderRecord>, String> {
    state.db.get_reminders(include_deleted).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_reminder(mut rem: ReminderRecord, state: State<'_, AppState>) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    if rem.id.is_empty() {
        rem.id = format!("rem_{}", uuid::Uuid::new_v4().simple());
        rem.created_at = now;
    }
    rem.updated_at = now;
    rem.sync_status = 1;
    state.db.upsert_reminder(&rem).map_err(|e| e.to_string())
}

#[tauri::command]
fn complete_reminder(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let list = state.db.get_reminders(true).map_err(|e| e.to_string())?;
    if let Some(mut r) = list.into_iter().find(|item| item.id == id) {
        r.done = 1;
        r.updated_at = chrono::Utc::now().timestamp_millis();
        r.sync_status = 1;
        state.db.upsert_reminder(&r).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn snooze_reminder(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let list = state.db.get_reminders(true).map_err(|e| e.to_string())?;
    if let Some(mut r) = list.into_iter().find(|item| item.id == id) {
        let now = chrono::Utc::now().timestamp_millis();
        r.snooze = Some(now + (10 * 60 * 1000));
        r.updated_at = now;
        r.sync_status = 1;
        state.db.upsert_reminder(&r).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn delete_reminder(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let list = state.db.get_reminders(true).map_err(|e| e.to_string())?;
    if let Some(mut r) = list.into_iter().find(|item| item.id == id) {
        r.deleted = 1;
        r.updated_at = chrono::Utc::now().timestamp_millis();
        r.sync_status = 1;
        state.db.upsert_reminder(&r).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------- 5. Projects Commands ----------------
#[tauri::command]
fn get_projects(include_deleted: bool, state: State<'_, AppState>) -> Result<Vec<ProjectRecord>, String> {
    state.db.get_projects(include_deleted).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_project(mut prj: ProjectRecord, state: State<'_, AppState>) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp_millis();
    if prj.id.is_empty() {
        prj.id = format!("prj_{}", uuid::Uuid::new_v4().simple());
        prj.created_at = now;
    }
    prj.updated_at = now;
    prj.sync_status = 1;
    state.db.upsert_project(&prj).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_project(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let list = state.db.get_projects(true).map_err(|e| e.to_string())?;
    if let Some(mut p) = list.into_iter().find(|item| item.id == id) {
        p.deleted = 1;
        p.updated_at = chrono::Utc::now().timestamp_millis();
        p.sync_status = 1;
        state.db.upsert_project(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------- 6. File Transfer Commands ----------------
#[tauri::command]
async fn start_file_send(
    peer_ip: String,
    peer_port: u16,
    file_path: String,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<SendFileResult, String> {
    let cfg = state.db.get_config().unwrap_or_default();
    state.cancel_flag.store(false, Ordering::Relaxed);

    let res = send_file_to_peer(
        &peer_ip,
        peer_port,
        &file_path,
        &cfg.device_name,
        app_handle,
        state.cancel_flag.clone(),
    )
    .await;

    let record = TransferRecord {
        id: if res.transfer_id.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            res.transfer_id.clone()
        },
        filename: res.filename.clone(),
        file_size: res.file_size as i64,
        direction: "send".to_string(),
        peer_device: peer_ip,
        status: if res.success {
            "completed".to_string()
        } else {
            "failed".to_string()
        },
        speed_mbps: res.speed_mbps,
        sha256: res.sha256.clone(),
        timestamp: chrono::Utc::now().timestamp_millis(),
    };
    let _ = state.db.add_transfer(&record);

    Ok(res)
}

#[tauri::command]
fn cancel_file_transfer(state: State<'_, AppState>) -> Result<(), String> {
    state.cancel_flag.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
fn get_transfer_history(state: State<'_, AppState>) -> Result<Vec<TransferRecord>, String> {
    state.db.get_transfers().map_err(|e| e.to_string())
}

#[tauri::command]
fn add_transfer_history(record: TransferRecord, state: State<'_, AppState>) -> Result<(), String> {
    state.db.add_transfer(&record).map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_file_dialog(app_handle: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app_handle.dialog().file().pick_file(move |file_path| {
        let _ = tx.send(file_path.map(|p| p.to_string()));
    });
    rx.await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_folder_dialog(app_handle: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app_handle.dialog().file().pick_folder(move |dir_path| {
        let _ = tx.send(dir_path.map(|p| p.to_string()));
    });
    rx.await.map_err(|e| e.to_string())
}

// ---------------- 7. Clipboard Commands ----------------
#[tauri::command]
async fn send_clipboard_to_peer_cmd(
    peer_ip: String,
    peer_port: u16,
    text: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let cfg = state.db.get_config().unwrap_or_default();
    let hash = clipboard::sync::hash_text(&text);
    *state.last_clipboard_hash.lock().unwrap() = hash.clone();

    send_clipboard_to_peer(&peer_ip, peer_port, &text, &cfg.device_name, &hash).await
}

#[tauri::command]
fn set_last_clipboard_hash(hash: String, state: State<'_, AppState>) -> Result<(), String> {
    *state.last_clipboard_hash.lock().unwrap() = hash;
    Ok(())
}

// ---------------- 8. System Monitor ----------------
#[tauri::command]
async fn get_system_metrics(state: State<'_, AppState>) -> Result<SystemMetrics, String> {
    let cfg = state.db.get_config().unwrap_or_default();
    let mut monitor = state.sys_monitor.lock().await;
    let metrics = monitor.collect_metrics(&cfg.server_url).await;
    Ok(metrics)
}

// ---------------- 9. AI & Chat Commands ----------------
#[tauri::command]
fn get_chat_sessions(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    state.db.get_chat_sessions().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_chat_history(session_id: String, state: State<'_, AppState>) -> Result<Vec<ChatMessageRecord>, String> {
    state.db.get_chat_history(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_chat_message(mut msg: ChatMessageRecord, state: State<'_, AppState>) -> Result<(), String> {
    if msg.id.is_empty() {
        msg.id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    }
    if msg.timestamp == 0 {
        msg.timestamp = chrono::Utc::now().timestamp_millis();
    }
    state.db.add_chat_message(&msg).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_chat_session(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.db.delete_chat_session(&session_id).map_err(|e| e.to_string())
}

// ---------------- App Entry & Setup ----------------
pub fn run() {
    let db = Database::init().expect("Failed to initialize local SQLite database");
    let cfg = db.get_config().unwrap_or_default();
    let last_clipboard_hash = Arc::new(Mutex::new(String::new()));
    let cancel_flag = Arc::new(AtomicBool::new(false));
    let sys_monitor = Arc::new(tokio::sync::Mutex::new(SysMonitor::new()));

    let app_state = AppState {
        db: db.clone(),
        sys_monitor,
        cancel_flag,
        last_clipboard_hash: last_clipboard_hash.clone(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(app_state)
        .setup(move |app| {
            let handle = app.handle().clone();

            let p2p_port = cfg.p2p_port;
            let download_dir = PathBuf::from(&cfg.download_dir);
            let device_id = cfg.device_id.clone();
            let device_name = cfg.device_name.clone();
            let clip_hash = last_clipboard_hash.clone();

            tauri::async_runtime::spawn(async move {
                if let Err(e) = start_p2p_server(
                    p2p_port,
                    download_dir,
                    handle,
                    device_id,
                    device_name,
                    clip_hash,
                )
                .await
                {
                    eprintln!("[P2P] Server failed to start: {}", e);
                }
            });

            let quit_i = MenuItem::with_id(app, "quit", "Çıxış", true, None::<&str>)?;
            let show_i = MenuItem::with_id(app, "show", "Pəncərəni Aç", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
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
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
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
                let app = window.app_handle();
                if let Some(state) = app.try_state::<AppState>() {
                    let cfg = state.db.get_config().unwrap_or_default();
                    if cfg.minimize_to_tray {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_config,
            save_app_config,
            test_server_connection,
            register_device_api,
            list_devices_api,
            revoke_device_api,
            trigger_delta_sync,
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
            start_file_send,
            cancel_file_transfer,
            get_transfer_history,
            add_transfer_history,
            pick_file_dialog,
            pick_folder_dialog,
            send_clipboard_to_peer_cmd,
            set_last_clipboard_hash,
            get_system_metrics,
            get_chat_sessions,
            get_chat_history,
            save_chat_message,
            delete_chat_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running cahangir desktop application");
}
