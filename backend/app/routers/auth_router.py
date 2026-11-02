import secrets
import time
from typing import List
from fastapi import APIRouter, Depends, HTTPException, status
from app.auth import hash_token, verify_admin_token
from app.database import get_db
from app.models import (
    DeviceItem,
    DeviceRegisterRequest,
    DeviceRegisterResponse,
    DeviceRevokeRequest,
)

router = APIRouter(prefix="/api/auth", tags=["Authentication & Devices"])


@router.post("/register-device", response_model=DeviceRegisterResponse)
def register_device(req: DeviceRegisterRequest):
    """
    Registers a new client device (e.g. Galaxy S25 or Windows laptop)
    using the master admin pairing token.
    """
    verify_admin_token(req.admin_token)

    now = int(time.time() * 1000)
    api_token = f"cg_{secrets.token_urlsafe(32)}"
    thash = hash_token(api_token)

    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO devices (device_id, device_name, token_hash, created_at, last_seen_at, is_revoked)
            VALUES (?, ?, ?, ?, ?, 0)
            ON CONFLICT(device_id) DO UPDATE SET
                device_name = excluded.device_name,
                token_hash = excluded.token_hash,
                last_seen_at = excluded.last_seen_at,
                is_revoked = 0;
            """,
            (req.device_id, req.device_name, thash, now, now),
        )

    return DeviceRegisterResponse(
        device_id=req.device_id,
        device_name=req.device_name,
        api_token=api_token,
        message="Device successfully registered. Keep api_token secure.",
    )


@router.get("/devices", response_model=List[DeviceItem])
def list_devices(admin_token: str):
    """
    Lists all registered client devices and their connectivity status.
    """
    verify_admin_token(admin_token)
    with get_db() as conn:
        cur = conn.execute(
            """
            SELECT device_id, device_name, created_at, last_seen_at, is_revoked
            FROM devices
            ORDER BY last_seen_at DESC;
            """
        )
        return [DeviceItem(**dict(row)) for row in cur.fetchall()]


@router.post("/revoke-device")
def revoke_device(req: DeviceRevokeRequest):
    """
    Immediately revokes access for a compromised or lost device.
    """
    verify_admin_token(req.admin_token)
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE devices SET is_revoked = 1 WHERE device_id = ?;",
            (req.device_id,),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Device not found")

    return {"success": True, "message": f"Device '{req.device_id}' revoked."}
