//! Authenticated P2P receiver (file transfer + clipboard) listening on the LAN/Tailscale.
use crate::db::storage::{now_ms, Database, TransferRecord};
use crate::p2p::auth::{sanitize_filename, sha256_hex, AuthError, NonceCache};
use axum::{
    body::{to_bytes, Body, Bytes},
    extract::{Path, Query, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

pub const MAX_BODY: usize = 8 * 1024 * 1024;
pub const MAX_FILE: u64 = 50 * 1024 * 1024 * 1024;
const SESSION_IDLE_SECS: u64 = 600;

/// Called when clipboard text arrives from a paired device (writes the OS clipboard).
pub type ClipboardSink = Arc<dyn Fn(&str) + Send + Sync>;

#[derive(Clone)]
pub struct P2pServerState {
    pub db: Database,
    pub download_dir: Arc<Mutex<PathBuf>>,
    pub app_handle: Option<AppHandle>,
    pub sessions: Arc<tokio::sync::Mutex<HashMap<String, IncomingSession>>>,
    pub last_clipboard_hash: Arc<Mutex<String>>,
    pub nonces: Arc<NonceCache>,
    pub clipboard_sink: Option<ClipboardSink>,
}

pub struct IncomingSession {
    pub part_path: PathBuf,
    pub final_path: PathBuf,
    pub total_size: u64,
    pub received: u64,
    pub hasher: Sha256,
    pub expected_sha256: String,
    pub started: Instant,
    pub last_activity: Instant,
    pub filename: String,
    pub sender: String,
}

impl P2pServerState {
    fn emit(&self, ev: &str, payload: Value) {
        if let Some(h) = &self.app_handle {
            let _ = h.emit(ev, payload);
        }
    }
}

fn err(code: StatusCode, msg: &str) -> Response {
    (code, Json(json!({"error": msg}))).into_response()
}

async fn auth_layer(State(st): State<P2pServerState>, req: Request, next: Next) -> Response {
    let (parts, body) = req.into_parts();
    let bytes = match to_bytes(body, MAX_BODY).await {
        Ok(b) => b,
        Err(_) => return err(StatusCode::PAYLOAD_TOO_LARGE, "body too large"),
    };
    let key = st.db.get_config().map(|c| c.mesh_key).unwrap_or_default();
    let h = |n: &str| parts.headers.get(n).and_then(|v| v.to_str().ok());
    match st.nonces.verify(&key, parts.method.as_str(), parts.uri.path(), h("x-cahangir-ts"), h("x-cahangir-nonce"), h("x-cahangir-sig"), &bytes, now_ms()) {
        Ok(()) => next.run(Request::from_parts(parts, Body::from(bytes))).await,
        Err(AuthError::NotPaired) => err(StatusCode::SERVICE_UNAVAILABLE, "receiver is not paired with the Cahangir server yet"),
        Err(AuthError::Expired) => err(StatusCode::UNAUTHORIZED, "request expired (check device clocks)"),
        Err(_) => err(StatusCode::UNAUTHORIZED, "unauthenticated device"),
    }
}

pub fn router(state: P2pServerState) -> Router {
    Router::new()
        .route("/p2p/ping", get(handle_ping))
        .route("/p2p/file/prepare", post(handle_prepare))
        .route("/p2p/file/chunk/{transfer_id}", post(handle_chunk))
        .route("/p2p/file/finish/{transfer_id}", post(handle_finish))
        .route("/p2p/file/cancel/{transfer_id}", post(handle_cancel))
        .route("/p2p/clipboard", post(handle_clipboard))
        .layer(middleware::from_fn_with_state(state.clone(), auth_layer))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY))
        .with_state(state)
}

pub async fn start_p2p_server(port: u16, state: P2pServerState) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let sessions = state.sessions.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            let mut s = sessions.lock().await;
            let stale: Vec<String> = s.iter().filter(|(_, v)| v.last_activity.elapsed().as_secs() > SESSION_IDLE_SECS).map(|(k, _)| k.clone()).collect();
            for k in stale {
                if let Some(sess) = s.remove(&k) {
                    let _ = tokio::fs::remove_file(&sess.part_path).await;
                }
            }
        }
    });
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    axum::serve(listener, router(state)).await?;
    Ok(())
}

async fn handle_ping(State(st): State<P2pServerState>) -> Json<Value> {
    let cfg = st.db.get_config().unwrap_or_default();
    Json(json!({"device_id": cfg.device_id, "device_name": cfg.device_name, "status": "online", "platform": std::env::consts::OS}))
}

#[derive(Deserialize)]
struct PrepareRequest {
    filename: String,
    file_size: u64,
    #[serde(default)]
    sha256: String,
    #[serde(default)]
    sender_name: String,
}

fn unique_path(dir: &std::path::Path, name: &str) -> PathBuf {
    let mut p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{}", e)),
        _ => (name.to_string(), String::new()),
    };
    for i in 1..10000 {
        p = dir.join(format!("{} ({}){}", stem, i, ext));
        if !p.exists() {
            break;
        }
    }
    p
}

async fn handle_prepare(State(st): State<P2pServerState>, Json(req): Json<PrepareRequest>) -> Response {
    if req.file_size > MAX_FILE {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "file too large");
    }
    if !req.sha256.is_empty() && (req.sha256.len() != 64 || hex::decode(&req.sha256).is_err()) {
        return err(StatusCode::BAD_REQUEST, "invalid sha256");
    }
    let dir = st.download_dir.lock().unwrap().clone();
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        return err(StatusCode::INTERNAL_SERVER_ERROR, &format!("cannot create download folder: {}", e));
    }
    let safe = sanitize_filename(&req.filename);
    let transfer_id = uuid::Uuid::new_v4().to_string();
    let final_path = unique_path(&dir, &safe);
    let part_path = dir.join(format!(".{}.cahangir-part", transfer_id));
    if let Err(e) = tokio::fs::File::create(&part_path).await {
        return err(StatusCode::INTERNAL_SERVER_ERROR, &format!("cannot create file: {}", e));
    }
    let sender = req.sender_name.chars().take(100).collect::<String>();
    st.sessions.lock().await.insert(
        transfer_id.clone(),
        IncomingSession {
            part_path,
            final_path,
            total_size: req.file_size,
            received: 0,
            hasher: Sha256::new(),
            expected_sha256: req.sha256.to_lowercase(),
            started: Instant::now(),
            last_activity: Instant::now(),
            filename: safe.clone(),
            sender: sender.clone(),
        },
    );
    st.emit("p2p://transfer-started", json!({"transfer_id": transfer_id, "filename": safe, "file_size": req.file_size, "sender": sender, "direction": "receive"}));
    Json(json!({"transfer_id": transfer_id, "accepted": true, "filename": safe})).into_response()
}

#[derive(Deserialize)]
struct ChunkQuery {
    offset: Option<u64>,
}

async fn handle_chunk(State(st): State<P2pServerState>, Path(id): Path<String>, Query(q): Query<ChunkQuery>, bytes: Bytes) -> Response {
    let mut guard = st.sessions.lock().await;
    let s = match guard.get_mut(&id) {
        Some(s) => s,
        None => return err(StatusCode::NOT_FOUND, "transfer not found"),
    };
    let offset = q.offset.unwrap_or(s.received);
    let len = bytes.len() as u64;
    if offset + len <= s.received {
        // Duplicate of a chunk we already have (sender retried after a lost response).
        return Json(json!({"received": s.received, "duplicate": true})).into_response();
    }
    if offset != s.received {
        return (StatusCode::CONFLICT, Json(json!({"error": "unexpected offset", "received": s.received}))).into_response();
    }
    if s.received + len > s.total_size {
        return err(StatusCode::BAD_REQUEST, "more data than announced");
    }
    let mut f = match tokio::fs::OpenOptions::new().append(true).open(&s.part_path).await {
        Ok(f) => f,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };
    if let Err(e) = f.write_all(&bytes).await {
        return err(StatusCode::INSUFFICIENT_STORAGE, &format!("write failed: {}", e));
    }
    s.hasher.update(&bytes);
    s.received += len;
    s.last_activity = Instant::now();
    let elapsed = s.started.elapsed().as_secs_f64();
    let speed = if elapsed > 0.05 { s.received as f64 / 1048576.0 / elapsed } else { 0.0 };
    let percent = if s.total_size > 0 { (s.received as f64 / s.total_size as f64 * 100.0).min(100.0) } else { 100.0 };
    st.emit("p2p://transfer-progress", json!({"transfer_id": id, "received": s.received, "total": s.total_size, "percent": percent, "speed_mbps": speed, "direction": "receive"}));
    Json(json!({"received": s.received})).into_response()
}

#[derive(Deserialize, Default)]
struct FinishRequest {
    #[serde(default)]
    sha256: String,
}

async fn handle_finish(State(st): State<P2pServerState>, Path(id): Path<String>, body: Bytes) -> Response {
    let req: FinishRequest = serde_json::from_slice(&body).unwrap_or_default();
    let s = match st.sessions.lock().await.remove(&id) {
        Some(s) => s,
        None => return err(StatusCode::NOT_FOUND, "transfer not found"),
    };
    let actual = hex::encode(s.hasher.clone().finalize());
    let expected = if !req.sha256.is_empty() { req.sha256.to_lowercase() } else { s.expected_sha256.clone() };
    let fail = |status: &str| TransferRecord {
        id: id.clone(),
        filename: s.filename.clone(),
        file_size: s.received as i64,
        direction: "receive".into(),
        peer_device: s.sender.clone(),
        status: status.into(),
        speed_mbps: 0.0,
        sha256: actual.clone(),
        timestamp: now_ms(),
    };
    if s.received != s.total_size {
        let _ = tokio::fs::remove_file(&s.part_path).await;
        let _ = st.db.add_transfer(&fail("failed"));
        st.emit("p2p://transfer-failed", json!({"transfer_id": id, "error": "incomplete file", "direction": "receive"}));
        return err(StatusCode::CONFLICT, "incomplete file");
    }
    if expected.is_empty() || expected != actual {
        let _ = tokio::fs::remove_file(&s.part_path).await;
        let _ = st.db.add_transfer(&fail("failed"));
        st.emit("p2p://transfer-failed", json!({"transfer_id": id, "error": "SHA-256 mismatch", "direction": "receive"}));
        return (StatusCode::CONFLICT, Json(json!({"error": "sha256 mismatch", "sha256": actual}))).into_response();
    }
    let final_path = if s.final_path.exists() { unique_path(s.final_path.parent().unwrap_or(std::path::Path::new(".")), &s.filename) } else { s.final_path.clone() };
    if let Err(e) = tokio::fs::rename(&s.part_path, &final_path).await {
        let _ = tokio::fs::remove_file(&s.part_path).await;
        return err(StatusCode::INTERNAL_SERVER_ERROR, &format!("could not save file: {}", e));
    }
    let elapsed = s.started.elapsed().as_secs_f64();
    let speed = if elapsed > 0.0 { s.received as f64 / 1048576.0 / elapsed } else { 0.0 };
    let rec = TransferRecord {
        id: id.clone(),
        filename: final_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        file_size: s.received as i64,
        direction: "receive".into(),
        peer_device: s.sender.clone(),
        status: "completed".into(),
        speed_mbps: speed,
        sha256: actual.clone(),
        timestamp: now_ms(),
    };
    let _ = st.db.add_transfer(&rec);
    st.emit("p2p://transfer-complete", json!({"transfer_id": id, "filename": rec.filename, "file_size": s.received, "speed_mbps": speed, "sha256": actual, "file_path": final_path.to_string_lossy(), "direction": "receive", "verified": true}));
    Json(json!({"success": true, "received_size": s.received, "sha256": actual, "verified": true})).into_response()
}

async fn handle_cancel(State(st): State<P2pServerState>, Path(id): Path<String>) -> Response {
    if let Some(s) = st.sessions.lock().await.remove(&id) {
        let _ = tokio::fs::remove_file(&s.part_path).await;
        let _ = st.db.add_transfer(&TransferRecord {
            id: id.clone(),
            filename: s.filename.clone(),
            file_size: s.received as i64,
            direction: "receive".into(),
            peer_device: s.sender.clone(),
            status: "canceled".into(),
            speed_mbps: 0.0,
            sha256: String::new(),
            timestamp: now_ms(),
        });
        st.emit("p2p://transfer-failed", json!({"transfer_id": id, "error": "canceled by sender", "direction": "receive"}));
    }
    Json(json!({"success": true})).into_response()
}

#[derive(Deserialize)]
struct ClipboardPayload {
    text: String,
    #[serde(default)]
    origin_device: String,
    #[serde(default)]
    hash: String,
    #[serde(default)]
    id: String,
}

async fn handle_clipboard(State(st): State<P2pServerState>, Json(p): Json<ClipboardPayload>) -> Response {
    if p.text.len() > 100_000 {
        return err(StatusCode::PAYLOAD_TOO_LARGE, "clipboard text too large");
    }
    let hash = sha256_hex(p.text.as_bytes());
    if !p.hash.is_empty() && p.hash != hash {
        return err(StatusCode::BAD_REQUEST, "hash mismatch");
    }
    let cfg = st.db.get_config().unwrap_or_default();
    {
        let mut last = st.last_clipboard_hash.lock().unwrap();
        if *last == hash {
            return Json(json!({"skipped": true, "reason": "duplicate"})).into_response();
        }
        *last = hash.clone();
    }
    // Store with the sender's id so the copy arriving later via the server is not duplicated.
    if !p.id.is_empty() && p.id.len() <= 100 {
        let now = now_ms();
        let _ = st.db.apply_remote("clipboard_items", &json!({"id": p.id, "text": p.text, "hash": hash, "origin_name": p.origin_device,
            "created_at": now, "updated_at": now, "deleted": 0, "server_rev": 0}), false);
    }
    let applied = cfg.clipboard_sync_enabled;
    if applied {
        if let Some(sink) = &st.clipboard_sink {
            sink(&p.text);
        }
    }
    st.emit("p2p://clipboard-received", json!({"text": p.text, "origin_device": p.origin_device, "hash": hash, "applied": applied}));
    Json(json!({"success": true, "applied": applied})).into_response()
}
