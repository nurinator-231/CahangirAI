from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from app.auth import verify_device_token
from app.database import get_db, now_ms
from app.entities import ENTITIES, ValidationError
from app.sync_engine import get_row, server_write


def _write(entity, payload, device_id, partial=False):
    try:
        with get_db() as conn:
            return server_write(conn, entity, payload, device_id, partial=partial)
    except ValidationError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except KeyError:
        raise HTTPException(status_code=404, detail=f"{entity} item not found")


SEARCH_COLUMNS = {
    "memories": ["fact_text"],
    "reminders": ["text"],
    "projects": ["title", "notes"],
    "tasks": ["title", "description"],
    "events": ["title", "notes", "location"],
    "plan_blocks": ["reason"],
    "clipboard_items": ["text"],
}


def build_router(entity: str, prefix: str, tag: str, order_by: str = "updated_at DESC", default_status: Optional[str] = None) -> APIRouter:
    router = APIRouter(prefix=prefix, tags=[tag])
    fields = ENTITIES[entity].fields

    @router.get("")
    def list_items(
        include_deleted: bool = False,
        updated_since: Optional[int] = None,
        limit: int = Query(1000, ge=1, le=5000),
        q: Optional[str] = Query(None, max_length=200, description="Text search"),
        category: Optional[str] = None,
        status: Optional[str] = Query(default_status, description="Status filter (reminders: active, done, all)"),
        device_id: str = Depends(verify_device_token),
    ) -> List[Dict[str, Any]]:
        search = q
        q = f"SELECT * FROM {entity} WHERE 1=1"
        params: list = []
        if not include_deleted:
            q += " AND deleted = 0"
        if search:
            cols = SEARCH_COLUMNS.get(entity, [])
            if cols:
                q += " AND (" + " OR ".join(f"{c} LIKE ?" for c in cols) + ")"
                params.extend([f"%{search}%"] * len(cols))
        if category and "category" in fields:
            q += " AND category = ?"
            params.append(category)
        if status and status != "all":
            if entity == "reminders":
                q += " AND done = ?"
                params.append(1 if status == "done" else 0)
            elif "status" in fields:
                q += " AND status = ?"
                params.append(status)
        if updated_since is not None:
            q += " AND updated_at > ?"
            params.append(updated_since)
        q += f" ORDER BY {order_by} LIMIT ?;"
        params.append(limit)
        with get_db() as conn:
            return [dict(r) for r in conn.execute(q, params)]

    @router.get("/{item_id}")
    def get_item(item_id: str, device_id: str = Depends(verify_device_token)):
        with get_db() as conn:
            row = get_row(conn, entity, item_id)
        if not row:
            raise HTTPException(status_code=404, detail=f"{entity} item not found")
        return row

    @router.post("")
    def create_item(payload: Dict[str, Any] = Body(...), device_id: str = Depends(verify_device_token)):
        """Create (or replace by id). Unknown fields are ignored."""
        payload = dict(payload)
        payload["deleted"] = 0
        return _write(entity, payload, device_id)

    @router.put("/{item_id}")
    def update_item(item_id: str, payload: Dict[str, Any] = Body(...), device_id: str = Depends(verify_device_token)):
        """Partial update: only the provided fields change."""
        payload = {k: v for k, v in payload.items() if k in fields or k == "deleted"}
        payload["id"] = item_id
        return _write(entity, payload, device_id, partial=True)

    @router.delete("/{item_id}")
    def delete_item(item_id: str, device_id: str = Depends(verify_device_token)):
        """Soft delete (tombstone) so the deletion propagates to every device."""
        _write(entity, {"id": item_id, "deleted": 1}, device_id, partial=True)
        return {"success": True, "id": item_id, "deleted": True}

    return router


def reminders_extras(router: APIRouter):
    @router.put("/{reminder_id}/complete")
    def complete_reminder(reminder_id: str, device_id: str = Depends(verify_device_token)):
        _write("reminders", {"id": reminder_id, "done": 1, "snooze": None}, device_id, partial=True)
        return {"success": True, "id": reminder_id, "done": True}

    @router.put("/{reminder_id}/snooze")
    def snooze_reminder(reminder_id: str, minutes: int = Query(10, ge=1, le=1440), device_id: str = Depends(verify_device_token)):
        until = now_ms() + minutes * 60_000
        _write("reminders", {"id": reminder_id, "snooze": until}, device_id, partial=True)
        return {"success": True, "id": reminder_id, "snooze": until}
