import time
from pathlib import Path

import psutil
from fastapi import APIRouter, Depends

from app.auth import admin_dependency
from app.backup import create_backup, latest_backup_time, list_backups
from app.config import APP_VERSION, DB_PATH
from app.database import current_rev, get_db, schema_version
from app.models import HealthResponse

START_TIME = time.time()
router = APIRouter(prefix="/api", tags=["Monitoring & Operations"])


@router.get("/health", response_model=HealthResponse)
def health_check():
    """Public liveness/health endpoint (no personal data)."""
    try:
        cpu_percent = psutil.cpu_percent(interval=None)
        mem = psutil.virtual_memory()
        ram_used_mb = round((mem.total - mem.available) / (1024 * 1024), 1)
        ram_total_mb = round(mem.total / (1024 * 1024), 1)
    except Exception:
        cpu_percent = ram_used_mb = ram_total_mb = 0.0
    db_file = Path(DB_PATH)
    db_size = db_file.stat().st_size if db_file.exists() else 0
    with get_db() as conn:
        devices = conn.execute("SELECT COUNT(*) FROM devices WHERE is_revoked = 0;").fetchone()[0]
        memories = conn.execute("SELECT COUNT(*) FROM memories WHERE deleted = 0;").fetchone()[0]
        reminders = conn.execute("SELECT COUNT(*) FROM reminders WHERE deleted = 0 AND done = 0;").fetchone()[0]
        tasks = conn.execute("SELECT COUNT(*) FROM tasks WHERE deleted = 0 AND status NOT IN ('done','cancelled');").fetchone()[0]
        rev = current_rev(conn)
        ver = schema_version(conn)
    return HealthResponse(
        status="healthy",
        version=APP_VERSION,
        schema_version=ver,
        uptime_seconds=round(time.time() - START_TIME, 1),
        cpu_percent=cpu_percent,
        ram_used_mb=ram_used_mb,
        ram_total_mb=ram_total_mb,
        db_size_bytes=db_size,
        registered_devices=devices,
        total_memories=memories,
        active_reminders=reminders,
        open_tasks=tasks,
        server_rev=rev,
        last_backup_at=latest_backup_time(),
    )


@router.post("/backup")
def trigger_backup(_: bool = Depends(admin_dependency)):
    """Immediate consistent backup (admin token via X-Admin-Token header)."""
    return {"success": True, "backup_path": create_backup()}


@router.get("/backups")
def get_backups(_: bool = Depends(admin_dependency)):
    return list_backups()
