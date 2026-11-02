import time
import uuid
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from app.auth import verify_device_token
from app.database import get_db
from app.models import MemoryCreate, MemoryItem

router = APIRouter(prefix="/api/memories", tags=["Structured Memory"])


@router.get("", response_model=List[MemoryItem])
def list_memories(
    category: Optional[str] = None,
    q: Optional[str] = None,
    include_deleted: bool = False,
    device_id: str = Depends(verify_device_token),
):
    """
    Retrieves stored memories, with optional Azerbaijani keyword search and category filtering.
    """
    query = "SELECT * FROM memories WHERE 1=1"
    params = []

    if not include_deleted:
        query += " AND deleted = 0"

    if category:
        query += " AND category = ?"
        params.append(category)

    if q:
        query += " AND fact_text LIKE ?"
        params.append(f"%{q}%")

    query += " ORDER BY updated_at DESC;"

    with get_db() as conn:
        cur = conn.execute(query, params)
        return [MemoryItem(**dict(row)) for row in cur.fetchall()]


@router.post("", response_model=MemoryItem)
def create_memory(
    req: MemoryCreate,
    device_id: str = Depends(verify_device_token),
):
    """
    Stores a new structured memory fact.
    """
    now = int(time.time() * 1000)
    mem_id = req.id or f"mem_{uuid.uuid4().hex[:12]}"

    item = MemoryItem(
        id=mem_id,
        user_id="default",
        category=req.category,
        fact_text=req.fact_text,
        confidence=req.confidence,
        source=req.source,
        created_at=now,
        updated_at=now,
        deleted=0,
    )

    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO memories (id, user_id, category, fact_text, confidence, source, created_at, updated_at, deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                category = excluded.category,
                fact_text = excluded.fact_text,
                confidence = excluded.confidence,
                source = excluded.source,
                updated_at = excluded.updated_at,
                deleted = 0;
            """,
            (
                item.id,
                item.user_id,
                item.category,
                item.fact_text,
                item.confidence,
                item.source,
                item.created_at,
                item.updated_at,
                item.deleted,
            ),
        )

    return item


@router.delete("/{memory_id}")
def delete_memory(
    memory_id: str,
    device_id: str = Depends(verify_device_token),
):
    """
    Soft-deletes a memory fact so the deletion propagates across devices.
    """
    now = int(time.time() * 1000)
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE memories SET deleted = 1, updated_at = ? WHERE id = ?;",
            (now, memory_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Memory fact not found")

    return {"success": True, "message": "Memory deleted", "id": memory_id}
