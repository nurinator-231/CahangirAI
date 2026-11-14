from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# ---------------- Sync ----------------
class P2pInfo(BaseModel):
    hosts: List[str] = Field(default_factory=list, max_length=8)
    port: int = 0
    platform: str = ""
    app_version: str = ""


class SyncPushRequest(BaseModel):
    device_id: str = ""
    client_timestamp: int = 0  # v1 cursor (epoch ms); ignored when since_rev is present
    since_rev: Optional[int] = None  # v2 cursor
    reminders: List[Dict[str, Any]] = Field(default_factory=list)
    memories: List[Dict[str, Any]] = Field(default_factory=list)
    projects: List[Dict[str, Any]] = Field(default_factory=list)
    tasks: List[Dict[str, Any]] = Field(default_factory=list)
    events: List[Dict[str, Any]] = Field(default_factory=list)
    plan_blocks: List[Dict[str, Any]] = Field(default_factory=list)
    clipboard_items: List[Dict[str, Any]] = Field(default_factory=list)
    p2p: Optional[P2pInfo] = None


# ---------------- Auth / Device ----------------
class DeviceRegisterRequest(BaseModel):
    admin_token: Optional[str] = None
    device_id: str = Field(min_length=1, max_length=100)
    device_name: str = Field(min_length=1, max_length=200)
    platform: str = Field("", max_length=40)


class DeviceRegisterResponse(BaseModel):
    device_id: str
    device_name: str
    api_token: str
    message: str


class DeviceItem(BaseModel):
    device_id: str
    device_name: str
    created_at: int
    last_seen_at: int
    is_revoked: int
    platform: str = ""
    app_version: str = ""
    p2p_hosts: List[str] = Field(default_factory=list)
    p2p_port: int = 0
    last_sync_at: int = 0


class DeviceRevokeRequest(BaseModel):
    admin_token: Optional[str] = None
    device_id: str


# ---------------- Health ----------------
class HealthResponse(BaseModel):
    status: str
    version: str
    schema_version: int
    uptime_seconds: float
    cpu_percent: float
    ram_used_mb: float
    ram_total_mb: float
    db_size_bytes: int
    registered_devices: int
    total_memories: int
    active_reminders: int
    open_tasks: int = 0
    server_rev: int = 0
    last_backup_at: Optional[int] = None
