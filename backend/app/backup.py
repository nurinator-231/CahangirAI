import os
import sqlite3
import time
from datetime import datetime
from pathlib import Path
from app.config import BACKUP_DIR, DB_PATH


def create_backup() -> str:
    """
    Creates an atomic SQLite vacuum backup using the online backup API.
    Rotates old backups to preserve storage on Debian.
    """
    timestamp_str = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_file = BACKUP_DIR / f"cahangir_backup_{timestamp_str}.db"

    # Source connection
    src = sqlite3.connect(DB_PATH)
    # Destination connection
    dest = sqlite3.connect(str(backup_file))

    try:
        with dest:
            src.backup(dest, pages=20, sleep=0.01)
        print(f"[*] Backup created successfully: {backup_file.name}")
    finally:
        dest.close()
        src.close()

    # Rotate old backups (keep latest 7)
    _rotate_backups(keep=7)
    return str(backup_file)


def _rotate_backups(keep: int = 7):
    backups = sorted(
        BACKUP_DIR.glob("cahangir_backup_*.db"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for old_backup in backups[keep:]:
        try:
            old_backup.unlink()
            print(f"[*] Removed older backup: {old_backup.name}")
        except Exception as e:
            print(f"[!] Error removing old backup {old_backup}: {e}")
