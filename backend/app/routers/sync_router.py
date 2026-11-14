import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth import verify_device_token
from app.database import current_rev, get_db, now_ms
from app.entities import ENTITIES, ValidationError
from app.models import SyncPushRequest
from app.routers.auth_router import record_device_sync
from app.sync_engine import apply_push_item, delta_since_rev, delta_since_time

router = APIRouter(prefix="/api/sync", tags=["Synchronization Engine"])

ALL_ENTITIES = list(ENTITIES)
LEGACY_ENTITIES = ["reminders", "memories", "projects"]
MAX_PUSH_ITEMS = 5000


@router.post("")
def bidirectional_sync(req: SyncPushRequest, device_id: str = Depends(verify_device_token)):
    """Push local changes and pull remote changes in one atomic transaction.

    v2 clients send `since_rev` (server revision cursor) and `base_rev` per item and
    receive `server_rev`, `acks` (new revision of each accepted item) and `conflicts`.
    v1 clients (client_timestamp only) keep the original behaviour and response shape.
    """
    v2 = req.since_rev is not None
    server_now = now_ms()
    applied = {e: 0 for e in ALL_ENTITIES}
    acks = {e: {} for e in ALL_ENTITIES}
    rejected = []
    conflicts = []
    accepted_ids = {e: set() for e in ALL_ENTITIES}
    kept_server_ids = {e: set() for e in ALL_ENTITIES}

    total = sum(len(getattr(req, e)) for e in ALL_ENTITIES)
    if total > MAX_PUSH_ITEMS:
        raise HTTPException(status_code=413, detail=f"Too many items in one push (max {MAX_PUSH_ITEMS}); send in batches.")

    with get_db() as conn:
        for entity in ALL_ENTITIES:
            for raw in getattr(req, entity):
                try:
                    status, rev, conflict = apply_push_item(conn, entity, raw, device_id)
                except (ValidationError, ValueError) as e:
                    rejected.append({"entity": entity, "id": str(raw.get("id", "")), "error": str(e)})
                    continue
                item_id = str(raw.get("id"))
                if status == "applied":
                    applied[entity] += 1
                if status in ("applied", "noop"):
                    accepted_ids[entity].add(item_id)
                else:
                    kept_server_ids[entity].add(item_id)
                acks[entity][item_id] = rev
                if conflict:
                    conflicts.append(conflict)

        if v2:
            delta, cursor, has_more = delta_since_rev(conn, req.since_rev, ALL_ENTITIES)
            for entity in ALL_ENTITIES:
                # Items this device just pushed successfully are acknowledged via `acks`.
                delta[entity] = [r for r in delta[entity] if r["id"] not in accepted_ids[entity]]
                # Items where the server copy won must reach the client even if older than the cursor.
                present = {r["id"] for r in delta[entity]}
                for item_id in kept_server_ids[entity] - present:
                    row = conn.execute(f"SELECT * FROM {entity} WHERE id = ?;", (item_id,)).fetchone()
                    if row:
                        delta[entity].append(dict(row))
        else:
            delta = delta_since_time(conn, req.client_timestamp, LEGACY_ENTITIES)
            pushed = {e: accepted_ids[e] | kept_server_ids[e] for e in LEGACY_ENTITIES}
            for entity in LEGACY_ENTITIES:
                delta[entity] = [r for r in delta[entity] if r["id"] not in pushed[entity]]
            cursor, has_more = current_rev(conn), False

        record_device_sync(conn, device_id, req.p2p)
        conn.execute(
            "INSERT INTO sync_log (device_id, action, entity_type, entity_id, timestamp) VALUES (?, 'sync', 'batch', ?, ?);",
            (device_id, json.dumps(applied, separators=(",", ":")), server_now),
        )

    delta_out = {"server_timestamp": server_now, "server_rev": cursor, "has_more": has_more}
    delta_out.update(delta)
    return {
        "success": True,
        "protocol": 2 if v2 else 1,
        "server_timestamp": server_now,
        "server_rev": cursor,
        "has_more": has_more,
        "applied_reminders": applied["reminders"],
        "applied_memories": applied["memories"],
        "applied_projects": applied["projects"],
        "applied": applied,
        "acks": acks,
        "conflicts": conflicts,
        "rejected": rejected,
        "delta": delta_out,
    }


@router.get("/pull")
def pull_changes(
    since: int = Query(0, description="v1: epoch ms cursor"),
    since_rev: Optional[int] = Query(None, description="v2: server revision cursor"),
    device_id: str = Depends(verify_device_token),
):
    server_now = now_ms()
    with get_db() as conn:
        if since_rev is not None:
            delta, cursor, has_more = delta_since_rev(conn, since_rev, ALL_ENTITIES)
        else:
            delta = delta_since_time(conn, since, LEGACY_ENTITIES)
            cursor, has_more = current_rev(conn), False
    out = {"server_timestamp": server_now, "server_rev": cursor, "has_more": has_more}
    out.update(delta)
    return out


@router.get("/conflicts")
def list_conflicts(include_resolved: bool = False, limit: int = Query(100, ge=1, le=1000), device_id: str = Depends(verify_device_token)):
    """Concurrent edits detected during sync, with both versions preserved."""
    q = "SELECT * FROM sync_conflicts"
    if not include_resolved:
        q += " WHERE resolved = 0"
    q += " ORDER BY created_at DESC LIMIT ?;"
    with get_db() as conn:
        rows = conn.execute(q, (limit,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["kept"] = json.loads(d.pop("kept_json"))
        d["discarded"] = json.loads(d.pop("discarded_json"))
        out.append(d)
    return out


@router.post("/conflicts/{conflict_id}/resolve")
def resolve_conflict(conflict_id: int, device_id: str = Depends(verify_device_token)):
    """Mark a conflict as reviewed (to restore the discarded version, the client simply
    saves it again, which creates a normal new edit)."""
    with get_db() as conn:
        cur = conn.execute("UPDATE sync_conflicts SET resolved = 1 WHERE id = ?;", (conflict_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Conflict not found")
    return {"success": True}
