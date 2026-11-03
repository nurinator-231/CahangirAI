use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;
use tower_http::cors::CorsLayer;

#[derive(Clone)]
pub struct P2pServerState {
    pub download_dir: Arc<std::sync::Mutex<PathBuf>>,
    pub app_handle: AppHandle,
    pub incoming_transfers: Arc<tokio::sync::Mutex<HashMap<String, IncomingSession>>>,
    pub last_clipboard_hash: Arc<std::sync::Mutex<String>>,
    pub device_id: String,
    pub device_name: String,
}

pub struct IncomingSession {
    pub file_path: PathBuf,
    pub total_size: u64,
    pub received_size: u64,
    pub hasher: Sha256,
    pub start_time: Instant,
    pub filename: String,
    pub sender_name: String,
}

#[derive(Serialize, Deserialize)]
pub struct PingResponse {
    pub device_id: String,
    pub device_name: String,
    pub status: String,
}

#[derive(Serialize, Deserialize)]
pub struct PrepareRequest {
    pub filename: String,
    pub file_size: u64,
    pub sha256: String,
    pub sender_name: String,
}

#[derive(Serialize, Deserialize)]
pub struct PrepareResponse {
    pub transfer_id: String,
    pub accepted: bool,
    pub message: String,
}

#[derive(Serialize, Deserialize)]
pub struct ClipboardPayload {
    pub text: String,
    pub origin_device: String,
    pub hash: String,
}

pub async fn start_p2p_server(
    port: u16,
    download_dir: PathBuf,
    app_handle: AppHandle,
    device_id: String,
    device_name: String,
    last_clipboard_hash: Arc<Mutex<String>>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let state = P2pServerState {
        download_dir: Arc::new(std::sync::Mutex::new(download_dir)),
        app_handle,
        incoming_transfers: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        last_clipboard_hash,
        device_id,
        device_name,
    };

    let app = Router::new()
        .route("/p2p/ping", get(handle_ping))
        .route("/p2p/file/prepare", post(handle_prepare))
        .route("/p2p/file/chunk/:transfer_id", post(handle_chunk))
        .route("/p2p/file/finish/:transfer_id", post(handle_finish))
        .route("/p2p/clipboard", post(handle_clipboard))
        .layer(CorsLayer::permissive())
        .layer(DefaultBodyLimit::max(50 * 1024 * 1024))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
    println!("[P2P] Server listening on 0.0.0.0:{}", port);

    axum::serve(listener, app).await?;
    Ok(())
}

async fn handle_ping(State(state): State<P2pServerState>) -> Json<PingResponse> {
    Json(PingResponse {
        device_id: state.device_id,
        device_name: state.device_name,
        status: "online".to_string(),
    })
}

async fn handle_prepare(
    State(state): State<P2pServerState>,
    Json(payload): Json<PrepareRequest>,
) -> (StatusCode, Json<PrepareResponse>) {
    let transfer_id = uuid::Uuid::new_v4().to_string();

    let target_dir = state.download_dir.lock().unwrap().clone();
    let safe_filename = payload.filename.replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], "_");
    let mut file_path = target_dir.join(&safe_filename);

    if file_path.exists() {
        let stem = file_path.file_stem().unwrap_or_default().to_string_lossy();
        let ext = file_path.extension().unwrap_or_default().to_string_lossy();
        let new_name = if ext.is_empty() {
            format!("{}_{}", stem, chrono::Local::now().format("%Y%m%d_%H%M%S"))
        } else {
            format!("{}_{}.{}", stem, chrono::Local::now().format("%Y%m%d_%H%M%S"), ext)
        };
        file_path = target_dir.join(new_name);
    }

    if let Err(e) = tokio::fs::File::create(&file_path).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(PrepareResponse {
                transfer_id: "".to_string(),
                accepted: false,
                message: format!("Could not create file: {}", e),
            }),
        );
    }

    let session = IncomingSession {
        file_path,
        total_size: payload.file_size,
        received_size: 0,
        hasher: Sha256::new(),
        start_time: Instant::now(),
        filename: payload.filename.clone(),
        sender_name: payload.sender_name.clone(),
    };

    state
        .incoming_transfers
        .lock()
        .await
        .insert(transfer_id.clone(), session);

    let _ = state.app_handle.emit(
        "p2p://transfer-started",
        serde_json::json!({
            "transfer_id": transfer_id,
            "filename": payload.filename,
            "file_size": payload.file_size,
            "sender": payload.sender_name,
            "direction": "receive"
        }),
    );

    (
        StatusCode::OK,
        Json(PrepareResponse {
            transfer_id,
            accepted: true,
            message: "Ready to receive chunks".to_string(),
        }),
    )
}

async fn handle_chunk(
    State(state): State<P2pServerState>,
    Path(transfer_id): Path<String>,
    bytes: axum::body::Bytes,
) -> &'static str {
    let mut session_guard = state.incoming_transfers.lock().await;
    let session = match session_guard.get_mut(&transfer_id) {
        Some(s) => s,
        None => return "not_found",
    };

    let mut file = match OpenOptions::new()
        .create(true)
        .append(true)
        .open(&session.file_path)
        .await
    {
        Ok(f) => f,
        Err(_) => return "io_error",
    };

    session.hasher.update(&bytes);
    session.received_size += bytes.len() as u64;

    if file.write_all(&bytes).await.is_err() {
        return "write_error";
    }

    let elapsed = session.start_time.elapsed().as_secs_f64();
    let speed_mbps = if elapsed > 0.05 {
        (session.received_size as f64 / (1024.0 * 1024.0)) / elapsed
    } else {
        0.0
    };

    let percent = if session.total_size > 0 {
        ((session.received_size as f64 / session.total_size as f64) * 100.0).min(100.0)
    } else {
        100.0
    };

    let _ = state.app_handle.emit(
        "p2p://transfer-progress",
        serde_json::json!({
            "transfer_id": transfer_id,
            "received": session.received_size,
            "total": session.total_size,
            "percent": percent,
            "speed_mbps": speed_mbps,
            "direction": "receive"
        }),
    );

    "ok"
}

async fn handle_finish(
    State(state): State<P2pServerState>,
    Path(transfer_id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let mut session_guard = state.incoming_transfers.lock().await;
    let session = match session_guard.remove(&transfer_id) {
        Some(s) => s,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({ "error": "Transfer not found" })),
            )
        }
    };

    let calculated_hash = hex::encode(session.hasher.finalize());
    let elapsed = session.start_time.elapsed().as_secs_f64();
    let speed_mbps = if elapsed > 0.0 {
        (session.received_size as f64 / (1024.0 * 1024.0)) / elapsed
    } else {
        0.0
    };

    let _ = state.app_handle.emit(
        "p2p://transfer-complete",
        serde_json::json!({
            "transfer_id": transfer_id,
            "filename": session.filename,
            "file_size": session.received_size,
            "speed_mbps": speed_mbps,
            "sha256": calculated_hash,
            "file_path": session.file_path.to_string_lossy(),
            "direction": "receive"
        }),
    );

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "success": true,
            "received_size": session.received_size,
            "sha256": calculated_hash
        })),
    )
}

async fn handle_clipboard(
    State(state): State<P2pServerState>,
    Json(payload): Json<ClipboardPayload>,
) -> (StatusCode, Json<serde_json::Value>) {
    let mut last_hash = state.last_clipboard_hash.lock().unwrap();
    if *last_hash == payload.hash {
        return (
            StatusCode::OK,
            Json(serde_json::json!({ "skipped": true, "reason": "Echo loop prevented" })),
        );
    }

    *last_hash = payload.hash.clone();

    let _ = state.app_handle.emit(
        "p2p://clipboard-received",
        serde_json::json!({
            "text": payload.text,
            "origin_device": payload.origin_device,
            "hash": payload.hash
        }),
    );

    (
        StatusCode::OK,
        Json(serde_json::json!({ "success": true, "message": "Clipboard updated" })),
    )
}
