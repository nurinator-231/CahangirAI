package com.cahangir.assistant.data.local

/**
 * Synchronized entities. Mirrors backend/app/entities.py and the Windows app's
 * db/storage.rs so all three platforms store identical columns.
 * Every table also has: id, created_at, updated_at, deleted (tombstone),
 * sync_status (1 = local change not yet acknowledged) and server_rev (last seen
 * server revision, sent back as base_rev).
 */
enum class Kind { TEXT, NULL_TEXT, INT, NULL_INT, REAL, JSON }

data class Col(val name: String, val kind: Kind, val default: String = "")

data class EntitySpec(val name: String, val prefix: String, val cols: List<Col>)

object Entities {
    val ALL: List<EntitySpec> = listOf(
        EntitySpec(
            "reminders", "rem", listOf(
                Col("user_id", Kind.TEXT, "default"), Col("text", Kind.TEXT), Col("due", Kind.NULL_INT),
                Col("snooze", Kind.NULL_INT), Col("done", Kind.INT, "0"), Col("timer", Kind.INT, "0"),
                Col("repeat", Kind.JSON), Col("task_id", Kind.NULL_TEXT), Col("event_id", Kind.NULL_TEXT),
                Col("kind", Kind.TEXT, "custom")
            )
        ),
        EntitySpec(
            "memories", "mem", listOf(
                Col("user_id", Kind.TEXT, "default"), Col("category", Kind.TEXT, "general"), Col("fact_text", Kind.TEXT),
                Col("confidence", Kind.REAL, "1.0"), Col("source", Kind.TEXT, "user")
            )
        ),
        EntitySpec(
            "projects", "prj", listOf(
                Col("user_id", Kind.TEXT, "default"), Col("title", Kind.TEXT), Col("status", Kind.TEXT, "active"),
                Col("notes", Kind.TEXT)
            )
        ),
        EntitySpec(
            "tasks", "tsk", listOf(
                Col("user_id", Kind.TEXT, "default"), Col("title", Kind.TEXT), Col("description", Kind.TEXT),
                Col("category", Kind.TEXT, "general"), Col("priority", Kind.TEXT, "medium"), Col("deadline", Kind.NULL_INT),
                Col("estimated_minutes", Kind.NULL_INT), Col("status", Kind.TEXT, "todo"), Col("project_id", Kind.NULL_TEXT),
                Col("completed_at", Kind.NULL_INT), Col("source", Kind.TEXT, "user")
            )
        ),
        EntitySpec(
            "events", "evt", listOf(
                Col("user_id", Kind.TEXT, "default"), Col("title", Kind.TEXT), Col("start_at", Kind.INT, "0"),
                Col("end_at", Kind.NULL_INT), Col("all_day", Kind.INT, "0"), Col("location", Kind.TEXT),
                Col("recurrence", Kind.JSON), Col("notes", Kind.TEXT), Col("source", Kind.TEXT, "user"),
                Col("confirmed", Kind.INT, "1")
            )
        ),
        EntitySpec(
            "plan_blocks", "blk", listOf(
                Col("user_id", Kind.TEXT, "default"), Col("task_id", Kind.TEXT), Col("start_at", Kind.INT, "0"),
                Col("end_at", Kind.INT, "0"), Col("status", Kind.TEXT, "proposed"), Col("locked", Kind.INT, "0"),
                Col("reason", Kind.TEXT)
            )
        ),
        EntitySpec(
            "clipboard_items", "clp", listOf(
                Col("user_id", Kind.TEXT, "default"), Col("text", Kind.TEXT), Col("hash", Kind.TEXT),
                Col("origin_name", Kind.TEXT)
            )
        ),
    )

    val NAMES: List<String> = ALL.map { it.name }

    fun spec(name: String): EntitySpec = ALL.firstOrNull { it.name == name }
        ?: throw IllegalArgumentException("unknown entity $name")

    fun sqlDecl(c: Col): String = when (c.kind) {
        Kind.TEXT -> "${c.name} TEXT NOT NULL DEFAULT '${c.default.replace("'", "''")}'"
        Kind.NULL_TEXT, Kind.JSON -> "${c.name} TEXT"
        Kind.INT -> "${c.name} INTEGER NOT NULL DEFAULT ${c.default}"
        Kind.NULL_INT -> "${c.name} INTEGER"
        Kind.REAL -> "${c.name} REAL NOT NULL DEFAULT ${c.default}"
    }
}
