"""SQLite backups using the online backup API (consistent snapshot while running).

CLI:
  python -m app.backup create
  python -m app.backup list
  python -m app.backup restore <backup-file>   # stop the service first!
"""
import logging
import shutil
import sqlite3
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from app.config import BACKUP_DIR, BACKUP_INTERVAL_HOURS, BACKUP_KEEP, DB_PATH

logger = logging.getLogger("cahangir.backup")
_lock = threading.Lock()


def create_backup(keep: int = BACKUP_KEEP) -> str:
    with _lock:
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        backup_file = BACKUP_DIR / f"cahangir_backup_{stamp}.db"
        src = sqlite3.connect(DB_PATH)
        dest = sqlite3.connect(str(backup_file))
        try:
            with dest:
                src.backup(dest, pages=256, sleep=0.005)
            ok = dest.execute("PRAGMA integrity_check;").fetchone()[0]
            if ok != "ok":
                raise RuntimeError(f"Backup integrity check failed: {ok}")
        finally:
            dest.close()
            src.close()
        logger.info("Backup created: %s", backup_file.name)
        _rotate_backups(keep)
        return str(backup_file)


def list_backups() -> List[dict]:
    files = sorted(BACKUP_DIR.glob("*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
    return [{"file": p.name, "size_bytes": p.stat().st_size, "created_at": int(p.stat().st_mtime * 1000)} for p in files]


def latest_backup_time() -> Optional[int]:
    files = list(BACKUP_DIR.glob("cahangir_backup_*.db"))
    if not files:
        return None
    return int(max(p.stat().st_mtime for p in files) * 1000)


def _rotate_backups(keep: int):
    backups = sorted(BACKUP_DIR.glob("cahangir_backup_*.db"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in backups[keep:]:
        try:
            old.unlink()
        except OSError as e:
            logger.warning("Could not remove old backup %s: %s", old, e)


def restore_backup(backup_path: str) -> str:
    """Replace the live DB with a backup. The current DB is first saved as a backup so
    a restore can always be undone. Run only while the service is stopped."""
    src_path = Path(backup_path)
    if not src_path.is_absolute():
        src_path = BACKUP_DIR / src_path
    if not src_path.exists():
        raise FileNotFoundError(src_path)
    chk = sqlite3.connect(str(src_path))
    try:
        if chk.execute("PRAGMA integrity_check;").fetchone()[0] != "ok":
            raise RuntimeError("Backup file failed integrity check; refusing to restore.")
    finally:
        chk.close()
    safety = None
    if Path(DB_PATH).exists():
        safety = create_backup(keep=max(BACKUP_KEEP, 1) + 1)
    for suffix in ("-wal", "-shm"):
        p = Path(DB_PATH + suffix)
        if p.exists():
            p.unlink()
    shutil.copy2(src_path, DB_PATH)
    return safety or ""


class AutoBackup:
    """Background thread: backs up when the newest backup is older than the interval."""

    def __init__(self, interval_hours: float = BACKUP_INTERVAL_HOURS):
        self.interval_ms = int(interval_hours * 3600 * 1000)
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self):
        if self.interval_ms <= 0:
            return
        self._thread = threading.Thread(target=self._run, name="cahangir-autobackup", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        while not self._stop.is_set():
            try:
                last = latest_backup_time()
                if last is None or (time.time() * 1000 - last) >= self.interval_ms:
                    create_backup()
            except Exception as e:  # never crash the server because of a backup
                logger.error("Automatic backup failed: %s", e)
            self._stop.wait(600)


def _main(argv):
    if len(argv) < 2 or argv[1] not in ("create", "list", "restore"):
        print(__doc__)
        return 2
    if argv[1] == "create":
        print(create_backup())
    elif argv[1] == "list":
        for b in list_backups():
            print(f"{b['file']}\t{b['size_bytes']} bytes")
    else:
        if len(argv) < 3:
            print("restore requires a backup file")
            return 2
        safety = restore_backup(argv[2])
        print(f"Restored {argv[2]}. Previous database saved as: {safety}")
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
