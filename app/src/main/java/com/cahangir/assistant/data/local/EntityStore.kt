package com.cahangir.assistant.data.local

import android.content.ContentValues
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import com.cahangir.assistant.sync.SyncStore
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Single source of truth for the Android app's data (native SQLite). The WebView UI
 * reads and writes exclusively through this store via the bridge.
 */
class EntityStore(private val dbHelper: CahangirDbHelper) : SyncStore {

    private val db: SQLiteDatabase get() = dbHelper.writableDatabase

    private fun extraCols(entity: String) = if (entity == "reminders") listOf("fired_at") else emptyList()

    private fun rowToJson(spec: EntitySpec, c: Cursor): JSONObject {
        val o = JSONObject()
        o.put("id", c.getString(c.getColumnIndexOrThrow("id")))
        for (col in spec.cols) {
            val i = c.getColumnIndexOrThrow(col.name)
            when (col.kind) {
                Kind.TEXT -> o.put(col.name, if (c.isNull(i)) col.default else c.getString(i))
                Kind.NULL_TEXT, Kind.JSON -> o.put(col.name, if (c.isNull(i)) JSONObject.NULL else c.getString(i))
                Kind.INT -> o.put(col.name, if (c.isNull(i)) (col.default.toLongOrNull() ?: 0L) else c.getLong(i))
                Kind.NULL_INT -> o.put(col.name, if (c.isNull(i)) JSONObject.NULL else c.getLong(i))
                Kind.REAL -> o.put(col.name, if (c.isNull(i)) 0.0 else c.getDouble(i))
            }
        }
        for (n in listOf("created_at", "updated_at", "deleted", "sync_status", "server_rev") + extraCols(spec.name)) {
            val i = c.getColumnIndexOrThrow(n)
            o.put(n, if (c.isNull(i)) JSONObject.NULL else c.getLong(i))
        }
        return o
    }

    fun list(entity: String, includeDeleted: Boolean = false): List<JSONObject> {
        val spec = Entities.spec(entity)
        val where = if (includeDeleted) "" else "WHERE deleted = 0"
        return db.rawQuery("SELECT * FROM $entity $where ORDER BY updated_at DESC;", null).use { c ->
            val out = ArrayList<JSONObject>()
            while (c.moveToNext()) out.add(rowToJson(spec, c))
            out
        }
    }

    fun listJson(entity: String, includeDeleted: Boolean = false): String = JSONArray(list(entity, includeDeleted)).toString()

    fun get(entity: String, id: String): JSONObject? {
        val spec = Entities.spec(entity)
        return db.rawQuery("SELECT * FROM $entity WHERE id = ?;", arrayOf(id)).use { c ->
            if (c.moveToFirst()) rowToJson(spec, c) else null
        }
    }

    override fun pending(entity: String): List<JSONObject> = list(entity, true).filter { it.optLong("sync_status") == 1L }

    fun pendingCount(): Int = Entities.NAMES.sumOf { e ->
        db.rawQuery("SELECT COUNT(*) FROM $e WHERE sync_status = 1;", null).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }
    }

    private fun bind(values: ContentValues, col: Col, v: Any?) {
        val value = if (v == JSONObject.NULL) null else v
        when (col.kind) {
            Kind.TEXT -> values.put(col.name, value?.toString() ?: col.default)
            Kind.NULL_TEXT -> if (value == null || value.toString().isEmpty()) values.putNull(col.name) else values.put(col.name, value.toString())
            Kind.JSON -> if (value == null || value.toString().isEmpty()) values.putNull(col.name) else values.put(col.name, value.toString())
            Kind.INT -> values.put(col.name, toLong(value) ?: (col.default.toLongOrNull() ?: 0L))
            Kind.NULL_INT -> toLong(value)?.let { values.put(col.name, it) } ?: values.putNull(col.name)
            Kind.REAL -> values.put(col.name, (value as? Number)?.toDouble() ?: value?.toString()?.toDoubleOrNull() ?: 1.0)
        }
    }

    private fun writeRow(entity: String, row: JSONObject, syncStatus: Int, serverRev: Long) {
        val spec = Entities.spec(entity)
        val values = ContentValues()
        values.put("id", row.getString("id"))
        for (col in spec.cols) bind(values, col, if (row.has(col.name)) row.get(col.name) else null)
        values.put("created_at", toLong(row.opt("created_at")) ?: System.currentTimeMillis())
        values.put("updated_at", toLong(row.opt("updated_at")) ?: System.currentTimeMillis())
        values.put("deleted", if (toLong(row.opt("deleted")) == 1L) 1 else 0)
        values.put("sync_status", syncStatus)
        values.put("server_rev", serverRev)
        // UPDATE first (keeps local-only columns such as fired_at), INSERT if new.
        val n = db.update(entity, values, "id = ?", arrayOf(row.getString("id")))
        if (n == 0) db.insertOrThrow(entity, null, values)
    }

    /** Local edit: merges `patch` into the existing row, stamps updated_at, marks pending. */
    @Synchronized
    fun saveLocal(entity: String, patch: JSONObject): JSONObject {
        val spec = Entities.spec(entity)
        val now = System.currentTimeMillis()
        val id = patch.optString("id", "").takeIf { it.isNotBlank() && it != "null" }
        val existing = id?.let { get(entity, it) }
        val row = existing ?: JSONObject()
        val keys = patch.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            if (spec.cols.any { it.name == k } || k == "deleted") row.put(k, patch.get(k))
        }
        val finalId = id ?: "${spec.prefix}_${UUID.randomUUID().toString().replace("-", "")}"
        row.put("id", finalId)
        if (existing == null) row.put("created_at", toLong(patch.opt("created_at")) ?: now)
        val prev = toLong(row.opt("updated_at")) ?: 0L
        row.put("updated_at", maxOf(now, prev + 1))
        if (!row.has("deleted")) row.put("deleted", 0)
        writeRow(entity, row, 1, toLong(row.opt("server_rev")) ?: 0L)
        return get(entity, finalId)!!
    }

    fun deleteLocal(entity: String, id: String): Boolean {
        if (get(entity, id) == null) return false
        saveLocal(entity, JSONObject().put("id", id).put("deleted", 1))
        return true
    }

    @Synchronized
    override fun ack(entity: String, id: String, rev: Long, pushedUpdatedAt: Long) {
        db.execSQL(
            "UPDATE $entity SET server_rev = ?, sync_status = CASE WHEN updated_at = ? THEN 0 ELSE sync_status END WHERE id = ?;",
            arrayOf<Any>(rev, pushedUpdatedAt, id)
        )
    }

    @Synchronized
    override fun applyRemote(entity: String, row: JSONObject, force: Boolean): Boolean {
        val id = row.optString("id", "")
        if (id.isBlank()) return false
        val local = get(entity, id)
        val rev = toLong(row.opt("server_rev")) ?: 0L
        if (local != null && local.optLong("sync_status") == 1L && !force) {
            db.execSQL("UPDATE $entity SET server_rev = MAX(server_rev, ?) WHERE id = ?;", arrayOf<Any>(rev, id))
            return false
        }
        writeRow(entity, row, 0, rev)
        return true
    }

    fun setReminderFired(id: String, firedAt: Long?) {
        val v = ContentValues()
        if (firedAt == null) v.putNull("fired_at") else v.put("fired_at", firedAt)
        db.update("reminders", v, "id = ?", arrayOf(id))
    }

    fun <T> inTransaction(block: () -> T): T {
        db.beginTransaction()
        try {
            val r = block()
            db.setTransactionSuccessful()
            return r
        } finally {
            db.endTransaction()
        }
    }

    companion object {
        fun toLong(v: Any?): Long? = when (v) {
            null, JSONObject.NULL -> null
            is Number -> v.toLong()
            is Boolean -> if (v) 1L else 0L
            is String -> v.toLongOrNull() ?: v.toDoubleOrNull()?.toLong()
            else -> null
        }
    }
}
