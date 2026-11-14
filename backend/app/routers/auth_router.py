import json
import secrets
import time
from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request

from app.auth import admin_dependency, hash_token, verify_admin_token, verify_device_token
from app.database import get_db, get_meta, set_meta
from app.models import DeviceItem, DeviceRegisterRequest, DeviceRegisterResponse, DeviceRevokeRequest

router = APIRouter(prefix="/api/auth", tags=["Authentication & Devices"])
devices_router = APIRouter(prefix="/api", tags=["Authentication & Devices"])


def _device_item(row) -> DeviceItem:
    d = dict(row)
    hosts = [h for h in (d.get("p2p_hosts") or "").split(",") if h]
    return DeviceItem(
        device_id=d["device_id"],
        device_name=d["device_name"],
        created_at=d["created_at"],
        last_seen_at=d["last_seen_at"],
        is_revoked=d["is_revoked"],
        platform=d.get("platform") or "",
        app_version=d.get("app_version") or "",
        p2p_hosts=hosts,
        p2p_port=d.get("p2p_port") or 0,
        last_sync_at=d.get("last_sync_at") or 0,
    )


def rotate_mesh_key(conn):
    key_id = int(get_meta(conn, "mesh_key_id", "0")) + 1
    set_meta(conn, "mesh_key", secrets.token_hex(32))
    set_meta(conn, "mesh_key_id", str(key_id))


@router.post("/register-device", response_model=DeviceRegisterResponse)
def register_device(req: DeviceRegisterRequest, request: Request, x_admin_token: Optional[str] = Header(None)):
    """Pairs a device (Android phone, Windows PC) using the admin pairing token
    (body field or X-Admin-Token header). Re-pairing an existing device id issues a
    new token and invalidates the previous one."""
    verify_admin_token(x_admin_token or req.admin_token, request)
    now = int(time.time() * 1000)
    api_token = f"cg_{secrets.token_urlsafe(32)}"
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO devices (device_id, device_name, token_hash, created_at, last_seen_at, is_revoked, platform)
            VALUES (?, ?, ?, ?, ?, 0, ?)
            ON CONFLICT(device_id) DO UPDATE SET
                device_name = excluded.device_name,
                token_hash = excluded.token_hash,
                last_seen_at = excluded.last_seen_at,
                platform = CASE WHEN excluded.platform != '' THEN excluded.platform ELSE devices.platform END,
                is_revoked = 0;
            """,
            (req.device_id, req.device_name, hash_token(api_token), now, now, req.platform),
        )
    return DeviceRegisterResponse(
        device_id=req.device_id,
        device_name=req.device_name,
        api_token=api_token,
        message="Device successfully registered. Keep api_token secure.",
    )


@router.get("/devices", response_model=List[DeviceItem])
def list_devices_admin(_: bool = Depends(admin_dependency)):
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM devices ORDER BY last_seen_at DESC;").fetchall()
    return [_device_item(r) for r in rows]


@router.post("/revoke-device")
def revoke_device(req: DeviceRevokeRequest, request: Request, x_admin_token: Optional[str] = Header(None)):
    """Revokes a lost/compromised device. The P2P mesh key is rotated so the revoked
    device can no longer talk to the other devices directly either."""
    verify_admin_token(x_admin_token or req.admin_token, request)
    with get_db() as conn:
        cur = conn.execute("UPDATE devices SET is_revoked = 1 WHERE device_id = ?;", (req.device_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Device not found")
        rotate_mesh_key(conn)
    return {"success": True, "message": f"Device '{req.device_id}' revoked."}


@devices_router.get("/devices", response_model=List[DeviceItem])
def list_devices(device_id: str = Depends(verify_device_token)):
    """Paired devices with their last reported P2P addresses (no secrets)."""
    with get_db() as conn:
        rows = conn.execute("SELECT * FROM devices WHERE is_revoked = 0 ORDER BY last_seen_at DESC;").fetchall()
    return [_device_item(r) for r in rows]


@devices_router.get("/p2p/credentials")
def p2p_credentials(device_id: str = Depends(verify_device_token)):
    """Shared secret used to authenticate direct device-to-device requests
    (HMAC-SHA256). Only paired, non-revoked devices can obtain it."""
    with get_db() as conn:
        return {
            "mesh_key": get_meta(conn, "mesh_key"),
            "key_id": int(get_meta(conn, "mesh_key_id", "1")),
            "device_id": device_id,
        }


@devices_router.get("/whoami")
def whoami(device_id: str = Depends(verify_device_token)):
    return {"device_id": device_id}


def record_device_sync(conn, device_id: str, p2p) -> None:
    now = int(time.time() * 1000)
    if p2p is None:
        conn.execute("UPDATE devices SET last_sync_at = ? WHERE device_id = ?;", (now, device_id))
        return
    hosts = [h.strip() for h in p2p.hosts if h and len(h) <= 64 and "," not in h][:8]
    conn.execute(
        """UPDATE devices SET last_sync_at = ?, p2p_hosts = ?, p2p_port = ?,
           platform = CASE WHEN ? != '' THEN ? ELSE platform END,
           app_version = CASE WHEN ? != '' THEN ? ELSE app_version END
           WHERE device_id = ?;""",
        (now, ",".join(hosts), max(0, min(65535, p2p.port)), p2p.platform[:40], p2p.platform[:40],
         p2p.app_version[:40], p2p.app_version[:40], device_id),
    )
