"""Revision-based synchronization engine.

Every write on the server takes a new value from a monotonic counter (server_rev).
Clients pull "everything with server_rev > my cursor", which is immune to clock skew
between devices (the v1 protocol compared device-clock timestamps).

Push semantics for one item (incoming = client's copy, server = current row):
  * no server row               -> insert.
  * base_rev == server.rev      -> fast-forward: the client edited the latest version.
  * identical content           -> no-op (duplicate push / retry after network loss).
  * otherwise (concurrent edit) -> conflict. Winner = newer updated_at (tie: server).
    Protected flags (event.confirmed, plan_block.locked) are never cleared by a
    concurrent edit. The losing version is preserved in sync_conflicts.
Legacy clients (no base_rev) keep v1 last-write-wins (>=) semantics.
Deletion is a tombstone (deleted=1) and follows exactly the same rules.
"""
import json
import uuid
from typing import Any, Dict, List, Optional, Tuple

from app.config import SYNC_PAGE_LIMIT
from app.database import current_rev, next_rev, now_ms
from app.entities import ENTITIES, normalize, row_to_dict

CONTENT_EXCLUDE = {"server_rev", "origin_device", "updated_at", "created_at", "base_rev"}


def _content(entity: str, d: Dict[str, Any]) -> Dict[str, Any]:
    spec = ENTITIES[entity]
    out = {k: d.get(k) for k in spec.fields}
    out["deleted"] = 1 if d.get("deleted") else 0
    return out


def get_row(conn, entity: str, item_id: str) -> Optional[Dict[str, Any]]:
    row = conn.execute(f"SELECT * FROM {entity} WHERE id = ?;", (item_id,)).fetchone()
    return row_to_dict(entity, row) if row else None


def _write_row(conn, entity: str, data: Dict[str, Any], device_id: str) -> int:
    spec = ENTITIES[entity]
    rev = next_rev(conn)
    cols = ["id"] + list(spec.fields) + ["created_at", "updated_at", "deleted", "server_rev", "origin_device"]
    values = [data["id"]] + [data.get(c) for c in spec.fields] + [
        data["created_at"],
        data["updated_at"],
        1 if data.get("deleted") else 0,
        rev,
        device_id,
    ]
    placeholders = ", ".join("?" for _ in cols)
    updates = ", ".join(f"{c} = excluded.{c}" for c in cols if c not in ("id", "created_at"))
    conn.execute(
        f"INSERT INTO {entity} ({', '.join(cols)}) VALUES ({placeholders}) ON CONFLICT(id) DO UPDATE SET {updates};",
        values,
    )
    return rev


def _record_conflict(conn, entity, entity_id, device_id, winner, kept, discarded, reason):
    conn.execute(
        """INSERT INTO sync_conflicts (entity_type, entity_id, device_id, winner, kept_json, discarded_json, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?);""",
        (
            entity,
            entity_id,
            device_id,
            winner,
            json.dumps(kept, ensure_ascii=False, default=str),
            json.dumps(discarded, ensure_ascii=False, default=str),
            reason,
            now_ms(),
        ),
    )


def apply_push_item(conn, entity: str, raw: Dict[str, Any], device_id: str) -> Tuple[str, Optional[int], Optional[dict]]:
    """Returns (status, server_rev_of_item, conflict_info)."""
    item = normalize(entity, raw)
    if "id" not in item:
        raise ValueError("id is required for synchronized items")
    now = now_ms()
    item.setdefault("created_at", now)
    item.setdefault("updated_at", now)
    item.setdefault("deleted", 0)
    base_rev = item.pop("base_rev", None)

    existing = get_row(conn, entity, item["id"])
    if existing is None:
        rev = _write_row(conn, entity, item, device_id)
        return "applied", rev, None

    item["created_at"] = existing["created_at"]  # creation time never changes
    if _content(entity, existing) == _content(entity, item):
        return "noop", existing["server_rev"], None

    if base_rev is None:
        # v1 client semantics: plain last-write-wins (ties go to the client, as in v1).
        if item["updated_at"] >= existing["updated_at"]:
            rev = _write_row(conn, entity, item, device_id)
            return "applied", rev, None
        return "kept_server", existing["server_rev"], None

    if base_rev >= existing["server_rev"] or existing["origin_device"] == device_id:
        # Fast-forward: this device edited the latest version (or only it has touched the row).
        rev = _write_row(conn, entity, item, device_id)
        return "applied", rev, None

    # Concurrent modification from two devices.
    spec = ENTITIES[entity]
    reason = "newer_edit_wins"
    incoming_wins = item["updated_at"] > existing["updated_at"]
    pf = spec.protect_flag
    if pf and existing.get(pf) == 1 and item.get(pf) == 0 and not item.get("deleted"):
        incoming_wins = False
        reason = f"protected_{pf}"
    if incoming_wins:
        _record_conflict(conn, entity, item["id"], device_id, "client", item, existing, reason)
        rev = _write_row(conn, entity, item, device_id)
        return "applied", rev, {"entity": entity, "id": item["id"], "winner": "client", "reason": reason}
    _record_conflict(conn, entity, item["id"], device_id, "server", existing, item, reason)
    return "kept_server", existing["server_rev"], {"entity": entity, "id": item["id"], "winner": "server", "reason": reason}


def server_write(conn, entity: str, raw: Dict[str, Any], device_id: str, partial: bool = False) -> Dict[str, Any]:
    """Direct REST edit on the server (authoritative, always applied)."""
    spec = ENTITIES[entity]
    data = normalize(entity, raw, partial=partial)
    data.pop("base_rev", None)
    now = now_ms()
    existing = get_row(conn, entity, data["id"]) if data.get("id") else None
    if existing:
        merged = {k: existing[k] for k in list(spec.fields) + ["created_at", "deleted"]}
        merged.update({k: v for k, v in data.items() if k in spec.fields or k == "deleted"})
        merged["id"] = existing["id"]
        merged["created_at"] = existing["created_at"]
    else:
        if partial:
            raise KeyError("not found")
        merged = data
        merged["id"] = data.get("id") or f"{spec.id_prefix}_{uuid.uuid4().hex[:16]}"
        merged["created_at"] = data.get("created_at") or now
        merged.setdefault("deleted", 0)
    merged["updated_at"] = now
    _write_row(conn, entity, merged, device_id)
    return get_row(conn, entity, merged["id"])


def delta_since_rev(conn, since_rev: int, entities: List[str], limit: int = SYNC_PAGE_LIMIT):
    """Rows with server_rev > since_rev, at most `limit`, ordered by revision.
    Returns (rows_by_entity, cursor, has_more)."""
    head = current_rev(conn)
    revs: List[Tuple[int, str]] = []
    for e in entities:
        for r in conn.execute(f"SELECT server_rev FROM {e} WHERE server_rev > ? ORDER BY server_rev LIMIT ?;", (since_rev, limit + 1)):
            revs.append((r[0], e))
    revs.sort()
    has_more = len(revs) > limit
    cap = revs[limit - 1][0] if has_more else head
    out: Dict[str, List[Dict[str, Any]]] = {e: [] for e in entities}
    for e in entities:
        for row in conn.execute(
            f"SELECT * FROM {e} WHERE server_rev > ? AND server_rev <= ? ORDER BY server_rev;", (since_rev, cap)
        ):
            out[e].append(row_to_dict(e, row))
    return out, max(cap, since_rev), has_more


def delta_since_time(conn, since_ms: int, entities: List[str]):
    """Legacy v1 pull by updated_at."""
    out = {}
    for e in entities:
        out[e] = [row_to_dict(e, r) for r in conn.execute(f"SELECT * FROM {e} WHERE updated_at > ?;", (since_ms,))]
    return out
