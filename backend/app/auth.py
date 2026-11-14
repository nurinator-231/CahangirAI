import hashlib
import hmac
import threading
import time
from collections import defaultdict, deque
from typing import Optional

from fastapi import Header, HTTPException, Query, Request, status

from app.config import ADMIN_TOKEN
from app.database import get_db

# Kept for compatibility: existing paired devices' token hashes were created with it.
# Device tokens are 256-bit random values, so a static salt is sufficient.
SALT = "cahangir_tailscale_v3_salt"

_FAIL_WINDOW_S = 600
_FAIL_LIMIT = 10
_failures = defaultdict(deque)
_fail_lock = threading.Lock()


def hash_token(token: str) -> str:
    return hashlib.sha256((token + SALT).encode("utf-8")).hexdigest()


def _client_key(request: Optional[Request]) -> str:
    if request is None or request.client is None:
        return "unknown"
    return request.client.host or "unknown"


def _check_throttle(key: str):
    with _fail_lock:
        q = _failures[key]
        cutoff = time.time() - _FAIL_WINDOW_S
        while q and q[0] < cutoff:
            q.popleft()
        if len(q) >= _FAIL_LIMIT:
            raise HTTPException(status_code=429, detail="Too many failed authentication attempts. Try again later.")


def _record_failure(key: str):
    with _fail_lock:
        _failures[key].append(time.time())


def reset_throttle():
    with _fail_lock:
        _failures.clear()


def verify_device_token(request: Request, authorization: Optional[str] = Header(None)) -> str:
    """Validates `Authorization: Bearer <device_token>` against non-revoked devices.
    Returns the authenticated device_id ("admin" when the admin token is used)."""
    key = _client_key(request)
    _check_throttle(key)
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
    with get_db() as conn:
        row = conn.execute("SELECT device_id, is_revoked FROM devices WHERE token_hash = ?;", (thash,)).fetchone()
        if not row:
            if hmac.compare_digest(token.encode(), ADMIN_TOKEN.encode()):
                return "admin"
            _record_failure(key)
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or unknown device token.")
        if row["is_revoked"]:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Device access has been revoked.")
        conn.execute(
            "UPDATE devices SET last_seen_at = ? WHERE device_id = ?;",
            (int(time.time() * 1000), row["device_id"]),
        )
        return row["device_id"]


def verify_admin_token(admin_token: Optional[str], request: Optional[Request] = None):
    key = _client_key(request)
    _check_throttle(key)
    if not admin_token or not hmac.compare_digest(admin_token.encode(), ADMIN_TOKEN.encode()):
        _record_failure(key)
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid admin token.")


def admin_dependency(
    request: Request,
    x_admin_token: Optional[str] = Header(None),
    admin_token: Optional[str] = Query(None, description="Deprecated: use the X-Admin-Token header"),
) -> bool:
    """Admin auth for GET/POST endpoints. Prefer the X-Admin-Token header; the query
    parameter is still accepted so existing clients keep working."""
    verify_admin_token(x_admin_token or admin_token, request)
    return True
