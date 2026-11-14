import logging
import secrets
import shutil
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from app.config import BACKUP_DIR, DB_PATH

logger = logging.getLogger("cahangir.db")

CURRENT_SCHEMA_VERSION = 2


def now_ms() -> int:
    return int(time.time() * 1000)


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=15.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA busy_timeout = 15000;")
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


def next_rev(conn: sqlite3.Connection) -> int:
    """Monotonic server revision counter. Taking it acquires the SQLite write lock,
    so revisions are strictly ordered across concurrent requests."""
    row = conn.execute(
        "UPDATE sync_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'rev' RETURNING value;"
    ).fetchone()
    return int(row[0])


def current_rev(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT value FROM sync_meta WHERE key = 'rev';").fetchone()
    return int(row[0]) if row else 0


def get_meta(conn: sqlite3.Connection, key: str, default=None):
    row = conn.execute("SELECT value FROM sync_meta WHERE key = ?;", (key,)).fetchone()
    return row[0] if row else default


def set_meta(conn: sqlite3.Connection, key: str, value: str):
    conn.execute(
        "INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
        (key, value),
    )


def schema_version(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT MAX(version) FROM schema_version;").fetchone()
    return row[0] if (row and row[0] is not None) else 0


def _pre_migration_backup(from_version: int):
    """Copy the database (consistent snapshot via the SQLite backup API) before any
    schema change touches existing user data."""
    db_file = Path(DB_PATH)
    if not db_file.exists() or db_file.stat().st_size == 0:
        return None
    stamp = time.strftime("%Y%m%d_%H%M%S")
    dest = BACKUP_DIR / f"pre_migration_v{from_version}_to_v{CURRENT_SCHEMA_VERSION}_{stamp}.db"
    src = sqlite3.connect(DB_PATH)
    dst = sqlite3.connect(str(dest))
    try:
        with dst:
            src.backup(dst)
    finally:
        dst.close()
        src.close()
    logger.info("Pre-migration backup written to %s", dest)
    return str(dest)


def init_db():
    with get_db() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);"
        )
        version = schema_version(conn)

    if 0 < version < CURRENT_SCHEMA_VERSION:
        _pre_migration_backup(version)

    with get_db() as conn:
        version = schema_version(conn)
        if version < 1:
            _apply_migration_v1(conn)
            conn.execute("INSERT INTO schema_version (version, applied_at) VALUES (1, ?);", (now_ms(),))
        if version < 2:
            _apply_migration_v2(conn)
            conn.execute("INSERT INTO schema_version (version, applied_at) VALUES (2, ?);", (now_ms(),))


def _columns(conn, table):
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table});").fetchall()}


def _add_column(conn, table, coldef):
    name = coldef.split()[0]
    if name not in _columns(conn, table):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {coldef};")


def _apply_migration_v1(conn: sqlite3.Connection):
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


def _apply_migration_v2(conn: sqlite3.Connection):
    """v2: revision-based sync, planner entities, clipboard, device P2P metadata,
    conflict log, AI usage tracking. Purely additive: no existing column or row is
    removed or rewritten except for assigning initial revisions."""
    from app.entities import ENTITIES, create_table_sql

    conn.execute("CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
    conn.execute("INSERT OR IGNORE INTO sync_meta (key, value) VALUES ('rev', '0');")
    if get_meta(conn, "mesh_key") is None:
        set_meta(conn, "mesh_key", secrets.token_hex(32))
        set_meta(conn, "mesh_key_id", "1")

    # Legacy tables: new optional columns.
    _add_column(conn, "reminders", "task_id TEXT")
    _add_column(conn, "reminders", "event_id TEXT")
    _add_column(conn, "reminders", "kind TEXT NOT NULL DEFAULT 'custom'")

    # New tables.
    for name, spec in ENTITIES.items():
        if not spec.legacy:
            conn.execute(create_table_sql(name, spec))

    # Revision + origin columns on every synced table, then backfill revisions in
    # updated_at order so existing data is delivered to new-protocol clients.
    for name in ENTITIES:
        _add_column(conn, name, "server_rev INTEGER NOT NULL DEFAULT 0")
        _add_column(conn, name, "origin_device TEXT NOT NULL DEFAULT ''")
        conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{name}_rev ON {name}(server_rev);")
        ids = [r[0] for r in conn.execute(f"SELECT id FROM {name} WHERE server_rev = 0 ORDER BY updated_at, id;")]
        for entity_id in ids:
            conn.execute(f"UPDATE {name} SET server_rev = ? WHERE id = ?;", (next_rev(conn), entity_id))

    _add_column(conn, "devices", "platform TEXT NOT NULL DEFAULT ''")
    _add_column(conn, "devices", "app_version TEXT NOT NULL DEFAULT ''")
    _add_column(conn, "devices", "p2p_hosts TEXT NOT NULL DEFAULT ''")
    _add_column(conn, "devices", "p2p_port INTEGER NOT NULL DEFAULT 0")
    _add_column(conn, "devices", "last_sync_at INTEGER NOT NULL DEFAULT 0")

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sync_conflicts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            winner TEXT NOT NULL,
            kept_json TEXT NOT NULL,
            discarded_json TEXT NOT NULL,
            reason TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            resolved INTEGER NOT NULL DEFAULT 0
        );
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_conflicts_open ON sync_conflicts(resolved, created_at);")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ai_usage (
            provider TEXT NOT NULL,
            day TEXT NOT NULL,
            requests INTEGER NOT NULL DEFAULT 0,
            failures INTEGER NOT NULL DEFAULT 0,
            prompt_tokens INTEGER NOT NULL DEFAULT 0,
            completion_tokens INTEGER NOT NULL DEFAULT 0,
            last_error TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (provider, day)
        );
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ai_provider_state (
            provider TEXT PRIMARY KEY,
            cooldown_until INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'ok',
            detail TEXT NOT NULL DEFAULT ''
        );
        """
    )
