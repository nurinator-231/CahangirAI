package com.cahangir.assistant.data.local.dao

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import com.cahangir.assistant.data.local.CahangirDbHelper

data class LocalMemory(
    val id: String,
    val userId: String = "default",
    val category: String = "general",
    val factText: String,
    val confidence: Float = 1.0f,
    val source: String = "user",
    val createdAt: Long,
    val updatedAt: Long,
    val deleted: Boolean = false,
    val syncStatus: Int = 0
)

class MemoryDao(private val dbHelper: CahangirDbHelper) {

    fun upsert(item: LocalMemory, isPendingSync: Boolean = true) {
        val db = dbHelper.writableDatabase
        val values = ContentValues().apply {
            put("id", item.id)
            put("user_id", item.userId)
            put("category", item.category)
            put("fact_text", item.factText)
            put("confidence", item.confidence)
            put("source", item.source)
            put("created_at", item.createdAt)
            put("updated_at", item.updatedAt)
            put("deleted", if (item.deleted) 1 else 0)
            put("sync_status", if (isPendingSync) 1 else 0)
        }
        db.insertWithOnConflict("memories", null, values, SQLiteDatabase.CONFLICT_REPLACE)
    }

    fun getAll(): List<LocalMemory> {
        val db = dbHelper.readableDatabase
        val cursor = db.rawQuery("SELECT * FROM memories WHERE deleted = 0 ORDER BY updated_at DESC;", null)
        val list = mutableListOf<LocalMemory>()
        cursor.use { c ->
            while (c.moveToNext()) {
                list.add(cursorToMemory(c))
            }
        }
        return list
    }

    fun search(q: String): List<LocalMemory> {
        val db = dbHelper.readableDatabase
        val cursor = db.rawQuery(
            "SELECT * FROM memories WHERE deleted = 0 AND fact_text LIKE ? ORDER BY updated_at DESC;",
            arrayOf("%$q%")
        )
        val list = mutableListOf<LocalMemory>()
        cursor.use { c ->
            while (c.moveToNext()) {
                list.add(cursorToMemory(c))
            }
        }
        return list
    }

    fun getPendingSync(): List<LocalMemory> {
        val db = dbHelper.readableDatabase
        val cursor = db.rawQuery("SELECT * FROM memories WHERE sync_status = 1;", null)
        val list = mutableListOf<LocalMemory>()
        cursor.use { c ->
            while (c.moveToNext()) {
                list.add(cursorToMemory(c))
            }
        }
        return list
    }

    fun softDelete(id: String) {
        val db = dbHelper.writableDatabase
        val values = ContentValues().apply {
            put("deleted", 1)
            put("updated_at", System.currentTimeMillis())
            put("sync_status", 1)
        }
        db.update("memories", values, "id = ?", arrayOf(id))
    }

    fun markSynced(ids: List<String>) {
        if (ids.isEmpty()) return
        val db = dbHelper.writableDatabase
        db.beginTransaction()
        try {
            val values = ContentValues().apply { put("sync_status", 0) }
            for (id in ids) {
                db.update("memories", values, "id = ?", arrayOf(id))
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    private fun cursorToMemory(c: android.database.Cursor): LocalMemory {
        return LocalMemory(
            id = c.getString(c.getColumnIndexOrThrow("id")),
            userId = c.getString(c.getColumnIndexOrThrow("user_id")),
            category = c.getString(c.getColumnIndexOrThrow("category")),
            factText = c.getString(c.getColumnIndexOrThrow("fact_text")),
            confidence = c.getFloat(c.getColumnIndexOrThrow("confidence")),
            source = c.getString(c.getColumnIndexOrThrow("source")),
            createdAt = c.getLong(c.getColumnIndexOrThrow("created_at")),
            updatedAt = c.getLong(c.getColumnIndexOrThrow("updated_at")),
            deleted = c.getInt(c.getColumnIndexOrThrow("deleted")) == 1,
            syncStatus = c.getInt(c.getColumnIndexOrThrow("sync_status"))
        )
    }
}
