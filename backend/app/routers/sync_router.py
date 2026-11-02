import time
from typing import List
from fastapi import APIRouter, Depends, Query
from app.auth import verify_device_token
from app.database import get_db
from app.models import (
    MemoryItem,
    ProjectItem,
    ReminderItem,
    SyncFullResponse,
    SyncPullResponse,
    SyncPushRequest,
)

router = APIRouter(prefix="/api/sync", tags=["Synchronization Engine"])


@router.post("", response_model=SyncFullResponse)
def bidirectional_sync(
    req: SyncPushRequest,
    device_id: str = Depends(verify_device_token),
):
    """
    Bi-directional, delta-based synchronization in a single atomic transaction.
    1. Pushes client's offline changes into server SQLite using Last-Write-Wins.
    2. Pulls any server changes updated after client_timestamp.
    """
    server_now = int(time.time() * 1000)

    applied_reminders = 0
    applied_memories = 0
    applied_projects = 0

    pushed_reminder_ids = set()
    pushed_memory_ids = set()
    pushed_project_ids = set()

    with get_db() as conn:
        # --- 1. Apply Pushed Reminders ---
        for rem in req.reminders:
            pushed_reminder_ids.add(rem.id)
            cur = conn.execute(
                "SELECT updated_at FROM reminders WHERE id = ?;", (rem.id,)
            )
            existing = cur.fetchone()

            if not existing:
                conn.execute(
                    """
                    INSERT INTO reminders (id, user_id, text, due, snooze, done, timer, repeat, created_at, updated_at, deleted)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
                    """,
                    (
                        rem.id,
                        rem.user_id,
                        rem.text,
                        rem.due,
                        rem.snooze,
                        rem.done,
                        rem.timer,
                        rem.repeat,
                        rem.created_at,
                        rem.updated_at,
                        rem.deleted,
                    ),
                )
                applied_reminders += 1
            elif rem.updated_at >= existing["updated_at"]:
                conn.execute(
                    """
                    UPDATE reminders SET
                        user_id = ?, text = ?, due = ?, snooze = ?, done = ?,
                        timer = ?, repeat = ?, updated_at = ?, deleted = ?
                    WHERE id = ?;
                    """,
                    (
                        rem.user_id,
                        rem.text,
                        rem.due,
                        rem.snooze,
                        rem.done,
                        rem.timer,
                        rem.repeat,
                        rem.updated_at,
                        rem.deleted,
                        rem.id,
                    ),
                )
                applied_reminders += 1

        # --- 2. Apply Pushed Memories ---
        for mem in req.memories:
            pushed_memory_ids.add(mem.id)
            cur = conn.execute(
                "SELECT updated_at FROM memories WHERE id = ?;", (mem.id,)
            )
            existing = cur.fetchone()

            if not existing:
                conn.execute(
                    """
                    INSERT INTO memories (id, user_id, category, fact_text, confidence, source, created_at, updated_at, deleted)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
                    """,
                    (
                        mem.id,
                        mem.user_id,
                        mem.category,
                        mem.fact_text,
                        mem.confidence,
                        mem.source,
                        mem.created_at,
                        mem.updated_at,
                        mem.deleted,
                    ),
                )
                applied_memories += 1
            elif mem.updated_at >= existing["updated_at"]:
                conn.execute(
                    """
                    UPDATE memories SET
                        user_id = ?, category = ?, fact_text = ?, confidence = ?,
                        source = ?, updated_at = ?, deleted = ?
                    WHERE id = ?;
                    """,
                    (
                        mem.user_id,
                        mem.category,
                        mem.fact_text,
                        mem.confidence,
                        mem.source,
                        mem.updated_at,
                        mem.deleted,
                        mem.id,
                    ),
                )
                applied_memories += 1

        # --- 3. Apply Pushed Projects ---
        for prj in req.projects:
            pushed_project_ids.add(prj.id)
            cur = conn.execute(
                "SELECT updated_at FROM projects WHERE id = ?;", (prj.id,)
            )
            existing = cur.fetchone()

            if not existing:
                conn.execute(
                    """
                    INSERT INTO projects (id, user_id, title, status, notes, created_at, updated_at, deleted)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?);
                    """,
                    (
                        prj.id,
                        prj.user_id,
                        prj.title,
                        prj.status,
                        prj.notes,
                        prj.created_at,
                        prj.updated_at,
                        prj.deleted,
                    ),
                )
                applied_projects += 1
            elif prj.updated_at >= existing["updated_at"]:
                conn.execute(
                    """
                    UPDATE projects SET
                        user_id = ?, title = ?, status = ?, notes = ?,
                        updated_at = ?, deleted = ?
                    WHERE id = ?;
                    """,
                    (
                        prj.user_id,
                        prj.title,
                        prj.status,
                        prj.notes,
                        prj.updated_at,
                        prj.deleted,
                        prj.id,
                    ),
                )
                applied_projects += 1

        # --- 4. Query Server Deltas (items updated after client_timestamp not in this push) ---
        delta_reminders = []
        cur_rem = conn.execute(
            "SELECT * FROM reminders WHERE updated_at > ?;", (req.client_timestamp,)
        )
        for row in cur_rem.fetchall():
            if row["id"] not in pushed_reminder_ids:
                delta_reminders.append(ReminderItem(**dict(row)))

        delta_memories = []
        cur_mem = conn.execute(
            "SELECT * FROM memories WHERE updated_at > ?;", (req.client_timestamp,)
        )
        for row in cur_mem.fetchall():
            if row["id"] not in pushed_memory_ids:
                delta_memories.append(MemoryItem(**dict(row)))

        delta_projects = []
        cur_prj = conn.execute(
            "SELECT * FROM projects WHERE updated_at > ?;", (req.client_timestamp,)
        )
        for row in cur_prj.fetchall():
            if row["id"] not in pushed_project_ids:
                delta_projects.append(ProjectItem(**dict(row)))

        # Log sync activity
        conn.execute(
            """
            INSERT INTO sync_log (device_id, action, entity_type, entity_id, timestamp)
            VALUES (?, 'sync', 'batch', ?, ?);
            """,
            (device_id, f"r:{applied_reminders},m:{applied_memories},p:{applied_projects}", server_now),
        )

    return SyncFullResponse(
        success=True,
        server_timestamp=server_now,
        applied_reminders=applied_reminders,
        applied_memories=applied_memories,
        applied_projects=applied_projects,
        delta=SyncPullResponse(
            server_timestamp=server_now,
            reminders=delta_reminders,
            memories=delta_memories,
            projects=delta_projects,
        ),
    )


@router.get("/pull", response_model=SyncPullResponse)
def pull_changes(
    since: int = Query(0, description="Timestamp in epoch ms to pull changes since"),
    device_id: str = Depends(verify_device_token),
):
    """
    Pulls delta changes updated since the specified timestamp.
    """
    server_now = int(time.time() * 1000)
    with get_db() as conn:
        cur_rem = conn.execute("SELECT * FROM reminders WHERE updated_at > ?;", (since,))
        reminders = [ReminderItem(**dict(r)) for r in cur_rem.fetchall()]

        cur_mem = conn.execute("SELECT * FROM memories WHERE updated_at > ?;", (since,))
        memories = [MemoryItem(**dict(r)) for r in cur_mem.fetchall()]

        cur_prj = conn.execute("SELECT * FROM projects WHERE updated_at > ?;", (since,))
        projects = [ProjectItem(**dict(r)) for r in cur_prj.fetchall()]

    return SyncPullResponse(
        server_timestamp=server_now,
        reminders=reminders,
        memories=memories,
        projects=projects,
    )
