use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub server_url: String,
    pub admin_token: String,
    pub device_token: String,
    pub device_id: String,
    pub device_name: String,
    pub p2p_port: u16,
    pub download_dir: String,
    pub clipboard_sync_enabled: bool,
    pub auto_start: bool,
    pub minimize_to_tray: bool,
    pub theme: String,
    pub language: String,
    pub last_sync_time: i64,
}

impl Default for AppConfig {
    fn default() -> Self {
        let default_download = dirs::download_dir()
            .unwrap_or_else(|| PathBuf::from("C:\\Users\\Public\\Downloads"))
            .to_string_lossy()
            .to_string();

        Self {
            server_url: "http://100.114.91.32:8766".to_string(),
            admin_token: "".to_string(),
            device_token: "".to_string(),
            device_id: format!("win_{}", uuid::Uuid::new_v4().simple()),
            device_name: "Cahangir Windows Desktop".to_string(),
            p2p_port: 8767,
            download_dir: default_download,
            clipboard_sync_enabled: true,
            auto_start: false,
            minimize_to_tray: true,
            theme: "dark".to_string(),
            language: "az".to_string(),
            last_sync_time: 0,
        }
    }
}

mod dirs {
    use std::path::PathBuf;
    pub fn download_dir() -> Option<PathBuf> {
        std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("Downloads"))
    }
    pub fn data_dir() -> PathBuf {
        let base = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        let dir = base.join("CahangirDesktop");
        let _ = std::fs::create_dir_all(&dir);
        dir
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRecord {
    pub id: String,
    pub user_id: String,
    pub category: String,
    pub fact_text: String,
    pub confidence: f64,
    pub source: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted: i64,
    pub sync_status: i64, // 0 = synced, 1 = pending
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReminderRecord {
    pub id: String,
    pub user_id: String,
    pub text: String,
    pub due: Option<i64>,
    pub snooze: Option<i64>,
    pub done: i64,
    pub timer: i64,
    pub repeat: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted: i64,
    pub sync_status: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRecord {
    pub id: String,
    pub user_id: String,
    pub title: String,
    pub status: String,
    pub notes: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted: i64,
    pub sync_status: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferRecord {
    pub id: String,
    pub filename: String,
    pub file_size: i64,
    pub direction: String, // "send" or "receive"
    pub peer_device: String,
    pub status: String, // "completed", "failed", "in_progress", "canceled"
    pub speed_mbps: f64,
    pub sha256: String,
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessageRecord {
    pub id: String,
    pub session_id: String,
    pub role: String, // "user" or "assistant"
    pub content: String,
    pub timestamp: i64,
}

#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    pub fn init() -> Result<Self> {
        let db_path = dirs::data_dir().join("cahangir_desktop.db");
        let conn = Connection::open(&db_path)?;

        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;

            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL DEFAULT 'default',
                category TEXT NOT NULL DEFAULT 'general',
                fact_text TEXT NOT NULL,
                confidence REAL NOT NULL DEFAULT 1.0,
                source TEXT NOT NULL DEFAULT 'user',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0,
                sync_status INTEGER NOT NULL DEFAULT 1
            );
            CREATE INDEX IF NOT EXISTS idx_mem_up ON memories(updated_at);
            CREATE INDEX IF NOT EXISTS idx_mem_del ON memories(deleted);

            CREATE TABLE IF NOT EXISTS reminders (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL DEFAULT 'default',
                text TEXT NOT NULL,
                due INTEGER,
                snooze INTEGER,
                done INTEGER NOT NULL DEFAULT 0,
                timer INTEGER NOT NULL DEFAULT 0,
                repeat TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0,
                sync_status INTEGER NOT NULL DEFAULT 1
            );
            CREATE INDEX IF NOT EXISTS idx_rem_up ON reminders(updated_at);
            CREATE INDEX IF NOT EXISTS idx_rem_done ON reminders(done);

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL DEFAULT 'default',
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                notes TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0,
                sync_status INTEGER NOT NULL DEFAULT 1
            );
            CREATE INDEX IF NOT EXISTS idx_prj_up ON projects(updated_at);

            CREATE TABLE IF NOT EXISTS transfers (
                id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                direction TEXT NOT NULL,
                peer_device TEXT NOT NULL,
                status TEXT NOT NULL,
                speed_mbps REAL NOT NULL DEFAULT 0.0,
                sha256 TEXT NOT NULL DEFAULT '',
                timestamp INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chat_messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_chat_sess ON chat_messages(session_id);
            "#,
        )?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    // --- Config Operations ---
    pub fn get_config(&self) -> Result<AppConfig> {
        let opt_json: Option<String> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT value FROM config WHERE key = 'app_config';")?;
            let mut rows = stmt.query([])?;
            if let Some(row) = rows.next()? {
                Some(row.get(0)?)
            } else {
                None
            }
        };

        if let Some(json_str) = opt_json {
            if let Ok(cfg) = serde_json::from_str(&json_str) {
                return Ok(cfg);
            }
        }

        let default_cfg = AppConfig::default();
        self.save_config(&default_cfg)?;
        Ok(default_cfg)
    }

    pub fn save_config(&self, cfg: &AppConfig) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let json_str = serde_json::to_string(cfg).unwrap_or_default();
        conn.execute(
            "INSERT INTO config (key, value) VALUES ('app_config', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            params![json_str],
        )?;
        Ok(())
    }

    // --- Memories Operations ---
    pub fn get_memories(&self, include_deleted: bool) -> Result<Vec<MemoryRecord>> {
        let conn = self.conn.lock().unwrap();
        let query = if include_deleted {
            "SELECT id, user_id, category, fact_text, confidence, source, created_at, updated_at, deleted, sync_status FROM memories ORDER BY updated_at DESC;"
        } else {
            "SELECT id, user_id, category, fact_text, confidence, source, created_at, updated_at, deleted, sync_status FROM memories WHERE deleted = 0 ORDER BY updated_at DESC;"
        };
        let mut stmt = conn.prepare(query)?;
        let rows = stmt.query_map([], |row| {
            Ok(MemoryRecord {
                id: row.get(0)?,
                user_id: row.get(1)?,
                category: row.get(2)?,
                fact_text: row.get(3)?,
                confidence: row.get(4)?,
                source: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                deleted: row.get(8)?,
                sync_status: row.get(9)?,
            })
        })?;
        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn upsert_memory(&self, mem: &MemoryRecord) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO memories (id, user_id, category, fact_text, confidence, source, created_at, updated_at, deleted, sync_status)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(id) DO UPDATE SET
                category = excluded.category,
                fact_text = excluded.fact_text,
                confidence = excluded.confidence,
                source = excluded.source,
                updated_at = excluded.updated_at,
                deleted = excluded.deleted,
                sync_status = excluded.sync_status;
            "#,
            params![
                mem.id, mem.user_id, mem.category, mem.fact_text, mem.confidence,
                mem.source, mem.created_at, mem.updated_at, mem.deleted, mem.sync_status
            ],
        )?;
        Ok(())
    }

    // --- Reminders Operations ---
    pub fn get_reminders(&self, include_deleted: bool) -> Result<Vec<ReminderRecord>> {
        let conn = self.conn.lock().unwrap();
        let query = if include_deleted {
            "SELECT id, user_id, text, due, snooze, done, timer, repeat, created_at, updated_at, deleted, sync_status FROM reminders ORDER BY CASE WHEN snooze IS NOT NULL THEN snooze ELSE due END ASC;"
        } else {
            "SELECT id, user_id, text, due, snooze, done, timer, repeat, created_at, updated_at, deleted, sync_status FROM reminders WHERE deleted = 0 ORDER BY CASE WHEN snooze IS NOT NULL THEN snooze ELSE due END ASC;"
        };
        let mut stmt = conn.prepare(query)?;
        let rows = stmt.query_map([], |row| {
            Ok(ReminderRecord {
                id: row.get(0)?,
                user_id: row.get(1)?,
                text: row.get(2)?,
                due: row.get(3)?,
                snooze: row.get(4)?,
                done: row.get(5)?,
                timer: row.get(6)?,
                repeat: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
                deleted: row.get(10)?,
                sync_status: row.get(11)?,
            })
        })?;
        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn upsert_reminder(&self, rem: &ReminderRecord) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO reminders (id, user_id, text, due, snooze, done, timer, repeat, created_at, updated_at, deleted, sync_status)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ON CONFLICT(id) DO UPDATE SET
                text = excluded.text,
                due = excluded.due,
                snooze = excluded.snooze,
                done = excluded.done,
                timer = excluded.timer,
                repeat = excluded.repeat,
                updated_at = excluded.updated_at,
                deleted = excluded.deleted,
                sync_status = excluded.sync_status;
            "#,
            params![
                rem.id, rem.user_id, rem.text, rem.due, rem.snooze, rem.done,
                rem.timer, rem.repeat, rem.created_at, rem.updated_at, rem.deleted, rem.sync_status
            ],
        )?;
        Ok(())
    }

    // --- Projects Operations ---
    pub fn get_projects(&self, include_deleted: bool) -> Result<Vec<ProjectRecord>> {
        let conn = self.conn.lock().unwrap();
        let query = if include_deleted {
            "SELECT id, user_id, title, status, notes, created_at, updated_at, deleted, sync_status FROM projects ORDER BY updated_at DESC;"
        } else {
            "SELECT id, user_id, title, status, notes, created_at, updated_at, deleted, sync_status FROM projects WHERE deleted = 0 ORDER BY updated_at DESC;"
        };
        let mut stmt = conn.prepare(query)?;
        let rows = stmt.query_map([], |row| {
            Ok(ProjectRecord {
                id: row.get(0)?,
                user_id: row.get(1)?,
                title: row.get(2)?,
                status: row.get(3)?,
                notes: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                deleted: row.get(7)?,
                sync_status: row.get(8)?,
            })
        })?;
        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn upsert_project(&self, prj: &ProjectRecord) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO projects (id, user_id, title, status, notes, created_at, updated_at, deleted, sync_status)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                status = excluded.status,
                notes = excluded.notes,
                updated_at = excluded.updated_at,
                deleted = excluded.deleted,
                sync_status = excluded.sync_status;
            "#,
            params![
                prj.id, prj.user_id, prj.title, prj.status, prj.notes,
                prj.created_at, prj.updated_at, prj.deleted, prj.sync_status
            ],
        )?;
        Ok(())
    }

    // --- Transfers Operations ---
    pub fn get_transfers(&self) -> Result<Vec<TransferRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, filename, file_size, direction, peer_device, status, speed_mbps, sha256, timestamp FROM transfers ORDER BY timestamp DESC LIMIT 100;"
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
        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn add_transfer(&self, tr: &TransferRecord) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO transfers (id, filename, file_size, direction, peer_device, status, speed_mbps, sha256, timestamp)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(id) DO UPDATE SET
                status = excluded.status,
                speed_mbps = excluded.speed_mbps,
                sha256 = excluded.sha256;
            "#,
            params![
                tr.id, tr.filename, tr.file_size, tr.direction,
                tr.peer_device, tr.status, tr.speed_mbps, tr.sha256, tr.timestamp
            ],
        )?;
        Ok(())
    }

    // --- Chat Messages Operations ---
    pub fn get_chat_history(&self, session_id: &str) -> Result<Vec<ChatMessageRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, role, content, timestamp FROM chat_messages WHERE session_id = ?1 ORDER BY timestamp ASC;"
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok(ChatMessageRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                timestamp: row.get(4)?,
            })
        })?;
        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
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
        let mut stmt = conn.prepare(
            "SELECT DISTINCT session_id FROM chat_messages ORDER BY timestamp DESC;"
        )?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        let mut list = Vec::new();
        for r in rows {
            list.push(r?);
        }
        Ok(list)
    }

    pub fn delete_chat_session(&self, session_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM chat_messages WHERE session_id = ?1;", params![session_id])?;
        Ok(())
    }
}
