"""Declarative description of every synchronized entity.

All three platforms (Debian, Android, Windows) store the same columns; this module is
the single place the server validates them. Common columns on every table:
id, created_at, updated_at, deleted (tombstone), server_rev, origin_device.
"""
import json
from dataclasses import dataclass, field
from typing import Any, Dict, Optional, Tuple


@dataclass(frozen=True)
class F:
    kind: str  # text | int | real | flag | json
    default: Any = None
    nullable: bool = False
    max_len: int = 20000
    choices: Optional[Tuple[str, ...]] = None


@dataclass(frozen=True)
class EntitySpec:
    fields: Dict[str, F]
    legacy: bool = False  # existed in schema v1
    # Protected flag: when a concurrent edit would flip this flag from 1 -> 0, the
    # server copy is kept (AI/automatic edits never overwrite confirmed commitments).
    protect_flag: Optional[str] = None
    id_prefix: str = "itm"
    extra: Dict[str, str] = field(default_factory=dict)


PRIORITIES = ("low", "medium", "high", "urgent")
TASK_STATUS = ("todo", "in_progress", "done", "cancelled")
BLOCK_STATUS = ("proposed", "confirmed", "done", "skipped")
REMINDER_KINDS = ("custom", "deadline", "task", "event", "timer")

ENTITIES: Dict[str, EntitySpec] = {
    "reminders": EntitySpec(
        legacy=True,
        id_prefix="rem",
        fields={
            "user_id": F("text", "default"),
            "text": F("text", "", max_len=2000),
            "due": F("int", None, nullable=True),
            "snooze": F("int", None, nullable=True),
            "done": F("flag", 0),
            "timer": F("flag", 0),
            "repeat": F("json", None, nullable=True, max_len=500),
            "task_id": F("text", None, nullable=True, max_len=100),
            "event_id": F("text", None, nullable=True, max_len=100),
            "kind": F("text", "custom", choices=REMINDER_KINDS),
        },
    ),
    "memories": EntitySpec(
        legacy=True,
        id_prefix="mem",
        fields={
            "user_id": F("text", "default"),
            "category": F("text", "general", max_len=100),
            "fact_text": F("text", "", max_len=5000),
            "confidence": F("real", 1.0),
            "source": F("text", "user", max_len=100),
        },
    ),
    "projects": EntitySpec(
        legacy=True,
        id_prefix="prj",
        fields={
            "user_id": F("text", "default"),
            "title": F("text", "", max_len=500),
            "status": F("text", "active", max_len=50),
            "notes": F("text", "", max_len=10000),
        },
    ),
    "tasks": EntitySpec(
        id_prefix="tsk",
        fields={
            "user_id": F("text", "default"),
            "title": F("text", "", max_len=500),
            "description": F("text", "", max_len=10000),
            "category": F("text", "general", max_len=100),
            "priority": F("text", "medium", choices=PRIORITIES),
            "deadline": F("int", None, nullable=True),
            "estimated_minutes": F("int", None, nullable=True),
            "status": F("text", "todo", choices=TASK_STATUS),
            "project_id": F("text", None, nullable=True, max_len=100),
            "completed_at": F("int", None, nullable=True),
            "source": F("text", "user", max_len=50),
        },
    ),
    "events": EntitySpec(
        id_prefix="evt",
        protect_flag="confirmed",
        fields={
            "user_id": F("text", "default"),
            "title": F("text", "", max_len=500),
            "start_at": F("int", 0),
            "end_at": F("int", None, nullable=True),
            "all_day": F("flag", 0),
            "location": F("text", "", max_len=500),
            "recurrence": F("json", None, nullable=True, max_len=500),
            "notes": F("text", "", max_len=10000),
            "source": F("text", "user", max_len=50),
            "confirmed": F("flag", 1),
        },
    ),
    "plan_blocks": EntitySpec(
        id_prefix="blk",
        protect_flag="locked",
        fields={
            "user_id": F("text", "default"),
            "task_id": F("text", "", max_len=100),
            "start_at": F("int", 0),
            "end_at": F("int", 0),
            "status": F("text", "proposed", choices=BLOCK_STATUS),
            "locked": F("flag", 0),
            "reason": F("text", "", max_len=2000),
        },
    ),
    "clipboard_items": EntitySpec(
        id_prefix="clp",
        fields={
            "user_id": F("text", "default"),
            "text": F("text", "", max_len=100000),
            "hash": F("text", "", max_len=128),
            "origin_name": F("text", "", max_len=200),
        },
    ),
}

COMMON = ("id", "created_at", "updated_at", "deleted", "server_rev", "origin_device")


def sql_type(f: F) -> str:
    base = {"text": "TEXT", "int": "INTEGER", "real": "REAL", "flag": "INTEGER", "json": "TEXT"}[f.kind]
    if f.nullable:
        return base
    if f.kind in ("text", "json"):
        default = "''" if f.default is None else "'" + str(f.default).replace("'", "''") + "'"
    else:
        default = str(f.default if f.default is not None else 0)
    return f"{base} NOT NULL DEFAULT {default}"


def create_table_sql(name: str, spec: EntitySpec) -> str:
    cols = [f"{fname} {sql_type(f)}" for fname, f in spec.fields.items()]
    return (
        f"CREATE TABLE IF NOT EXISTS {name} (id TEXT PRIMARY KEY, "
        + ", ".join(cols)
        + ", created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);"
    )


def data_columns(spec: EntitySpec):
    return list(spec.fields)


class ValidationError(ValueError):
    pass


def _coerce(name: str, f: F, value: Any):
    if value is None:
        if f.nullable:
            return None
        return f.default
    try:
        if f.kind == "text":
            if not isinstance(value, str):
                value = str(value)
            if len(value) > f.max_len:
                raise ValidationError(f"{name}: longer than {f.max_len} characters")
            if f.choices and value not in f.choices:
                raise ValidationError(f"{name}: must be one of {', '.join(f.choices)}")
            return value
        if f.kind == "int":
            if isinstance(value, bool):
                return int(value)
            return int(value)
        if f.kind == "real":
            return float(value)
        if f.kind == "flag":
            if isinstance(value, str):
                return 1 if value.lower() in ("1", "true", "yes") else 0
            return 1 if value else 0
        if f.kind == "json":
            if isinstance(value, (dict, list)):
                value = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
            value = str(value)
            if len(value) > f.max_len:
                raise ValidationError(f"{name}: too long")
            if value:
                json.loads(value)  # must be valid JSON
            return value or None
    except ValidationError:
        raise
    except (TypeError, ValueError):
        raise ValidationError(f"{name}: invalid value")
    raise ValidationError(f"{name}: unknown field kind")


def normalize(entity: str, raw: Dict[str, Any], partial: bool = False) -> Dict[str, Any]:
    """Validate and coerce an incoming item. Unknown keys are ignored."""
    spec = ENTITIES[entity]
    out: Dict[str, Any] = {}
    item_id = raw.get("id")
    if item_id is not None:
        item_id = str(item_id).strip()
        if not item_id or len(item_id) > 100:
            raise ValidationError("id: invalid")
        out["id"] = item_id
    for fname, f in spec.fields.items():
        if partial and fname not in raw:
            continue
        out[fname] = _coerce(fname, f, raw.get(fname, f.default))
    for ts in ("created_at", "updated_at"):
        if ts in raw and raw[ts] is not None:
            try:
                out[ts] = int(raw[ts])
            except (TypeError, ValueError):
                raise ValidationError(f"{ts}: invalid")
    if "deleted" in raw:
        out["deleted"] = 1 if raw.get("deleted") else 0
    if "base_rev" in raw and raw["base_rev"] is not None:
        try:
            out["base_rev"] = int(raw["base_rev"])
        except (TypeError, ValueError):
            raise ValidationError("base_rev: invalid")
    return out


def row_to_dict(entity: str, row) -> Dict[str, Any]:
    return dict(row)
