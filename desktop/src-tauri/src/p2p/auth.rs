//! Authentication of direct device-to-device requests.
//!
//! Every request carries:
//!   X-Cahangir-Device  sender device id
//!   X-Cahangir-Ts      unix ms
//!   X-Cahangir-Nonce   random hex (replay protection)
//!   X-Cahangir-Sig     hex(HMAC-SHA256(mesh_key, METHOD \n PATH \n TS \n NONCE \n SHA256HEX(BODY)))
//! The mesh key is distributed by the Debian server only to paired, non-revoked devices
//! and rotated when a device is revoked. Being on the same network grants nothing.
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;

type HmacSha256 = Hmac<Sha256>;

pub const MAX_SKEW_MS: i64 = 5 * 60 * 1000;

pub fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

pub fn signature(key_hex: &str, method: &str, path: &str, ts: i64, nonce: &str, body: &[u8]) -> Option<String> {
    let key = hex::decode(key_hex).ok()?;
    let mut mac = HmacSha256::new_from_slice(&key).ok()?;
    let msg = format!("{}\n{}\n{}\n{}\n{}", method.to_uppercase(), path, ts, nonce, sha256_hex(body));
    mac.update(msg.as_bytes());
    Some(hex::encode(mac.finalize().into_bytes()))
}

pub fn new_nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

#[derive(Default)]
pub struct NonceCache {
    seen: Mutex<HashMap<String, i64>>,
}

#[derive(Debug, PartialEq)]
pub enum AuthError {
    NotPaired,
    Missing,
    Expired,
    Replay,
    BadSignature,
}

impl NonceCache {
    #[allow(clippy::too_many_arguments)]
    pub fn verify(&self, key_hex: &str, method: &str, path: &str, ts: Option<&str>, nonce: Option<&str>, sig: Option<&str>, body: &[u8], now: i64) -> Result<(), AuthError> {
        if key_hex.is_empty() {
            return Err(AuthError::NotPaired);
        }
        let (ts, nonce, sig) = match (ts, nonce, sig) {
            (Some(t), Some(n), Some(s)) if !n.is_empty() && n.len() <= 64 => (t, n, s),
            _ => return Err(AuthError::Missing),
        };
        let ts: i64 = ts.parse().map_err(|_| AuthError::Missing)?;
        if (now - ts).abs() > MAX_SKEW_MS {
            return Err(AuthError::Expired);
        }
        let key = hex::decode(key_hex).map_err(|_| AuthError::NotPaired)?;
        let mut mac = HmacSha256::new_from_slice(&key).map_err(|_| AuthError::NotPaired)?;
        let msg = format!("{}\n{}\n{}\n{}\n{}", method.to_uppercase(), path, ts, nonce, sha256_hex(body));
        mac.update(msg.as_bytes());
        let sig_bytes = hex::decode(sig).map_err(|_| AuthError::BadSignature)?;
        mac.verify_slice(&sig_bytes).map_err(|_| AuthError::BadSignature)?; // constant time
        let mut seen = self.seen.lock().unwrap();
        seen.retain(|_, t| now - *t <= 2 * MAX_SKEW_MS);
        if seen.contains_key(nonce) {
            return Err(AuthError::Replay);
        }
        seen.insert(nonce.to_string(), now);
        Ok(())
    }
}

/// Safe file name for saving a received file: no directories, no control or reserved
/// characters, no Windows device names, bounded length.
pub fn sanitize_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let mut s: String = base
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect();
    s = s.trim_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
    if s.is_empty() {
        s = "file".into();
    }
    let stem = s.split('.').next().unwrap_or("").to_uppercase();
    const RESERVED: [&str; 22] = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];
    if RESERVED.contains(&stem.as_str()) {
        s = format!("_{}", s);
    }
    if s.chars().count() > 180 {
        let ext: String = s.rsplit_once('.').map(|(_, e)| e.chars().take(10).collect()).unwrap_or_default();
        let head: String = s.chars().take(160).collect();
        s = if ext.is_empty() { head } else { format!("{}.{}", head, ext) };
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    #[test]
    fn sign_and_verify() {
        let cache = NonceCache::default();
        let now = 1_000_000_000_000;
        let sig = signature(KEY, "POST", "/p2p/clipboard", now, "n1", b"{}").unwrap();
        assert_eq!(cache.verify(KEY, "POST", "/p2p/clipboard", Some(&now.to_string()), Some("n1"), Some(&sig), b"{}", now), Ok(()));
        // replay
        assert_eq!(cache.verify(KEY, "POST", "/p2p/clipboard", Some(&now.to_string()), Some("n1"), Some(&sig), b"{}", now), Err(AuthError::Replay));
        // tampered body / path / key
        let sig2 = signature(KEY, "POST", "/p2p/clipboard", now, "n2", b"{}").unwrap();
        assert_eq!(cache.verify(KEY, "POST", "/p2p/clipboard", Some(&now.to_string()), Some("n2"), Some(&sig2), b"{x}", now), Err(AuthError::BadSignature));
        assert_eq!(cache.verify(KEY, "POST", "/p2p/other", Some(&now.to_string()), Some("n2"), Some(&sig2), b"{}", now), Err(AuthError::BadSignature));
        let other = "ff".repeat(32);
        assert_eq!(cache.verify(&other, "POST", "/p2p/clipboard", Some(&now.to_string()), Some("n2"), Some(&sig2), b"{}", now), Err(AuthError::BadSignature));
        // expired
        let old = now - MAX_SKEW_MS - 1;
        let sig3 = signature(KEY, "GET", "/p2p/ping", old, "n3", b"").unwrap();
        assert_eq!(cache.verify(KEY, "GET", "/p2p/ping", Some(&old.to_string()), Some("n3"), Some(&sig3), b"", now), Err(AuthError::Expired));
        // missing / not paired
        assert_eq!(cache.verify(KEY, "GET", "/p2p/ping", None, None, None, b"", now), Err(AuthError::Missing));
        assert_eq!(cache.verify("", "GET", "/p2p/ping", None, None, None, b"", now), Err(AuthError::NotPaired));
    }

    #[test]
    fn known_vector_matches_android_implementation() {
        // Same vector is asserted in the Android unit test (P2pAuthTest) to guarantee interop.
        let sig = signature(KEY, "POST", "/p2p/clipboard", 1700000000000, "abc", b"hello").unwrap();
        assert_eq!(sig, "fe0391bae380cc3c1db2d628f191d3fb558b8e2291bcbbd563e7491881e0d125");
        assert_eq!(sig, signature(KEY, "post", "/p2p/clipboard", 1700000000000, "abc", b"hello").unwrap());
    }

    #[test]
    fn filenames_are_sanitized() {
        assert_eq!(sanitize_filename("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_filename("C:\\Windows\\evil.exe"), "evil.exe");
        assert_eq!(sanitize_filename("con.txt"), "_con.txt");
        assert_eq!(sanitize_filename("a<b>c?.pdf"), "a_b_c_.pdf");
        assert_eq!(sanitize_filename("..."), "file");
        assert_eq!(sanitize_filename("report\u{0000}.doc"), "report_.doc");
        assert!(sanitize_filename(&"x".repeat(500)).chars().count() <= 180);
    }
}
