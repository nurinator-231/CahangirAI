//! Authenticated P2P sender (files + clipboard).
use crate::p2p::auth::{new_nonce, sha256_hex, signature};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::fs::File;
use tokio::io::AsyncReadExt;

pub const CHUNK: usize = 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SendFileResult {
    pub success: bool,
    pub transfer_id: String,
    pub filename: String,
    pub file_size: u64,
    pub speed_mbps: f64,
    pub sha256: String,
    pub verified: bool,
    pub canceled: bool,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct PeerAuth {
    pub mesh_key: String,
    pub device_id: String,
}

pub async fn signed_request(client: &Client, auth: &PeerAuth, method: Method, base: &str, path_and_query: &str, body: Vec<u8>, content_type: &str) -> Result<reqwest::Response, String> {
    if auth.mesh_key.is_empty() {
        return Err("Bu cihaz hələ serverlə sinxronlaşmayıb — P2P açarı yoxdur. Əvvəlcə serverə qoşulun və sinxron edin.".into());
    }
    let path = path_and_query.split('?').next().unwrap_or(path_and_query);
    let ts = chrono::Utc::now().timestamp_millis();
    let nonce = new_nonce();
    let sig = signature(&auth.mesh_key, method.as_str(), path, ts, &nonce, &body).ok_or("invalid mesh key")?;
    client
        .request(method, format!("{}{}", base, path_and_query))
        .header("X-Cahangir-Device", &auth.device_id)
        .header("X-Cahangir-Ts", ts.to_string())
        .header("X-Cahangir-Nonce", nonce)
        .header("X-Cahangir-Sig", sig)
        .header("Content-Type", content_type)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Cihaza qoşulmaq olmadı ({}): {}", base, e))
}

fn peer_base(host: &str, port: u16) -> String {
    let h = host.trim();
    if h.contains(':') && !h.starts_with('[') {
        format!("http://[{}]:{}", h, port)
    } else {
        format!("http://{}:{}", h, port)
    }
}

async fn json_or_err(r: reqwest::Response) -> Result<Value, String> {
    let status = r.status();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        Ok(v)
    } else if status.as_u16() == 401 {
        Err("Qarşı cihaz bu sorğunu təsdiqləmədi (açarlar fərqlidir — hər iki cihazı sinxron edin).".into())
    } else {
        Err(format!("HTTP {}: {}", status, v.get("error").and_then(|e| e.as_str()).unwrap_or("")))
    }
}

pub async fn ping_peer(host: &str, port: u16, auth: &PeerAuth) -> Result<Value, String> {
    let c = Client::builder().timeout(std::time::Duration::from_secs(4)).build().map_err(|e| e.to_string())?;
    let r = signed_request(&c, auth, Method::GET, &peer_base(host, port), "/p2p/ping", vec![], "application/json").await?;
    json_or_err(r).await
}

pub async fn send_clipboard(host: &str, port: u16, auth: &PeerAuth, id: &str, text: &str, origin: &str) -> Result<Value, String> {
    let c = Client::builder().timeout(std::time::Duration::from_secs(6)).build().map_err(|e| e.to_string())?;
    let body = serde_json::to_vec(&json!({"id": id, "text": text, "origin_device": origin, "hash": sha256_hex(text.as_bytes())})).unwrap();
    let r = signed_request(&c, auth, Method::POST, &peer_base(host, port), "/p2p/clipboard", body, "application/json").await?;
    json_or_err(r).await
}

/// Streams a file in 1 MB authenticated chunks, verifies SHA-256 end to end.
/// `on_progress(sent, total, percent, speed)`.
pub async fn send_file<F: Fn(&str, u64, u64, f64, f64)>(host: &str, port: u16, auth: &PeerAuth, file_path: &str, sender_name: &str, cancel: Arc<AtomicBool>, on_progress: F) -> SendFileResult {
    let mut res = SendFileResult::default();
    let path = Path::new(file_path);
    res.filename = path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
    let fail = |mut r: SendFileResult, e: String| {
        r.error = Some(e);
        r
    };
    // Pass 1: hash the file so the receiver knows the expected digest up front.
    let mut file = match File::open(path).await {
        Ok(f) => f,
        Err(e) => return fail(res, format!("Fayl açılmadı: {}", e)),
    };
    let size = match file.metadata().await {
        Ok(m) => m.len(),
        Err(e) => return fail(res, format!("Fayl oxunmadı: {}", e)),
    };
    res.file_size = size;
    let mut buf = vec![0u8; CHUNK];
    let mut hasher = Sha256::new();
    loop {
        if cancel.load(Ordering::Relaxed) {
            res.canceled = true;
            return fail(res, "Ləğv edildi".into());
        }
        match file.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => hasher.update(&buf[..n]),
            Err(e) => return fail(res, format!("Fayl oxunmadı: {}", e)),
        }
    }
    let digest = hex::encode(hasher.finalize());
    res.sha256 = digest.clone();

    let base = peer_base(host, port);
    let c = match Client::builder().timeout(std::time::Duration::from_secs(60)).connect_timeout(std::time::Duration::from_secs(8)).build() {
        Ok(c) => c,
        Err(e) => return fail(res, e.to_string()),
    };
    let prep = json!({"filename": res.filename, "file_size": size, "sha256": digest, "sender_name": sender_name});
    let prep_res = match signed_request(&c, auth, Method::POST, &base, "/p2p/file/prepare", serde_json::to_vec(&prep).unwrap(), "application/json").await {
        Ok(r) => json_or_err(r).await,
        Err(e) => Err(e),
    };
    let tid = match prep_res {
        Ok(v) => v["transfer_id"].as_str().unwrap_or_default().to_string(),
        Err(e) => return fail(res, e),
    };
    if tid.is_empty() {
        return fail(res, "Qarşı cihaz transferi qəbul etmədi".into());
    }
    res.transfer_id = tid.clone();

    // Pass 2: stream chunks with offsets; each chunk is retried (receiver de-duplicates).
    let mut file = match File::open(path).await {
        Ok(f) => f,
        Err(e) => return fail(res, format!("Fayl açılmadı: {}", e)),
    };
    let start = Instant::now();
    let mut sent: u64 = 0;
    let mut rehash = Sha256::new();
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = signed_request(&c, auth, Method::POST, &base, &format!("/p2p/file/cancel/{}", tid), vec![], "application/json").await;
            res.canceled = true;
            return fail(res, "Ləğv edildi".into());
        }
        let n = match file.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => return fail(res, format!("Fayl oxunmadı: {}", e)),
        };
        rehash.update(&buf[..n]);
        let mut attempt = 0;
        loop {
            attempt += 1;
            let r = signed_request(&c, auth, Method::POST, &base, &format!("/p2p/file/chunk/{}?offset={}", tid, sent), buf[..n].to_vec(), "application/octet-stream").await;
            match r {
                Ok(resp) if resp.status().is_success() => break,
                Ok(resp) => {
                    let st = resp.status();
                    if attempt >= 3 || st.as_u16() == 404 || st.as_u16() == 401 {
                        return fail(res, format!("Hissə göndərilmədi: HTTP {}", st));
                    }
                }
                Err(e) => {
                    if attempt >= 3 {
                        return fail(res, e);
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(500 * attempt)).await;
        }
        sent += n as u64;
        let el = start.elapsed().as_secs_f64();
        let speed = if el > 0.05 { sent as f64 / 1048576.0 / el } else { 0.0 };
        let pct = if size > 0 { (sent as f64 / size as f64 * 100.0).min(100.0) } else { 100.0 };
        on_progress(&tid, sent, size, pct, speed);
    }
    let reread = hex::encode(rehash.finalize());
    if reread != digest {
        let _ = signed_request(&c, auth, Method::POST, &base, &format!("/p2p/file/cancel/{}", tid), vec![], "application/json").await;
        return fail(res, "Fayl göndərilərkən dəyişdi (SHA-256 uyğun gəlmir)".into());
    }
    let fin = serde_json::to_vec(&json!({"sha256": digest})).unwrap();
    let fin_res = match signed_request(&c, auth, Method::POST, &base, &format!("/p2p/file/finish/{}", tid), fin, "application/json").await {
        Ok(r) => json_or_err(r).await,
        Err(e) => Err(e),
    };
    match fin_res {
        Ok(v) => {
            let remote = v["sha256"].as_str().unwrap_or_default();
            if remote != digest {
                return fail(res, "Qəbul edən tərəfin SHA-256 dəyəri uyğun gəlmir".into());
            }
            res.verified = true;
            res.success = true;
            let el = start.elapsed().as_secs_f64();
            res.speed_mbps = if el > 0.0 { sent as f64 / 1048576.0 / el } else { 0.0 };
            res
        }
        Err(e) => fail(res, format!("Təsdiq alınmadı: {}", e)),
    }
}
