//! Background/delta synchronization with the Debian server (protocol v2).
use crate::db::storage::{json_i64, now_ms, Database, ENTITIES};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Default)]
pub struct SyncReport {
    pub pushed: usize,
    pub applied_remote: usize,
    pub conflicts: Vec<Value>,
    pub rejected: Vec<Value>,
    pub server_rev: i64,
    pub server_timestamp: i64,
    /// Clipboard items received from other devices in this sync (newest last).
    pub incoming_clipboard: Vec<Value>,
    pub changed_entities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct P2pInfo {
    pub hosts: Vec<String>,
    pub port: u16,
    pub platform: String,
    pub app_version: String,
}

pub fn local_ipv4s() -> Vec<String> {
    let nets = sysinfo::Networks::new_with_refreshed_list();
    let mut ts = Vec::new();
    let mut lan = Vec::new();
    for (_, data) in &nets {
        for ip in data.ip_networks() {
            if let std::net::IpAddr::V4(v4) = ip.addr {
                if v4.is_loopback() || v4.is_link_local() || v4.is_unspecified() {
                    continue;
                }
                let s = v4.to_string();
                if s.starts_with("100.") {
                    ts.push(s)
                } else if v4.is_private() {
                    lan.push(s)
                }
            }
        }
    }
    ts.sort();
    ts.dedup();
    lan.sort();
    lan.dedup();
    ts.into_iter().chain(lan).take(8).collect()
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())
}

fn http_error(status: reqwest::StatusCode, body: &str) -> String {
    match status.as_u16() {
        401 => "Bu cihaz serverdə tanınmır — yenidən cütləşdirin (pair).".to_string(),
        403 => "Bu cihazın girişi ləğv edilib (revoked).".to_string(),
        429 => "Server çox sorğu aldı, bir az sonra yenidən cəhd ediləcək.".to_string(),
        _ => format!("Server xətası HTTP {}: {}", status, body.chars().take(200).collect::<String>()),
    }
}

/// One full synchronization: pushes pending local changes, pulls remote changes (paging
/// until up to date), stores the new cursor and refreshes the P2P mesh key.
pub async fn sync_once(db: &Database, p2p: Option<P2pInfo>) -> Result<SyncReport, String> {
    let cfg = db.get_config().map_err(|e| e.to_string())?;
    if cfg.server_url.trim().is_empty() || cfg.device_token.is_empty() {
        return Err("Server qoşulmayıb (oflayn rejim).".into());
    }
    let base = cfg.server_url.trim_end_matches('/').to_string();
    let http = client()?;
    let mut report = SyncReport::default();
    let mut since = cfg.last_server_rev;
    let mut first = true;
    let mut changed: HashSet<String> = HashSet::new();

    loop {
        // Collect pending rows (only on the first page; later pages are pull-only).
        let mut body = json!({"device_id": cfg.device_id, "since_rev": since, "client_timestamp": cfg.last_sync_time});
        let mut pushed: Vec<(String, String, i64)> = Vec::new();
        if first {
            for e in ENTITIES {
                let rows = db.pending(e.name).map_err(|e| e.to_string())?;
                let mut out = Vec::new();
                for mut r in rows {
                    let rev = r.get("server_rev").and_then(json_i64).unwrap_or(0);
                    if let Value::Object(m) = &mut r {
                        m.remove("sync_status");
                        m.remove("fired_at");
                        m.remove("server_rev");
                        m.insert("base_rev".into(), if rev > 0 { Value::from(rev) } else { Value::Null });
                    }
                    pushed.push((e.name.to_string(), r["id"].as_str().unwrap_or_default().to_string(), r["updated_at"].as_i64().unwrap_or(0)));
                    out.push(r);
                }
                body[e.name] = Value::Array(out);
            }
            if let Some(info) = &p2p {
                body["p2p"] = serde_json::to_value(info).unwrap_or(Value::Null);
            }
        }
        let resp = http
            .post(format!("{}/api/sync", base))
            .bearer_auth(&cfg.device_token)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Serverə qoşulmaq mümkün olmadı: {}", e))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(http_error(status, &text));
        }
        let res: Value = serde_json::from_str(&text).map_err(|e| format!("Server cavabı oxunmadı: {}", e))?;
        if res.get("protocol").and_then(|v| v.as_i64()).unwrap_or(1) < 2 {
            return Err("Server köhnə versiyadır (v2 sinxronizasiya protokolu tələb olunur). Debian backend-i yeniləyin.".into());
        }

        // 1. Acknowledge pushed rows.
        let acks = &res["acks"];
        for (entity, id, upd) in &pushed {
            if let Some(rev) = acks[entity.as_str()][id.as_str()].as_i64() {
                db.ack(entity, id, rev, *upd).map_err(|e| e.to_string())?;
                report.pushed += 1;
            }
        }
        // 2. Conflicts where the server kept its version: overwrite local copy.
        let mut server_won: HashSet<(String, String)> = HashSet::new();
        if let Some(cs) = res["conflicts"].as_array() {
            for c in cs {
                if c["winner"] == "server" {
                    server_won.insert((c["entity"].as_str().unwrap_or_default().into(), c["id"].as_str().unwrap_or_default().into()));
                }
                report.conflicts.push(c.clone());
            }
        }
        if let Some(rj) = res["rejected"].as_array() {
            report.rejected.extend(rj.iter().cloned());
        }
        // 3. Apply remote delta.
        let delta = &res["delta"];
        for e in ENTITIES {
            if let Some(rows) = delta[e.name].as_array() {
                for row in rows {
                    let id = row["id"].as_str().unwrap_or_default().to_string();
                    let force = server_won.contains(&(e.name.to_string(), id));
                    if db.apply_remote(e.name, row, force).map_err(|e| e.to_string())? {
                        report.applied_remote += 1;
                        changed.insert(e.name.to_string());
                        if e.name == "clipboard_items" && row["origin_device"].as_str() != Some(cfg.device_id.as_str()) && row["deleted"] != 1 {
                            report.incoming_clipboard.push(row.clone());
                        }
                    }
                }
            }
        }
        since = res["server_rev"].as_i64().unwrap_or(since);
        report.server_rev = since;
        report.server_timestamp = res["server_timestamp"].as_i64().unwrap_or_else(now_ms);
        db.update_config(|c| {
            c.last_server_rev = since;
            c.last_sync_time = report.server_timestamp;
        })
        .map_err(|e| e.to_string())?;
        first = false;
        if !res["has_more"].as_bool().unwrap_or(false) {
            break;
        }
    }

    // Refresh the shared P2P key (rotated by the server when a device is revoked).
    if let Ok(r) = http.get(format!("{}/api/p2p/credentials", base)).bearer_auth(&cfg.device_token).send().await {
        if r.status().is_success() {
            if let Ok(v) = r.json::<Value>().await {
                if let (Some(k), Some(id)) = (v["mesh_key"].as_str(), v["key_id"].as_i64()) {
                    let _ = db.update_config(|c| {
                        c.mesh_key = k.to_string();
                        c.mesh_key_id = id;
                    });
                }
            }
        }
    }
    report.incoming_clipboard.sort_by_key(|r| r["created_at"].as_i64().unwrap_or(0));
    report.changed_entities = changed.into_iter().collect();
    Ok(report)
}

/// Authenticated GET against the Debian server with the device token.
pub async fn server_get(db: &Database, path: &str) -> Result<Value, String> {
    let cfg = db.get_config().map_err(|e| e.to_string())?;
    if cfg.server_url.is_empty() || cfg.device_token.is_empty() {
        return Err("Server qoşulmayıb.".into());
    }
    let r = client()?
        .get(format!("{}{}", cfg.server_url.trim_end_matches('/'), path))
        .bearer_auth(&cfg.device_token)
        .send()
        .await
        .map_err(|e| format!("Serverə qoşulmaq mümkün olmadı: {}", e))?;
    let status = r.status();
    let text = r.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(http_error(status, &text));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Authenticated POST; returns (status, json body) so callers can handle 503 (AI unavailable).
pub async fn server_post(db: &Database, path: &str, body: &Value, timeout_s: u64) -> Result<(u16, Value), String> {
    let cfg = db.get_config().map_err(|e| e.to_string())?;
    if cfg.server_url.is_empty() || cfg.device_token.is_empty() {
        return Err("Server qoşulmayıb.".into());
    }
    let r = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_s))
        .build()
        .map_err(|e| e.to_string())?
        .post(format!("{}{}", cfg.server_url.trim_end_matches('/'), path))
        .bearer_auth(&cfg.device_token)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Serverə qoşulmaq mümkün olmadı: {}", e))?;
    let status = r.status().as_u16();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    Ok((status, v))
}
