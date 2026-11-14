//! Reminder engine running in the Rust process (not in the web UI), so reminders fire
//! while the window is hidden in the tray and after the app auto-starts at login.
use crate::db::storage::{json_i64, Database};
use chrono::{Duration as CDur, Local, TimeZone};
use serde_json::{json, Value};

pub const MISSED_GRACE_MS: i64 = 10 * 60 * 1000;
/// Reminders more than this far in the past are marked handled without a notification
/// (e.g. on a fresh install that just synced old data).
pub const STALE_MS: i64 = 24 * 3600 * 1000;

fn parse_repeat(v: &Value) -> Option<Value> {
    match v {
        Value::String(s) if !s.is_empty() => serde_json::from_str(s).ok(),
        Value::Object(_) => Some(v.clone()),
        _ => None,
    }
}

/// Next occurrence strictly after `now` (same semantics as planner.js / nlp.js / Kotlin).
/// Daily/weekly steps are calendar days in local time, so DST changes keep the wall clock.
pub fn next_due(due: i64, repeat: &Value, now: i64) -> Option<i64> {
    let rep = parse_repeat(repeat)?;
    let kind = rep.get("type")?.as_str()?.to_string();
    let mut d = Local.timestamp_millis_opt(due).single()?;
    let mut guard = 0;
    loop {
        d = match kind.as_str() {
            "daily" => step_days(d, 1)?,
            "weekly" => step_days(d, 7)?,
            "interval" => {
                let ms = rep.get("ms").and_then(json_i64).unwrap_or(60_000).max(60_000);
                d + CDur::milliseconds(ms)
            }
            _ => return None,
        };
        guard += 1;
        if d.timestamp_millis() > now || guard > 100_000 {
            return Some(d.timestamp_millis());
        }
    }
}

fn step_days(d: chrono::DateTime<Local>, n: i64) -> Option<chrono::DateTime<Local>> {
    let naive = d.naive_local() + CDur::days(n);
    Local.from_local_datetime(&naive).earliest().or_else(|| Local.from_local_datetime(&(naive + CDur::hours(1))).earliest())
}

pub fn effective_time(r: &Value) -> Option<i64> {
    r.get("snooze").and_then(json_i64).filter(|v| *v > 0).or_else(|| r.get("due").and_then(json_i64).filter(|v| *v > 0))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Fired {
    pub id: String,
    pub text: String,
    pub kind: String,
    pub missed: bool,
    pub at: i64,
}

/// Finds due reminders, updates their state and returns those to notify.
pub fn process_due(db: &Database, now: i64) -> Vec<Fired> {
    let mut out = Vec::new();
    let list = match db.list("reminders", false) {
        Ok(l) => l,
        Err(_) => return out,
    };
    for r in list {
        if r["done"] == 1 {
            continue;
        }
        let eff = match effective_time(&r) {
            Some(e) => e,
            None => continue,
        };
        if eff > now {
            continue;
        }
        let fired_at = r.get("fired_at").and_then(json_i64);
        if matches!(fired_at, Some(f) if f >= eff) {
            continue;
        }
        let id = r["id"].as_str().unwrap_or_default().to_string();
        let repeat = r.get("repeat").cloned().unwrap_or(Value::Null);
        let stale = now - eff > STALE_MS;
        if let (Some(due), true) = (r.get("due").and_then(json_i64), parse_repeat(&repeat).is_some()) {
            // Recurring: advance to the next occurrence (synced so all devices agree).
            if let Some(next) = next_due(due, &repeat, now) {
                let _ = db.save_local("reminders", &json!({"id": id, "due": next, "snooze": Value::Null}));
                let _ = db.set_reminder_fired(&id, None);
            }
        } else {
            let _ = db.set_reminder_fired(&id, Some(now));
        }
        if !stale {
            out.push(Fired {
                id,
                text: r["text"].as_str().unwrap_or_default().to_string(),
                kind: r["kind"].as_str().unwrap_or("custom").to_string(),
                missed: now - eff > MISSED_GRACE_MS,
                at: eff,
            });
        }
    }
    out
}

pub fn complete(db: &Database, id: &str) -> Result<(), String> {
    let r = db.get("reminders", id).map_err(|e| e.to_string())?.ok_or("not found")?;
    if parse_repeat(r.get("repeat").unwrap_or(&Value::Null)).is_some() {
        // Recurring reminders stay active; completing acknowledges this occurrence only.
        db.save_local("reminders", &json!({"id": id, "snooze": Value::Null})).map_err(|e| e.to_string())?;
    } else {
        db.save_local("reminders", &json!({"id": id, "done": 1, "snooze": Value::Null})).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn snooze(db: &Database, id: &str, minutes: i64, now: i64) -> Result<i64, String> {
    let until = now + minutes.clamp(1, 24 * 60) * 60_000;
    db.save_local("reminders", &json!({"id": id, "snooze": until})).map_err(|e| e.to_string())?;
    db.set_reminder_fired(id, None).map_err(|e| e.to_string())?;
    Ok(until)
}

/// Milliseconds until the next reminder is due (for efficient sleeping).
pub fn ms_until_next(db: &Database, now: i64) -> Option<i64> {
    let list = db.list("reminders", false).ok()?;
    list.iter()
        .filter(|r| r["done"] != 1)
        .filter_map(|r| {
            let eff = effective_time(r)?;
            let fired = r.get("fired_at").and_then(json_i64);
            if matches!(fired, Some(f) if f >= eff) {
                None
            } else {
                Some((eff - now).max(0))
            }
        })
        .min()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::storage::Database;

    fn db() -> Database {
        let dir = std::env::temp_dir().join(format!("cg_rem_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        Database::open(&dir.join("t.db")).unwrap()
    }

    fn local(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap().timestamp_millis()
    }

    #[test]
    fn next_due_daily_weekly_interval() {
        let due = local(2026, 11, 14, 8, 0);
        let now = local(2026, 11, 14, 9, 0);
        assert_eq!(next_due(due, &json!("{\"type\":\"daily\"}"), now), Some(local(2026, 11, 15, 8, 0)));
        assert_eq!(next_due(due, &json!({"type":"weekly"}), now), Some(local(2026, 11, 21, 8, 0)));
        assert_eq!(next_due(due, &json!({"type":"interval","ms":1800000}), now), Some(local(2026, 11, 14, 9, 30)));
        assert_eq!(next_due(due, &Value::Null, now), None);
    }

    #[test]
    fn fires_once_then_not_again_snooze_refires() {
        let db = db();
        let now = 1_800_000_000_000;
        db.save_local("reminders", &json!({"id": "r1", "text": "Call", "due": now - 1000})).unwrap();
        db.save_local("reminders", &json!({"id": "r2", "text": "Later", "due": now + 60_000})).unwrap();
        let f = process_due(&db, now);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].id, "r1");
        assert!(!f[0].missed);
        assert!(process_due(&db, now + 1000).is_empty());
        assert_eq!(ms_until_next(&db, now), Some(60_000));
        snooze(&db, "r1", 10, now).unwrap();
        assert!(!process_due(&db, now + 5 * 60_000).iter().any(|x| x.id == "r1"));
        let f = process_due(&db, now + 10 * 60_000 + 1);
        assert!(f.iter().any(|x| x.id == "r1"));
        complete(&db, "r1").unwrap();
        assert_eq!(db.get("reminders", "r1").unwrap().unwrap()["done"], 1);
    }

    #[test]
    fn recurring_advances_and_missed_and_stale() {
        let db = db();
        let now = local(2026, 11, 14, 9, 0);
        db.save_local("reminders", &json!({"id": "d", "text": "Pills", "due": local(2026, 11, 14, 8, 0), "repeat": {"type": "daily"}})).unwrap();
        db.save_local("reminders", &json!({"id": "old", "text": "Old", "due": now - 3 * 24 * 3600 * 1000})).unwrap();
        let f = process_due(&db, now);
        assert_eq!(f.len(), 1);
        assert!(f[0].missed);
        let d = db.get("reminders", "d").unwrap().unwrap();
        assert_eq!(d["due"], local(2026, 11, 15, 8, 0));
        assert_eq!(d["done"], 0);
        assert_eq!(d["sync_status"], 1);
        // Stale one was marked handled silently.
        assert!(process_due(&db, now + 1).is_empty());
    }
}
