"""Schema migration (v1 -> v2) preserves data and is preceded by a backup; backup/restore."""
import sqlite3

import app.backup as backup
import app.config as config
import app.database as database


def _make_v1_db(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);")
    database._apply_migration_v1(conn)
    conn.execute("INSERT INTO schema_version VALUES (1, 1);")
    conn.execute("INSERT INTO devices VALUES ('old_phone', 'Galaxy', 'h', 1, 1, 0);")
    conn.execute("INSERT INTO reminders (id, text, due, created_at, updated_at) VALUES ('1', 'Old reminder', 1730000000000, 5, 50);")
    conn.execute("INSERT INTO reminders (id, text, due, created_at, updated_at) VALUES ('2', 'Older reminder', 1730000000000, 5, 20);")
    conn.execute("INSERT INTO memories (id, fact_text, created_at, updated_at) VALUES ('m1', 'Fact', 5, 30);")
    conn.execute("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p1', 'Proj', 5, 40);")
    conn.commit()
    conn.close()


def test_v1_to_v2_migration_preserves_data(tmp_path, monkeypatch):
    db = str(tmp_path / "legacy.db")
    bk = tmp_path / "bk"
    bk.mkdir()
    _make_v1_db(db)
    monkeypatch.setattr(database, "DB_PATH", db)
    monkeypatch.setattr(database, "BACKUP_DIR", bk)
    database.init_db()
    backups = list(bk.glob("pre_migration_v1_to_v2_*.db"))
    assert len(backups) == 1
    # The backup is the untouched v1 database.
    b = sqlite3.connect(str(backups[0]))
    assert b.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] == 1
    b.close()

    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    assert conn.execute("SELECT MAX(version) FROM schema_version").fetchone()[0] == 2
    rems = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM reminders")}
    assert rems["1"]["text"] == "Old reminder" and rems["1"]["updated_at"] == 50 and rems["1"]["kind"] == "custom"
    # Revisions assigned in updated_at order across the table.
    assert 0 < rems["2"]["server_rev"] < rems["1"]["server_rev"]
    assert conn.execute("SELECT fact_text FROM memories WHERE id='m1'").fetchone()[0] == "Fact"
    assert conn.execute("SELECT device_name FROM devices WHERE device_id='old_phone'").fetchone()[0] == "Galaxy"
    for t in ("tasks", "events", "plan_blocks", "clipboard_items", "sync_conflicts", "ai_usage", "sync_meta"):
        conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()
    assert len(conn.execute("SELECT value FROM sync_meta WHERE key='mesh_key'").fetchone()[0]) == 64
    conn.close()

    # Running init again is a no-op (idempotent, no extra backup).
    database.init_db()
    assert len(list(bk.glob("pre_migration_*.db"))) == 1


def test_backup_and_restore_roundtrip(tmp_path, monkeypatch):
    db = str(tmp_path / "live.db")
    bk = tmp_path / "bk"
    bk.mkdir()
    for mod in (database, backup):
        monkeypatch.setattr(mod, "DB_PATH", db)
        monkeypatch.setattr(mod, "BACKUP_DIR", bk)
    database.init_db()
    with database.get_db() as conn:
        conn.execute("INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t1', 'Keep me', 1, 1);")
    path = backup.create_backup()
    with database.get_db() as conn:
        conn.execute("DELETE FROM tasks;")
    safety = backup.restore_backup(path)
    with database.get_db() as conn:
        assert conn.execute("SELECT title FROM tasks WHERE id='t1'").fetchone()[0] == "Keep me"
    # The pre-restore state was preserved too (restore is undoable).
    s = sqlite3.connect(safety)
    assert s.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0
    s.close()


def test_backup_rotation(tmp_path, monkeypatch):
    db = str(tmp_path / "rot.db")
    bk = tmp_path / "bk"
    bk.mkdir()
    for mod in (database, backup):
        monkeypatch.setattr(mod, "DB_PATH", db)
        monkeypatch.setattr(mod, "BACKUP_DIR", bk)
    database.init_db()
    for _ in range(5):
        backup.create_backup(keep=3)
    assert len(list(bk.glob("cahangir_backup_*.db"))) == 3
