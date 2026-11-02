import sqlite3
import time
from contextlib import contextmanager
from app.config import DB_PATH

CURRENT_SCHEMA_VERSION = 1


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=10.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


@contextmanager
def get_db():
    conn = get_connection()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            );
            """
        )

        cur = conn.execute("SELECT MAX(version) FROM schema_version;")
        row = cur.fetchone()
        current_version = row[0] if (row and row[0] is not None) else 0

        if current_version < 1:
            _apply_migration_v1(conn)
            conn.execute(
                "INSERT INTO schema_version (version, applied_at) VALUES (?, ?);",
                (1, int(time.time() * 1000)),
            )


def _apply_migration_v1(conn: sqlite3.Connection):
    # 1. Devices & Authentication
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS devices (
            device_id TEXT PRIMARY KEY,
            device_name TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            is_revoked INTEGER NOT NULL DEFAULT 0
        );
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(token_hash);")

    # 2. Memories / Facts
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL DEFAULT 'default',
            category TEXT NOT NULL DEFAULT 'general',
            fact_text TEXT NOT NULL,
            confidence REAL NOT NULL DEFAULT 1.0,
            source TEXT NOT NULL DEFAULT 'user',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0
        );
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_memories_deleted ON memories(deleted);")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);")

    # 3. Reminders & Timers
    conn.execute(
        """
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
            deleted INTEGER NOT NULL DEFAULT 0
        );
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reminders_updated ON reminders(updated_at);")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reminders_deleted ON reminders(deleted);")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due);")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_reminders_done ON reminders(done);")

    # 4. Projects & Tasks
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL DEFAULT 'default',
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            notes TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0
        );
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at);")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_projects_deleted ON projects(deleted);")

    # 5. Sync activity audit log
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sync_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT NOT NULL,
            action TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            timestamp INTEGER NOT NULL
        );
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_sync_log_time ON sync_log(timestamp);")
