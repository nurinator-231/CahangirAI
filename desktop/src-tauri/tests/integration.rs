//! Integration tests against a live Cahangir backend.
//! Run via scripts/integration-test.sh (starts a throw-away backend). Skipped when
//! CAHANGIR_TEST_SERVER is not set.
use cahangir_desktop_lib::db::storage::Database;
use cahangir_desktop_lib::p2p::client::{self, PeerAuth};
use cahangir_desktop_lib::p2p::server::{router, P2pServerState};
use cahangir_desktop_lib::sync::sync_once;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

fn env() -> Option<(String, String)> {
    Some((std::env::var("CAHANGIR_TEST_SERVER").ok()?, std::env::var("CAHANGIR_TEST_ADMIN").ok()?))
}

fn tmpdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("cg_it_{}_{}", tag, uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

async fn device(server: &str, admin: &str, name: &str) -> (Database, PathBuf) {
    let dir = tmpdir(name);
    let db = Database::open(&dir.join("d.db")).unwrap();
    let cfg = db.get_config().unwrap();
    let r: Value = reqwest::Client::new()
        .post(format!("{}/api/auth/register-device", server))
        .header("X-Admin-Token", admin)
        .json(&json!({"device_id": cfg.device_id, "device_name": name, "platform": "test"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    db.update_config(|c| {
        c.server_url = server.to_string();
        c.device_token = r["api_token"].as_str().unwrap().to_string();
        c.device_name = name.to_string();
        c.download_dir = dir.join("downloads").to_string_lossy().to_string();
    })
    .unwrap();
    (db, dir)
}

#[tokio::test]
async fn end_to_end_sync_offline_p2p_clipboard() {
    let Some((server, admin)) = env() else {
        eprintln!("CAHANGIR_TEST_SERVER not set; skipping");
        return;
    };
    let (a, _da) = device(&server, &admin, "Windows-A").await;
    let (b, db_dir) = device(&server, &admin, "Android-sim-B").await;
    sync_once(&a, None).await.unwrap();
    sync_once(&b, None).await.unwrap();

    // 1. Create on A -> appears on B.
    let t = a.save_local("tasks", &json!({"title": "Programming assignment", "estimated_minutes": 120, "deadline": 1_800_000_000_000i64})).unwrap();
    let id = t["id"].as_str().unwrap().to_string();
    let ra = sync_once(&a, None).await.unwrap();
    assert_eq!(ra.pushed, 1);
    assert_eq!(a.get("tasks", &id).unwrap().unwrap()["sync_status"], 0);
    let rb = sync_once(&b, None).await.unwrap();
    assert!(rb.changed_entities.contains(&"tasks".to_string()));
    let tb = b.get("tasks", &id).unwrap().unwrap();
    assert_eq!(tb["title"], "Programming assignment");
    assert_eq!(tb["sync_status"], 0);

    // 2. Edit on B -> propagates back to A (no conflict, base_rev used).
    b.save_local("tasks", &json!({"id": id, "title": "Programming assignment (v2)", "estimated_minutes": 90})).unwrap();
    let rb = sync_once(&b, None).await.unwrap();
    assert!(rb.conflicts.is_empty(), "{:?}", rb.conflicts);
    sync_once(&a, None).await.unwrap();
    let ta = a.get("tasks", &id).unwrap().unwrap();
    assert_eq!(ta["title"], "Programming assignment (v2)");
    assert_eq!(ta["estimated_minutes"], 90);

    // 3. Offline: B edits while the server is unreachable; changes stay queued, then sync.
    let good = b.get_config().unwrap().server_url;
    b.update_config(|c| c.server_url = "http://127.0.0.1:9".into()).unwrap();
    b.save_local("events", &json!({"id": "evt_offline", "title": "English lessons", "start_at": 1_800_000_360_000i64})).unwrap();
    assert!(sync_once(&b, None).await.is_err());
    assert_eq!(b.pending("events").unwrap().len(), 1);
    b.update_config(|c| c.server_url = good.clone()).unwrap();
    sync_once(&b, None).await.unwrap();
    assert!(b.pending("events").unwrap().is_empty());
    sync_once(&a, None).await.unwrap();
    assert_eq!(a.get("events", "evt_offline").unwrap().unwrap()["title"], "English lessons");

    // 4. Concurrent edit -> deterministic resolution, both devices converge.
    a.save_local("tasks", &json!({"id": id, "title": "Edit from A"})).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    b.save_local("tasks", &json!({"id": id, "title": "Edit from B (newer)"})).unwrap();
    sync_once(&a, None).await.unwrap();
    let rb = sync_once(&b, None).await.unwrap();
    assert_eq!(rb.conflicts.len(), 1);
    sync_once(&a, None).await.unwrap();
    assert_eq!(a.get("tasks", &id).unwrap().unwrap()["title"], "Edit from B (newer)");
    assert_eq!(b.get("tasks", &id).unwrap().unwrap()["title"], "Edit from B (newer)");

    // 5. Tombstone deletion propagates.
    a.delete_local("tasks", &id).unwrap();
    sync_once(&a, None).await.unwrap();
    sync_once(&b, None).await.unwrap();
    assert_eq!(b.get("tasks", &id).unwrap().unwrap()["deleted"], 1);
    assert!(b.list("tasks", false).unwrap().iter().all(|t| t["id"] != id.as_str()));

    // 6. Clipboard through the server (offline-capable path).
    a.save_local("clipboard_items", &json!({"text": "copied on A", "hash": "x", "origin_name": "Windows-A"})).unwrap();
    sync_once(&a, None).await.unwrap();
    let rb = sync_once(&b, None).await.unwrap();
    assert_eq!(rb.incoming_clipboard.last().unwrap()["text"], "copied on A");

    // 7. Authenticated P2P: B runs a receiver; A sends a file and clipboard text.
    let key_a = a.get_config().unwrap().mesh_key;
    assert_eq!(key_a.len(), 64);
    assert_eq!(key_a, b.get_config().unwrap().mesh_key);
    let downloads = db_dir.join("downloads");
    let received_clip = Arc::new(Mutex::new(String::new()));
    let rc = received_clip.clone();
    let st = P2pServerState {
        db: b.clone(),
        download_dir: Arc::new(Mutex::new(downloads.clone())),
        app_handle: None,
        sessions: Arc::new(tokio::sync::Mutex::new(Default::default())),
        last_clipboard_hash: Arc::new(Mutex::new(String::new())),
        nonces: Arc::new(Default::default()),
        clipboard_sink: Some(Arc::new(move |t: &str| *rc.lock().unwrap() = t.to_string())),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, router(st)).await.unwrap() });

    let auth = PeerAuth { mesh_key: key_a.clone(), device_id: "A".into() };
    let ping = client::ping_peer("127.0.0.1", port, &auth).await.unwrap();
    assert_eq!(ping["device_name"], "Android-sim-B");
    // Wrong key is rejected (same network != trusted).
    let bad = PeerAuth { mesh_key: "ab".repeat(32), device_id: "evil".into() };
    assert!(client::ping_peer("127.0.0.1", port, &bad).await.is_err());

    // 2.5 MB file -> 3 chunks; name contains a path traversal attempt.
    let src_dir = tmpdir("src");
    let src = src_dir.join("..%2f..%2fnotes.bin");
    let data: Vec<u8> = (0..2_621_440u32).map(|i| (i * 7 % 251) as u8).collect();
    std::fs::write(&src, &data).unwrap();
    let res = client::send_file("127.0.0.1", port, &auth, src.to_str().unwrap(), "Windows-A", Arc::new(AtomicBool::new(false)), |_, _, _, _, _| {}).await;
    assert!(res.success, "{:?}", res.error);
    assert!(res.verified);
    let saved: Vec<_> = std::fs::read_dir(&downloads).unwrap().map(|e| e.unwrap().path()).filter(|p| !p.file_name().unwrap().to_string_lossy().starts_with('.')).collect();
    assert_eq!(saved.len(), 1);
    assert!(saved[0].starts_with(&downloads));
    assert_eq!(std::fs::read(&saved[0]).unwrap(), data);
    use sha2::Digest;
    assert_eq!(hex::encode(sha2::Sha256::digest(&data)), res.sha256);
    assert_eq!(b.get_transfers().unwrap()[0].status, "completed");

    // Cancellation leaves no partial file.
    let cancel = Arc::new(AtomicBool::new(true));
    let res = client::send_file("127.0.0.1", port, &auth, src.to_str().unwrap(), "Windows-A", cancel, |_, _, _, _, _| {}).await;
    assert!(!res.success && res.canceled);
    let left: Vec<_> = std::fs::read_dir(&downloads).unwrap().collect();
    assert_eq!(left.len(), 1);

    // Clipboard push; duplicate push is skipped (loop prevention).
    let r = client::send_clipboard("127.0.0.1", port, &auth, "clp_p2p_1", "hello from A", "Windows-A").await.unwrap();
    assert_eq!(r["success"], true);
    assert_eq!(*received_clip.lock().unwrap(), "hello from A");
    let r = client::send_clipboard("127.0.0.1", port, &auth, "clp_p2p_1", "hello from A", "Windows-A").await.unwrap();
    assert_eq!(r["skipped"], true);

    // 8. Revoking A rotates the key: B (after sync) no longer accepts A's old key.
    let a_id = a.get_config().unwrap().device_id;
    let rv = reqwest::Client::new().post(format!("{}/api/auth/revoke-device", server)).header("X-Admin-Token", &admin).json(&json!({"device_id": a_id})).send().await.unwrap();
    assert!(rv.status().is_success());
    sync_once(&b, None).await.unwrap();
    assert_ne!(b.get_config().unwrap().mesh_key, key_a);
    assert!(client::ping_peer("127.0.0.1", port, &auth).await.is_err());
    assert!(sync_once(&a, None).await.unwrap_err().contains("ləğv"));
}
