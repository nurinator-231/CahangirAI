use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::fs::File;
use tokio::io::AsyncReadExt;

#[derive(Serialize, Deserialize)]
pub struct SendFileResult {
    pub success: bool,
    pub transfer_id: String,
    pub filename: String,
    pub file_size: u64,
    pub speed_mbps: f64,
    pub sha256: String,
    pub error: Option<String>,
}

pub async fn send_file_to_peer(
    peer_ip: &str,
    peer_port: u16,
    file_path_str: &str,
    sender_name: &str,
    app_handle: AppHandle,
    cancel_flag: Arc<AtomicBool>,
) -> SendFileResult {
    let path = Path::new(file_path_str);
    let filename = match path.file_name() {
        Some(f) => f.to_string_lossy().to_string(),
        None => {
            return SendFileResult {
                success: false,
                transfer_id: "".to_string(),
                filename: "".to_string(),
                file_size: 0,
                speed_mbps: 0.0,
                sha256: "".to_string(),
                error: Some("Invalid file path".to_string()),
            }
        }
    };

    let mut file = match File::open(path).await {
        Ok(f) => f,
        Err(e) => {
            return SendFileResult {
                success: false,
                transfer_id: "".to_string(),
                filename,
                file_size: 0,
                speed_mbps: 0.0,
                sha256: "".to_string(),
                error: Some(format!("Failed to open file: {}", e)),
            }
        }
    };

    let metadata = match file.metadata().await {
        Ok(m) => m,
        Err(e) => {
            return SendFileResult {
                success: false,
                transfer_id: "".to_string(),
                filename,
                file_size: 0,
                speed_mbps: 0.0,
                sha256: "".to_string(),
                error: Some(format!("Failed to read metadata: {}", e)),
            }
        }
    };

    let file_size = metadata.len();
    let base_url = format!("http://{}:{}", peer_ip, peer_port);
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default();

    // 1. Prepare handshake
    let prepare_url = format!("{}/p2p/file/prepare", base_url);
    let prep_body = serde_json::json!({
        "filename": filename,
        "file_size": file_size,
        "sha256": "",
        "sender_name": sender_name
    });

    let resp = match client.post(&prepare_url).json(&prep_body).send().await {
        Ok(r) => r,
        Err(e) => {
            return SendFileResult {
                success: false,
                transfer_id: "".to_string(),
                filename,
                file_size,
                speed_mbps: 0.0,
                sha256: "".to_string(),
                error: Some(format!("Cannot connect to peer {}: {}", base_url, e)),
            }
        }
    };

    if !resp.status().is_success() {
        return SendFileResult {
            success: false,
            transfer_id: "".to_string(),
            filename,
            file_size,
            speed_mbps: 0.0,
            sha256: "".to_string(),
            error: Some(format!("Peer rejected transfer: HTTP {}", resp.status())),
        };
    }

    let prep_res: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => {
            return SendFileResult {
                success: false,
                transfer_id: "".to_string(),
                filename,
                file_size,
                speed_mbps: 0.0,
                sha256: "".to_string(),
                error: Some("Invalid response from peer".to_string()),
            }
        }
    };

    let transfer_id = match prep_res.get("transfer_id").and_then(|t| t.as_str()) {
        Some(t) => t.to_string(),
        None => {
            return SendFileResult {
                success: false,
                transfer_id: "".to_string(),
                filename,
                file_size,
                speed_mbps: 0.0,
                sha256: "".to_string(),
                error: Some("Missing transfer_id in peer response".to_string()),
            }
        }
    };

    let _ = app_handle.emit(
        "p2p://transfer-started",
        serde_json::json!({
            "transfer_id": transfer_id,
            "filename": filename,
            "file_size": file_size,
            "peer": peer_ip,
            "direction": "send"
        }),
    );

    // 2. Stream 1MB chunks
    let chunk_size: usize = 1024 * 1024; // 1 MB buffer
    let mut buffer = vec![0u8; chunk_size];
    let mut total_sent: u64 = 0;
    let mut hasher = Sha256::new();
    let start_time = Instant::now();

    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            return SendFileResult {
                success: false,
                transfer_id,
                filename,
                file_size,
                speed_mbps: 0.0,
                sha256: "".to_string(),
                error: Some("Transfer canceled by user".to_string()),
            };
        }

        let bytes_read = match file.read(&mut buffer).await {
            Ok(0) => break, // EOF
            Ok(n) => n,
            Err(e) => {
                return SendFileResult {
                    success: false,
                    transfer_id,
                    filename,
                    file_size,
                    speed_mbps: 0.0,
                    sha256: "".to_string(),
                    error: Some(format!("Error reading local file: {}", e)),
                }
            }
        };

        let chunk_data = &buffer[..bytes_read];
        hasher.update(chunk_data);

        let chunk_url = format!("{}/p2p/file/chunk/{}", base_url, transfer_id);
        let send_res = client
            .post(&chunk_url)
            .body(chunk_data.to_vec())
            .send()
            .await;

        if let Err(e) = send_res {
            return SendFileResult {
                success: false,
                transfer_id,
                filename,
                file_size,
                speed_mbps: 0.0,
                sha256: "".to_string(),
                error: Some(format!("Failed sending chunk to peer: {}", e)),
            };
        }

        total_sent += bytes_read as u64;
        let elapsed = start_time.elapsed().as_secs_f64();
        let speed_mbps = if elapsed > 0.05 {
            (total_sent as f64 / (1024.0 * 1024.0)) / elapsed
        } else {
            0.0
        };

        let percent = if file_size > 0 {
            ((total_sent as f64 / file_size as f64) * 100.0).min(100.0)
        } else {
            100.0
        };

        let _ = app_handle.emit(
            "p2p://transfer-progress",
            serde_json::json!({
                "transfer_id": transfer_id,
                "sent": total_sent,
                "total": file_size,
                "percent": percent,
                "speed_mbps": speed_mbps,
                "direction": "send"
            }),
        );
    }

    // 3. Finish handshake
    let calculated_hash = hex::encode(hasher.finalize());
    let finish_url = format!("{}/p2p/file/finish/{}", base_url, transfer_id);
    let finish_res = client.post(&finish_url).send().await;

    let elapsed = start_time.elapsed().as_secs_f64();
    let speed_mbps = if elapsed > 0.0 {
        (total_sent as f64 / (1024.0 * 1024.0)) / elapsed
    } else {
        0.0
    };

    if let Err(e) = finish_res {
        return SendFileResult {
            success: false,
            transfer_id,
            filename,
            file_size: total_sent,
            speed_mbps,
            sha256: calculated_hash,
            error: Some(format!("Failed to finalize transfer: {}", e)),
        };
    }

    let _ = app_handle.emit(
        "p2p://transfer-complete",
        serde_json::json!({
            "transfer_id": transfer_id,
            "filename": filename,
            "file_size": total_sent,
            "speed_mbps": speed_mbps,
            "sha256": calculated_hash,
            "direction": "send"
        }),
    );

    SendFileResult {
        success: true,
        transfer_id,
        filename,
        file_size: total_sent,
        speed_mbps,
        sha256: calculated_hash,
        error: None,
    }
}

pub async fn send_clipboard_to_peer(
    peer_ip: &str,
    peer_port: u16,
    text: &str,
    origin_device: &str,
    hash: &str,
) -> Result<(), String> {
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!("http://{}:{}/p2p/clipboard", peer_ip, peer_port);
    let body = serde_json::json!({
        "text": text,
        "origin_device": origin_device,
        "hash": hash
    });

    client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Clipboard push failed: {}", e))?;

    Ok(())
}
