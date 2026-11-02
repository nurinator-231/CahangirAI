import os
import time
from pathlib import Path
from fastapi import APIRouter, Depends
import psutil
from app.auth import verify_admin_token
from app.backup import create_backup
from app.config import DB_PATH
from app.database import get_db
from app.models import HealthResponse

START_TIME = time.time()
router = APIRouter(prefix="/api", tags=["Monitoring & Operations"])


@router.get("/health", response_model=HealthResponse)
def health_check():
    """
    Returns system and application health metrics tailored for Intel Atom D525.
    """
    uptime = time.time() - START_TIME

    # Resource metrics
    try:
        cpu_percent = psutil.cpu_percent(interval=None)
        mem = psutil.virtual_memory()
        ram_used_mb = round((mem.total - mem.available) / (1024 * 1024), 1)
        ram_total_mb = round(mem.total / (1024 * 1024), 1)
    except Exception:
        cpu_percent = 0.0
        ram_used_mb = 0.0
        ram_total_mb = 0.0

    # DB metrics
    db_size = 0
    db_file = Path(DB_PATH)
    if db_file.exists():
        db_size = db_file.stat().st_size

    with get_db() as conn:
        devices_count = conn.execute("SELECT COUNT(*) FROM devices WHERE is_revoked = 0;").fetchone()[0]
        memories_count = conn.execute("SELECT COUNT(*) FROM memories WHERE deleted = 0;").fetchone()[0]
        reminders_count = conn.execute("SELECT COUNT(*) FROM reminders WHERE deleted = 0 AND done = 0;").fetchone()[0]

    return HealthResponse(
        status="healthy",
        uptime_seconds=round(uptime, 1),
        cpu_percent=cpu_percent,
        ram_used_mb=ram_used_mb,
        ram_total_mb=ram_total_mb,
        db_size_bytes=db_size,
        registered_devices=devices_count,
        total_memories=memories_count,
        active_reminders=reminders_count,
    )


@router.post("/backup")
def trigger_backup(admin_token: str):
    """
    Triggers an immediate atomic vacuum backup.
    """
    verify_admin_token(admin_token)
    backup_path = create_backup()
    return {"success": True, "backup_path": backup_path}
