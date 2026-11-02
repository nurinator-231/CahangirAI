import time
import uuid
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from app.auth import verify_device_token
from app.database import get_db
from app.models import ReminderCreate, ReminderItem

router = APIRouter(prefix="/api/reminders", tags=["Reminders & Tasks"])


@router.get("", response_model=List[ReminderItem])
def list_reminders(
    status: str = Query("active", description="active, done, or all"),
    device_id: str = Depends(verify_device_token),
):
    """
    Lists reminders from the central database.
    """
    query = "SELECT * FROM reminders WHERE deleted = 0"
    params = []

    if status == "active":
        query += " AND done = 0"
    elif status == "done":
        query += " AND done = 1"

    query += " ORDER BY CASE WHEN snooze IS NOT NULL THEN snooze ELSE due END ASC;"

    with get_db() as conn:
        cur = conn.execute(query, params)
        return [ReminderItem(**dict(row)) for row in cur.fetchall()]


@router.post("", response_model=ReminderItem)
def create_reminder(
    req: ReminderCreate,
    device_id: str = Depends(verify_device_token),
):
    """
    Creates or registers a reminder on the server.
    """
    now = int(time.time() * 1000)
    rem_id = req.id or f"rem_{uuid.uuid4().hex[:12]}"

    item = ReminderItem(
        id=rem_id,
        user_id="default",
        text=req.text,
        due=req.due,
        snooze=req.snooze,
        done=req.done,
        timer=req.timer,
        repeat=req.repeat,
        created_at=now,
        updated_at=now,
        deleted=0,
    )

    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO reminders (id, user_id, text, due, snooze, done, timer, repeat, created_at, updated_at, deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                text = excluded.text,
                due = excluded.due,
                snooze = excluded.snooze,
                done = excluded.done,
                timer = excluded.timer,
                repeat = excluded.repeat,
                updated_at = excluded.updated_at,
                deleted = 0;
            """,
            (
                item.id,
                item.user_id,
                item.text,
                item.due,
                item.snooze,
                item.done,
                item.timer,
                item.repeat,
                item.created_at,
                item.updated_at,
                item.deleted,
            ),
        )

    return item


@router.put("/{reminder_id}/complete")
def complete_reminder(
    reminder_id: str,
    device_id: str = Depends(verify_device_token),
):
    now = int(time.time() * 1000)
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE reminders SET done = 1, updated_at = ? WHERE id = ?;",
            (now, reminder_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Reminder not found")

    return {"success": True, "id": reminder_id, "done": True}


@router.put("/{reminder_id}/snooze")
def snooze_reminder(
    reminder_id: str,
    minutes: int = Query(10),
    device_id: str = Depends(verify_device_token),
):
    now = int(time.time() * 1000)
    snooze_until = now + (minutes * 60 * 1000)
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE reminders SET snooze = ?, updated_at = ? WHERE id = ?;",
            (snooze_until, now, reminder_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Reminder not found")

    return {"success": True, "id": reminder_id, "snooze": snooze_until}


@router.delete("/{reminder_id}")
def delete_reminder(
    reminder_id: str,
    device_id: str = Depends(verify_device_token),
):
    now = int(time.time() * 1000)
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE reminders SET deleted = 1, updated_at = ? WHERE id = ?;",
            (now, reminder_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Reminder not found")

    return {"success": True, "message": "Reminder deleted", "id": reminder_id}
