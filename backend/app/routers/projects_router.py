import time
import uuid
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
from app.auth import verify_device_token
from app.database import get_db
from app.models import ProjectCreate, ProjectItem

router = APIRouter(prefix="/api/projects", tags=["Projects & Tasks"])


@router.get("", response_model=List[ProjectItem])
def list_projects(
    include_deleted: bool = False,
    device_id: str = Depends(verify_device_token),
):
    query = "SELECT * FROM projects WHERE 1=1"
    if not include_deleted:
        query += " AND deleted = 0"
    query += " ORDER BY updated_at DESC;"

    with get_db() as conn:
        cur = conn.execute(query)
        return [ProjectItem(**dict(row)) for row in cur.fetchall()]


@router.post("", response_model=ProjectItem)
def create_project(
    req: ProjectCreate,
    device_id: str = Depends(verify_device_token),
):
    now = int(time.time() * 1000)
    prj_id = req.id or f"prj_{uuid.uuid4().hex[:12]}"

    item = ProjectItem(
        id=prj_id,
        user_id="default",
        title=req.title,
        status=req.status,
        notes=req.notes,
        created_at=now,
        updated_at=now,
        deleted=0,
    )

    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO projects (id, user_id, title, status, notes, created_at, updated_at, deleted)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                status = excluded.status,
                notes = excluded.notes,
                updated_at = excluded.updated_at,
                deleted = 0;
            """,
            (
                item.id,
                item.user_id,
                item.title,
                item.status,
                item.notes,
                item.created_at,
                item.updated_at,
                item.deleted,
            ),
        )

    return item


@router.delete("/{project_id}")
def delete_project(
    project_id: str,
    device_id: str = Depends(verify_device_token),
):
    now = int(time.time() * 1000)
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE projects SET deleted = 1, updated_at = ? WHERE id = ?;",
            (now, project_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Project not found")

    return {"success": True, "message": "Project deleted", "id": project_id}
