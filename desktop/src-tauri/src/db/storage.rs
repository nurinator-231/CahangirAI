//! Local SQLite store for the Windows app (offline source of data, synced with Debian).
//!
//! Every synchronized entity uses the same columns as the server (see backend
//! `app/entities.py`) plus two local bookkeeping columns:
//!   * `sync_status` – 1 = local change not yet acknowledged by the server
//!   * `server_rev`  – last server revision seen for the row (sent as `base_rev`)
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const SCHEMA_VERSION: i64 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub server_url: String,
    /// Kept only for backwards compatibility; no longer persisted after pairing.
    pub admin_token: String,
    pub device_token: String,
    pub device_id: String,
    pub device_name: String,
    pub p2p_port: u16,
    pub download_dir: String,
    /// Accept clipboard text sent from paired devices and put it on the Windows clipboard.
    pub clipboard_sync_enabled: bool,
    /// Watch the Windows clipboard and share new text with paired devices (opt-in).
    pub clipboard_auto_share: bool,
    pub auto_start: bool,
    pub minimize_to_tray: bool,
    pub theme: String,
    pub language: String,
    pub last_sync_time: i64,
    pub last_server_rev: i64,
    /// Minutes between automatic background syncs (0 = manual only).
    pub auto_sync_minutes: u32,
    pub last_sync_status: String,
    pub last_sync_error: String,
    pub mesh_key: String,
    pub mesh_key_id: i64,
    pub planner_day_start: String,
    pub planner_day_end: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        let default_download = dirs::download_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .to_string_lossy()
            .to_string();
        Self {
            server_url: String::new(),
            admin_token: String::new(),
            device_token: String::new(),
            device_id: format!("win_{}", uuid::Uuid::new_v4().simple()),
            device_name: "Cahangir Windows".to_string(),
            p2p_port: 8767,
            download_dir: default_download,
            clipboard_sync_enabled: true,
            clipboard_auto_share: false,
            auto_start: false,
            minimize_to_tray: true,
            theme: "dark".to_string(),
            language: "az".to_string(),
            last_sync_time: 0,
            last_server_rev: 0,
            auto_sync_minutes: 5,
            last_sync_status: "never".to_string(),
            last_sync_error: String::new(),
            mesh_key: String::new(),
            mesh_key_id: 0,
            planner_day_start: "08:00".to_string(),
            planner_day_end: "22:00".to_string(),
        }
    }
}

pub mod dirs {
    use std::path::PathBuf;
    pub fn download_dir() -> Option<PathBuf> {
        std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(|p| PathBuf::from(p).join("Downloads"))
    }
    pub fn data_dir() -> PathBuf {
        let base = std::env::var_os("CAHANGIR_DESKTOP_DATA_DIR")
            .or_else(|| std::env::var_os("APPDATA"))
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
            .unwrap_or_else(|| PathBuf::from("."));
        let dir = if std::env::var_os("CAHANGIR_DESKTOP_DATA_DIR").is_some() { base } else { base.join("CahangirDesktop") };
        let _ = std::fs::create_dir_all(&dir);
        dir
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Kind {
    Text,
    NullText,
    Int,
    NullInt,
    Real,
    /// JSON stored as text (objects from the UI are serialized)
    Json,
}

pub struct Col {
    pub name: &'static str,
    pub kind: Kind,
    pub default: &'static str,
}

const fn c(name: &'static str, kind: Kind, default: &'static str) -> Col {
    Col { name, kind, default }
}

pub struct EntitySpec {
    pub name: &'static str,
    pub prefix: &'static str,
    pub cols: &'static [Col],
}

pub static ENTITIES: &[EntitySpec] = &[
    EntitySpec {
        name: "reminders",
        prefix: "rem",
        cols: &[
            c("user_id", Kind::Text, "default"),
            c("text", Kind::Text, ""),
            c("due", Kind::NullInt, ""),
            c("snooze", Kind::NullInt, ""),
            c("done", Kind::Int, "0"),
            c("timer", Kind::Int, "0"),
            c("repeat", Kind::Json, ""),
            c("task_id", Kind::NullText, ""),
            c("event_id", Kind::NullText, ""),
            c("kind", Kind::Text, "custom"),
        ],
    },
    EntitySpec {
        name: "memories",
        prefix: "mem",
        cols: &[
            c("user_id", Kind::Text, "default"),
            c("category", Kind::Text, "general"),
            c("fact_text", Kind::Text, ""),
            c("confidence", Kind::Real, "1.0"),
            c("source", Kind::Text, "user"),
        ],
    },
    EntitySpec {
        name: "projects",
        prefix: "prj",
        cols: &[
            c("user_id", Kind::Text, "default"),
            c("title", Kind::Text, ""),
            c("status", Kind::Text, "active"),
            c("notes", Kind::Text, ""),
        ],
    },
    EntitySpec {
        name: "tasks",
        prefix: "tsk",
        cols: &[
            c("user_id", Kind::Text, "default"),
            c("title", Kind::Text, ""),
            c("description", Kind::Text, ""),
            c("category", Kind::Text, "general"),
            c("priority", Kind::Text, "medium"),
            c("deadline", Kind::NullInt, ""),
            c("estimated_minutes", Kind::NullInt, ""),
            c("status", Kind::Text, "todo"),
            c("project_id", Kind::NullText, ""),
            c("completed_at", Kind::NullInt, ""),
            c("source", Kind::Text, "user"),
        ],
    },
    EntitySpec {
        name: "events",
        prefix: "evt",
        cols: &[
            c("user_id", Kind::Text, "default"),
            c("title", Kind::Text, ""),
            c("start_at", Kind::Int, "0"),
            c("end_at", Kind::NullInt, ""),
            c("all_day", Kind::Int, "0"),
            c("location", Kind::Text, ""),
            c("recurrence", Kind::Json, ""),
            c("notes", Kind::Text, ""),
            c("source", Kind::Text, "user"),
            c("confirmed", Kind::Int, "1"),
        ],
    },
    EntitySpec {
        name: "plan_blocks",
        prefix: "blk",
        cols: &[
            c("user_id", Kind::Text, "default"),
            c("task_id", Kind::Text, ""),
            c("start_at", Kind::Int, "0"),
            c("end_at", Kind::Int, "0"),
            c("status", Kind::Text, "proposed"),
            c("locked", Kind::Int, "0"),
            c("reason", Kind::Text, ""),
        ],
    },
    EntitySpec {
        name: "clipboard_items",
        prefix: "clp",
        cols: &[
            c("user_id", Kind::Text, "default"),
            c("text", Kind::Text, ""),
            c("hash", Kind::Text, ""),
            c("origin_name", Kind::Text, ""),
        ],
    },
];

pub fn spec(name: &str) -> Option<&'static EntitySpec> {
    ENTITIES.iter().find(|e| e.name == name)
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferRecord {
    pub id: String,
    pub filename: String,
    pub file_size: i64,
    pub direction: String,
    pub peer_device: String,
    pub status: String,
    pub speed_mbps: f64,
    pub sha256: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessageRecord {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub timestamp: i64,
}

#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
    pub path: PathBuf,
}

fn sql_decl(col: &Col) -> String {
    match col.kind {
        Kind::Text => format!("{} TEXT NOT NULL DEFAULT '{}'", col.name, col.default.replace('\'', "''")),
        Kind::NullText | Kind::Json => format!("{} TEXT", col.name),
        Kind::Int => format!("{} INTEGER NOT NULL DEFAULT {}", col.name, col.default),
        Kind::NullInt => format!("{} INTEGER", col.name),
        Kind::Real => format!("{} REAL NOT NULL DEFAULT {}", col.name, col.default),
    }
}

fn column_names(conn: &Connection, table: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({});", table))?;
    let names = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<Result<Vec<_>>>()?;
    Ok(names)
}

fn add_column(conn: &Connection, table: &str, decl: &str) -> Result<()> {
    let name = decl.split_whitespace().next().unwrap_or_default();
    if !column_names(conn, table)?.iter().any(|c| c == name) {
        conn.execute(&format!("ALTER TABLE {} ADD COLUMN {};", table, decl), [])?;
    }
    Ok(())
}

impl Database {
    pub fn init() -> Result<Self> {
        Self::open(&dirs::data_dir().join("cahangir_desktop.db"))
    }

    pub fn open(db_path: &Path) -> Result<Self> {
        let conn = Connection::open(db_path)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;")?;
        let db = Self { conn: Arc::new(Mutex::new(conn)), path: db_path.to_path_buf() };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version;", [], |r| r.get(0))?;
        if version >= SCHEMA_VERSION {
            return Ok(());
        }
        let has_data: bool = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='config';", [], |r| r.get::<_, i64>(0))
            .map(|n| n > 0)
            .unwrap_or(false);
        if has_data {
            // Safety copy of the existing database before changing its schema.
            let backup = self.path.with_file_name(format!(
                "cahangir_desktop.pre_v{}_{}.db",
                SCHEMA_VERSION,
                chrono::Local::now().format("%Y%m%d_%H%M%S")
            ));
            conn.execute("VACUUM INTO ?1;", params![backup.to_string_lossy()])?;
        }
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS transfers (
                id TEXT PRIMARY KEY, filename TEXT NOT NULL, file_size INTEGER NOT NULL,
                direction TEXT NOT NULL, peer_device TEXT NOT NULL, status TEXT NOT NULL,
                speed_mbps REAL NOT NULL DEFAULT 0.0, sha256 TEXT NOT NULL DEFAULT '', timestamp INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chat_messages (
                id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
                content TEXT NOT NULL, timestamp INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chat_sess ON chat_messages(session_id);
            "#,
        )?;
        let tx = conn.unchecked_transaction()?;
        for e in ENTITIES {
            let cols: Vec<String> = e.cols.iter().map(sql_decl).collect();
            tx.execute(
                &format!(
                    "CREATE TABLE IF NOT EXISTS {} (id TEXT PRIMARY KEY, {}, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, sync_status INTEGER NOT NULL DEFAULT 1, server_rev INTEGER NOT NULL DEFAULT 0);",
                    e.name,
                    cols.join(", ")
                ),
                [],
            )?;
            // Upgrade tables created by v1 of the desktop app.
            for col in e.cols {
                add_column(&tx, e.name, &sql_decl(col))?;
            }
            add_column(&tx, e.name, "sync_status INTEGER NOT NULL DEFAULT 1")?;
            add_column(&tx, e.name, "server_rev INTEGER NOT NULL DEFAULT 0")?;
            tx.execute(&format!("CREATE INDEX IF NOT EXISTS idx_{0}_sync ON {0}(sync_status);", e.name), [])?;
            tx.execute(&format!("CREATE INDEX IF NOT EXISTS idx_{0}_upd ON {0}(updated_at);", e.name), [])?;
        }
        // Local-only reminder state (when this device last fired the alarm).
        add_column(&tx, "reminders", "fired_at INTEGER")?;
        tx.execute(&format!("PRAGMA user_version = {};", SCHEMA_VERSION), [])?;
        tx.commit()?;
        drop(conn);
        // Admin pairing token is no longer stored on devices.
        if let Ok(mut cfg) = self.get_config() {
            if !cfg.admin_token.is_empty() && !cfg.device_token.is_empty() {
                cfg.admin_token.clear();
                let _ = self.save_config(&cfg);
            }
        }
        Ok(())
    }

    // ---------------- config ----------------
    pub fn get_config(&self) -> Result<AppConfig> {
        let json: Option<String> = {
            let conn = self.conn.lock().unwrap();
            conn.query_row("SELECT value FROM config WHERE key = 'app_config';", [], |r| r.get(0)).optional()?
        };
        if let Some(s) = json {
            if let Ok(cfg) = serde_json::from_str::<AppConfig>(&s) {
                return Ok(cfg);
            }
        }
        let cfg = AppConfig::default();
        self.save_config(&cfg)?;
        Ok(cfg)
    }

    pub fn save_config(&self, cfg: &AppConfig) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO config (key, value) VALUES ('app_config', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            params![serde_json::to_string(cfg).unwrap_or_default()],
        )?;
        Ok(())
    }

    pub fn update_config<F: FnOnce(&mut AppConfig)>(&self, f: F) -> Result<AppConfig> {
        let mut cfg = self.get_config()?;
        f(&mut cfg);
        self.save_config(&cfg)?;
        Ok(cfg)
    }

    // ---------------- generic entities ----------------
    fn select_cols(spec: &EntitySpec, extra: &[&str]) -> String {
        let mut cols: Vec<&str> = vec!["id"];
        cols.extend(spec.cols.iter().map(|c| c.name));
        cols.extend(["created_at", "updated_at", "deleted", "sync_status", "server_rev"]);
        cols.extend(extra);
        cols.join(", ")
    }

    fn row_to_json(spec: &EntitySpec, row: &rusqlite::Row, extra: &[&str]) -> Result<Value> {
        let mut m = Map::new();
        m.insert("id".into(), Value::String(row.get::<_, String>(0)?));
        let mut i = 1;
        for col in spec.cols {
            let v = match col.kind {
                Kind::Text => Value::String(row.get::<_, Option<String>>(i)?.unwrap_or_default()),
                Kind::NullText | Kind::Json => row.get::<_, Option<String>>(i)?.map(Value::String).unwrap_or(Value::Null),
                Kind::Int => Value::from(row.get::<_, Option<i64>>(i)?.unwrap_or(0)),
                Kind::NullInt => row.get::<_, Option<i64>>(i)?.map(Value::from).unwrap_or(Value::Null),
                Kind::Real => Value::from(row.get::<_, Option<f64>>(i)?.unwrap_or(0.0)),
            };
            m.insert(col.name.into(), v);
            i += 1;
        }
        for name in ["created_at", "updated_at", "deleted", "sync_status", "server_rev"].iter().chain(extra.iter()) {
            m.insert((*name).into(), row.get::<_, Option<i64>>(i)?.map(Value::from).unwrap_or(Value::Null));
            i += 1;
        }
        Ok(Value::Object(m))
    }

    fn extra_cols(entity: &str) -> &'static [&'static str] {
        if entity == "reminders" {
            &["fired_at"]
        } else {
            &[]
        }
    }

    pub fn list(&self, entity: &str, include_deleted: bool) -> Result<Vec<Value>> {
        let spec = spec(entity).ok_or_else(|| rusqlite::Error::InvalidParameterName(entity.into()))?;
        let extra = Self::extra_cols(entity);
        let sql = format!(
            "SELECT {} FROM {} {} ORDER BY updated_at DESC;",
            Self::select_cols(spec, extra),
            entity,
            if include_deleted { "" } else { "WHERE deleted = 0" }
        );
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([], |r| Self::row_to_json(spec, r, extra))?;
        rows.collect()
    }

    pub fn get(&self, entity: &str, id: &str) -> Result<Option<Value>> {
        let spec = spec(entity).ok_or_else(|| rusqlite::Error::InvalidParameterName(entity.into()))?;
        let extra = Self::extra_cols(entity);
        let sql = format!("SELECT {} FROM {} WHERE id = ?1;", Self::select_cols(spec, extra), entity);
        let conn = self.conn.lock().unwrap();
        conn.query_row(&sql, params![id], |r| Self::row_to_json(spec, r, extra)).optional()
    }

    pub fn pending(&self, entity: &str) -> Result<Vec<Value>> {
        Ok(self.list(entity, true)?.into_iter().filter(|v| v["sync_status"] == 1).collect())
    }

    fn bind_value(col: &Col, v: Option<&Value>) -> rusqlite::types::Value {
        use rusqlite::types::Value as SV;
        let v = v.unwrap_or(&Value::Null);
        match col.kind {
            Kind::Text => SV::Text(match v {
                Value::Null => col.default.to_string(),
                Value::String(s) => s.clone(),
                other => other.to_string(),
            }),
            Kind::NullText => match v {
                Value::Null => SV::Null,
                Value::String(s) if s.is_empty() => SV::Null,
                Value::String(s) => SV::Text(s.clone()),
                other => SV::Text(other.to_string()),
            },
            Kind::Json => match v {
                Value::Null => SV::Null,
                Value::String(s) if s.is_empty() => SV::Null,
                Value::String(s) => SV::Text(s.clone()),
                other => SV::Text(other.to_string()),
            },
            Kind::Int => SV::Integer(json_i64(v).unwrap_or_else(|| col.default.parse().unwrap_or(0))),
            Kind::NullInt => json_i64(v).map(SV::Integer).unwrap_or(SV::Null),
            Kind::Real => SV::Real(v.as_f64().unwrap_or_else(|| col.default.parse().unwrap_or(0.0))),
        }
    }

    /// Writes a full row (values missing from `item` take the existing value or the default).
    fn write_row(&self, entity: &str, item: &Map<String, Value>, sync_status: i64, server_rev: i64) -> Result<()> {
        let spec = spec(entity).ok_or_else(|| rusqlite::Error::InvalidParameterName(entity.into()))?;
        let mut names: Vec<&str> = vec!["id"];
        let mut vals: Vec<rusqlite::types::Value> = vec![rusqlite::types::Value::Text(item["id"].as_str().unwrap_or_default().to_string())];
        for col in spec.cols {
            names.push(col.name);
            vals.push(Self::bind_value(col, item.get(col.name)));
        }
        for n in ["created_at", "updated_at", "deleted"] {
            names.push(n);
            vals.push(rusqlite::types::Value::Integer(item.get(n).and_then(json_i64).unwrap_or(0)));
        }
        names.push("sync_status");
        vals.push(rusqlite::types::Value::Integer(sync_status));
        names.push("server_rev");
        vals.push(rusqlite::types::Value::Integer(server_rev));
        let placeholders: Vec<String> = (1..=names.len()).map(|i| format!("?{}", i)).collect();
        let updates: Vec<String> = names.iter().filter(|n| **n != "id").map(|n| format!("{0} = excluded.{0}", n)).collect();
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT(id) DO UPDATE SET {};",
            entity,
            names.join(", "),
            placeholders.join(", "),
            updates.join(", ")
        );
        let conn = self.conn.lock().unwrap();
        conn.execute(&sql, params_from_iter(vals))?;
        Ok(())
    }

    /// Local edit from the UI: merges with the existing row, stamps updated_at and marks
    /// it pending so the sync engine pushes it.
    pub fn save_local(&self, entity: &str, patch: &Value) -> Result<Value> {
        let spec = spec(entity).ok_or_else(|| rusqlite::Error::InvalidParameterName(entity.into()))?;
        let now = now_ms();
        let id = patch.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(String::from);
        let existing = match &id {
            Some(i) => self.get(entity, i)?,
            None => None,
        };
        let mut row: Map<String, Value> = match &existing {
            Some(Value::Object(m)) => m.clone(),
            _ => Map::new(),
        };
        if let Value::Object(p) = patch {
            for (k, v) in p {
                if spec.cols.iter().any(|c| c.name == k) || k == "deleted" {
                    row.insert(k.clone(), v.clone());
                }
            }
        }
        let id = id.unwrap_or_else(|| format!("{}_{}", spec.prefix, uuid::Uuid::new_v4().simple()));
        row.insert("id".into(), Value::String(id.clone()));
        if existing.is_none() {
            row.insert("created_at".into(), Value::from(patch.get("created_at").and_then(json_i64).unwrap_or(now)));
        }
        // Monotonic per row even if the clock moved backwards.
        let prev = row.get("updated_at").and_then(json_i64).unwrap_or(0);
        row.insert("updated_at".into(), Value::from(std::cmp::max(now, prev + 1)));
        if !row.contains_key("deleted") {
            row.insert("deleted".into(), Value::from(0));
        }
        let server_rev = row.get("server_rev").and_then(json_i64).unwrap_or(0);
        self.write_row(entity, &row, 1, server_rev)?;
        Ok(self.get(entity, &id)?.unwrap_or(Value::Null))
    }

    pub fn delete_local(&self, entity: &str, id: &str) -> Result<bool> {
        if self.get(entity, id)?.is_none() {
            return Ok(false);
        }
        self.save_local(entity, &serde_json::json!({"id": id, "deleted": 1}))?;
        Ok(true)
    }

    /// Server acknowledged our push of `id` with revision `rev`. If the row was not edited
    /// again while the request was in flight it becomes synced.
    pub fn ack(&self, entity: &str, id: &str, rev: i64, pushed_updated_at: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            &format!(
                "UPDATE {} SET server_rev = ?1, sync_status = CASE WHEN updated_at = ?2 THEN 0 ELSE sync_status END WHERE id = ?3;",
                entity
            ),
            params![rev, pushed_updated_at, id],
        )?;
        Ok(())
    }

    /// Applies a row received from the server. A pending local edit is kept (it will be
    /// pushed and resolved by the server) unless `force` (the server explicitly kept its
    /// version in a conflict).
    pub fn apply_remote(&self, entity: &str, row: &Value, force: bool) -> Result<bool> {
        let id = match row.get("id").and_then(|v| v.as_str()) {
            Some(i) => i.to_string(),
            None => return Ok(false),
        };
        if let Some(local) = self.get(entity, &id)? {
            if local["sync_status"] == 1 && !force {
                // Remember the server revision so our next push is recognised as a merge.
                let rev = row.get("server_rev").and_then(json_i64).unwrap_or(0);
                let conn = self.conn.lock().unwrap();
                conn.execute(&format!("UPDATE {} SET server_rev = MAX(server_rev, ?1) WHERE id = ?2;", entity), params![rev, id])?;
                return Ok(false);
            }
        }
        let map = match row {
            Value::Object(m) => m.clone(),
            _ => return Ok(false),
        };
        let rev = map.get("server_rev").and_then(json_i64).unwrap_or(0);
        self.write_row(entity, &map, 0, rev)?;
        Ok(true)
    }

    /// Updates a reminder's local-only alarm state (not synchronized).
    pub fn set_reminder_fired(&self, id: &str, fired_at: Option<i64>) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE reminders SET fired_at = ?1 WHERE id = ?2;", params![fired_at, id])?;
        Ok(())
    }

    // ---------------- transfers ----------------
    pub fn get_transfers(&self) -> Result<Vec<TransferRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, filename, file_size, direction, peer_device, status, speed_mbps, sha256, timestamp FROM transfers ORDER BY timestamp DESC LIMIT 200;",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(TransferRecord {
                id: row.get(0)?,
                filename: row.get(1)?,
                file_size: row.get(2)?,
                direction: row.get(3)?,
                peer_device: row.get(4)?,
                status: row.get(5)?,
                speed_mbps: row.get(6)?,
                sha256: row.get(7)?,
                timestamp: row.get(8)?,
            })
        })?;
        rows.collect()
    }

    pub fn add_transfer(&self, tr: &TransferRecord) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"INSERT INTO transfers (id, filename, file_size, direction, peer_device, status, speed_mbps, sha256, timestamp)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
               ON CONFLICT(id) DO UPDATE SET status = excluded.status, speed_mbps = excluded.speed_mbps,
               sha256 = excluded.sha256, file_size = excluded.file_size;"#,
            params![tr.id, tr.filename, tr.file_size, tr.direction, tr.peer_device, tr.status, tr.speed_mbps, tr.sha256, tr.timestamp],
        )?;
        Ok(())
    }

    pub fn clear_transfers(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM transfers;", [])?;
        Ok(())
    }

    // ---------------- chat ----------------
    pub fn get_chat_history(&self, session_id: &str) -> Result<Vec<ChatMessageRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, role, content, timestamp FROM chat_messages WHERE session_id = ?1 ORDER BY timestamp ASC;",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(ChatMessageRecord { id: row.get(0)?, session_id: row.get(1)?, role: row.get(2)?, content: row.get(3)?, timestamp: row.get(4)? })
        })?;
        rows.collect()
    }

    pub fn add_chat_message(&self, msg: &ChatMessageRecord) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?1, ?2, ?3, ?4, ?5);",
            params![msg.id, msg.session_id, msg.role, msg.content, msg.timestamp],
        )?;
        Ok(())
    }

    pub fn get_chat_sessions(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT session_id FROM chat_messages GROUP BY session_id ORDER BY MAX(timestamp) DESC;")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        rows.collect()
    }

    pub fn delete_chat_session(&self, session_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM chat_messages WHERE session_id = ?1;", params![session_id])?;
        Ok(())
    }
}

pub fn json_i64(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::Bool(b) => Some(*b as i64),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp_db(name: &str) -> (Database, PathBuf) {
        let dir = std::env::temp_dir().join(format!("cahangir_test_{}_{}", name, uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("cahangir_desktop.db");
        (Database::open(&p).unwrap(), dir)
    }

    #[test]
    fn migrates_v1_database_preserving_data_and_backs_up() {
        let dir = std::env::temp_dir().join(format!("cahangir_mig_{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("cahangir_desktop.db");
        {
            let conn = Connection::open(&p).unwrap();
            conn.execute_batch(r#"
                CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE reminders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default', text TEXT NOT NULL, due INTEGER, snooze INTEGER,
                    done INTEGER NOT NULL DEFAULT 0, timer INTEGER NOT NULL DEFAULT 0, repeat TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                    deleted INTEGER NOT NULL DEFAULT 0, sync_status INTEGER NOT NULL DEFAULT 1);
                INSERT INTO reminders (id, text, due, created_at, updated_at, sync_status) VALUES ('r1', 'Old', 5, 1, 2, 0);
                INSERT INTO config VALUES ('app_config', '{"server_url":"http://10.0.0.2:8000","admin_token":"secret","device_token":"cg_x","device_id":"win_1","device_name":"PC","p2p_port":8767,"download_dir":"/tmp","clipboard_sync_enabled":true,"auto_start":false,"minimize_to_tray":true,"theme":"dark","language":"az","last_sync_time":7}');
            "#).unwrap();
        }
        let db = Database::open(&p).unwrap();
        let r = db.get("reminders", "r1").unwrap().unwrap();
        assert_eq!(r["text"], "Old");
        assert_eq!(r["kind"], "custom");
        assert_eq!(r["sync_status"], 0);
        let cfg = db.get_config().unwrap();
        assert_eq!(cfg.device_token, "cg_x");
        assert_eq!(cfg.server_url, "http://10.0.0.2:8000");
        assert_eq!(cfg.auto_sync_minutes, 5);
        assert!(cfg.admin_token.is_empty(), "admin token must no longer be stored");
        assert!(std::fs::read_dir(&dir).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().contains("pre_v2")));
        assert!(db.list("tasks", false).unwrap().is_empty());
        // Re-opening does not migrate/back up again.
        let backups = || std::fs::read_dir(&dir).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().contains("pre_v")).count();
        assert_eq!(backups(), 1);
        drop(db);
        Database::open(&p).unwrap();
        assert_eq!(backups(), 1);
    }

    #[test]
    fn save_update_delete_ack_and_remote_apply() {
        let (db, _d) = tmp_db("crud");
        let t = db.save_local("tasks", &json!({"title": "Assignment", "estimated_minutes": 120, "priority": "high"})).unwrap();
        let id = t["id"].as_str().unwrap().to_string();
        assert!(id.starts_with("tsk_"));
        assert_eq!(t["sync_status"], 1);
        assert_eq!(t["status"], "todo");
        let t2 = db.save_local("tasks", &json!({"id": id, "status": "done"})).unwrap();
        assert_eq!(t2["title"], "Assignment"); // partial update keeps other fields
        assert!(t2["updated_at"].as_i64() > t["updated_at"].as_i64());
        db.ack("tasks", &id, 42, t2["updated_at"].as_i64().unwrap()).unwrap();
        let t3 = db.get("tasks", &id).unwrap().unwrap();
        assert_eq!(t3["sync_status"], 0);
        assert_eq!(t3["server_rev"], 42);
        // Stale ack (row edited again) keeps it pending.
        let t4 = db.save_local("tasks", &json!({"id": id, "title": "Edited"})).unwrap();
        db.ack("tasks", &id, 43, t3["updated_at"].as_i64().unwrap()).unwrap();
        assert_eq!(db.get("tasks", &id).unwrap().unwrap()["sync_status"], 1);
        // Remote row does not overwrite a pending local edit unless forced.
        let remote = json!({"id": id, "title": "Server", "updated_at": 1, "created_at": 1, "deleted": 0, "server_rev": 50});
        assert!(!db.apply_remote("tasks", &remote, false).unwrap());
        assert_eq!(db.get("tasks", &id).unwrap().unwrap()["title"], "Edited");
        assert_eq!(db.get("tasks", &id).unwrap().unwrap()["server_rev"], 50);
        assert!(db.apply_remote("tasks", &remote, true).unwrap());
        assert_eq!(db.get("tasks", &id).unwrap().unwrap()["title"], "Server");
        let _ = t4;
        assert!(db.delete_local("tasks", &id).unwrap());
        assert!(db.list("tasks", false).unwrap().is_empty());
        assert_eq!(db.list("tasks", true).unwrap()[0]["deleted"], 1);
    }

    #[test]
    fn json_objects_stored_as_text() {
        let (db, _d) = tmp_db("json");
        let r = db.save_local("reminders", &json!({"text": "Daily", "due": 1000, "repeat": {"type": "daily"}})).unwrap();
        assert_eq!(r["repeat"], "{\"type\":\"daily\"}");
        assert_eq!(r["fired_at"], Value::Null);
    }
}
