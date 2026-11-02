from typing import List, Optional
from pydantic import BaseModel, Field


# ---------------- Memory ----------------
class MemoryItem(BaseModel):
    id: str
    user_id: str = "default"
    category: str = "general"
    fact_text: str
    confidence: float = 1.0
    source: str = "user"
    created_at: int
    updated_at: int
    deleted: int = 0


class MemoryCreate(BaseModel):
    id: Optional[str] = None
    category: str = "general"
    fact_text: str
    confidence: float = 1.0
    source: str = "user"


# ---------------- Reminder ----------------
class ReminderItem(BaseModel):
    id: str
    user_id: str = "default"
    text: str
    due: Optional[int] = None
    snooze: Optional[int] = None
    done: int = 0
    timer: int = 0
    repeat: Optional[str] = None
    created_at: int
    updated_at: int
    deleted: int = 0


class ReminderCreate(BaseModel):
    id: Optional[str] = None
    text: str
    due: Optional[int] = None
    snooze: Optional[int] = None
    done: int = 0
    timer: int = 0
    repeat: Optional[str] = None


# ---------------- Project ----------------
class ProjectItem(BaseModel):
    id: str
    user_id: str = "default"
    title: str
    status: str = "active"
    notes: str = ""
    created_at: int
    updated_at: int
    deleted: int = 0


class ProjectCreate(BaseModel):
    id: Optional[str] = None
    title: str
    status: str = "active"
    notes: str = ""


# ---------------- Sync ----------------
class SyncPushRequest(BaseModel):
    device_id: str
    client_timestamp: int
    reminders: List[ReminderItem] = Field(default_factory=list)
    memories: List[MemoryItem] = Field(default_factory=list)
    projects: List[ProjectItem] = Field(default_factory=list)


class SyncPullResponse(BaseModel):
    server_timestamp: int
    reminders: List[ReminderItem] = Field(default_factory=list)
    memories: List[MemoryItem] = Field(default_factory=list)
    projects: List[ProjectItem] = Field(default_factory=list)


class SyncFullResponse(BaseModel):
    success: bool
    server_timestamp: int
    applied_reminders: int
    applied_memories: int
    applied_projects: int
    delta: SyncPullResponse


# ---------------- Auth / Device ----------------
class DeviceRegisterRequest(BaseModel):
    admin_token: str
    device_id: str
    device_name: str


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


class DeviceRevokeRequest(BaseModel):
    admin_token: str
    device_id: str


# ---------------- Health ----------------
class HealthResponse(BaseModel):
    status: str
    uptime_seconds: float
    cpu_percent: float
    ram_used_mb: float
    ram_total_mb: float
    db_size_bytes: int
    registered_devices: int
    total_memories: int
    active_reminders: int
