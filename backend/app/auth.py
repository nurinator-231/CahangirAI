import hashlib
import time
from typing import Optional
from fastapi import Header, HTTPException, status
from app.config import ADMIN_TOKEN
from app.database import get_db

SALT = "cahangir_tailscale_v3_salt"


def hash_token(token: str) -> str:
    return hashlib.sha256((token + SALT).encode("utf-8")).hexdigest()


def verify_device_token(authorization: Optional[str] = Header(None)) -> str:
    """
    Dependency that validates the Bearer token against registered non-revoked devices.
    Returns the authenticated device_id.
    """
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization header missing. Expected: Bearer <device_token>",
        )

    parts = authorization.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authorization format. Expected: Bearer <device_token>",
        )

    token = parts[1]
    thash = hash_token(token)

    now = int(time.time() * 1000)

    with get_db() as conn:
        cur = conn.execute(
            """
            SELECT device_id, is_revoked FROM devices WHERE token_hash = ?;
            """,
            (thash,),
        )
        row = cur.fetchone()
        if not row:
            # Check if it's the admin token
            if token == ADMIN_TOKEN:
                return "admin"
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or unknown device token.",
            )

        if row["is_revoked"]:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Device access has been revoked.",
            )

        device_id = row["device_id"]
        # Update last seen timestamp
        conn.execute(
            "UPDATE devices SET last_seen_at = ? WHERE device_id = ?;",
            (now, device_id),
        )
        return device_id


def verify_admin_token(admin_token: str):
    if admin_token != ADMIN_TOKEN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid admin token.",
        )
