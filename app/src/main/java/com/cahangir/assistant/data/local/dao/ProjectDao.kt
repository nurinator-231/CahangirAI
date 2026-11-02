package com.cahangir.assistant.data.local.dao

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import com.cahangir.assistant.data.local.CahangirDbHelper

data class LocalProject(
    val id: String,
    val userId: String = "default",
    val title: String,
    val status: String = "active",
    val notes: String = "",
    val createdAt: Long,
    val updatedAt: Long,
    val deleted: Boolean = false,
    val syncStatus: Int = 0
)

class ProjectDao(private val dbHelper: CahangirDbHelper) {

    fun upsert(item: LocalProject, isPendingSync: Boolean = true) {
        val db = dbHelper.writableDatabase
        val values = ContentValues().apply {
            put("id", item.id)
            put("user_id", item.userId)
            put("title", item.title)
            put("status", item.status)
            put("notes", item.notes)
            put("created_at", item.createdAt)
            put("updated_at", item.updatedAt)
            put("deleted", if (item.deleted) 1 else 0)
            put("sync_status", if (isPendingSync) 1 else 0)
        }
        db.insertWithOnConflict("projects", null, values, SQLiteDatabase.CONFLICT_REPLACE)
    }

    fun getAll(): List<LocalProject> {
        val db = dbHelper.readableDatabase
        val cursor = db.rawQuery("SELECT * FROM projects WHERE deleted = 0 ORDER BY updated_at DESC;", null)
        val list = mutableListOf<LocalProject>()
        cursor.use { c ->
            while (c.moveToNext()) {
                list.add(cursorToProject(c))
            }
        }
        return list
    }

    fun getPendingSync(): List<LocalProject> {
        val db = dbHelper.readableDatabase
        val cursor = db.rawQuery("SELECT * FROM projects WHERE sync_status = 1;", null)
        val list = mutableListOf<LocalProject>()
        cursor.use { c ->
            while (c.moveToNext()) {
                list.add(cursorToProject(c))
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
        db.update("projects", values, "id = ?", arrayOf(id))
    }

    fun markSynced(ids: List<String>) {
        if (ids.isEmpty()) return
        val db = dbHelper.writableDatabase
        db.beginTransaction()
        try {
            val values = ContentValues().apply { put("sync_status", 0) }
            for (id in ids) {
                db.update("projects", values, "id = ?", arrayOf(id))
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    private fun cursorToProject(c: android.database.Cursor): LocalProject {
        return LocalProject(
            id = c.getString(c.getColumnIndexOrThrow("id")),
            userId = c.getString(c.getColumnIndexOrThrow("user_id")),
            title = c.getString(c.getColumnIndexOrThrow("title")),
            status = c.getString(c.getColumnIndexOrThrow("status")),
            notes = c.getString(c.getColumnIndexOrThrow("notes")),
            createdAt = c.getLong(c.getColumnIndexOrThrow("created_at")),
            updatedAt = c.getLong(c.getColumnIndexOrThrow("updated_at")),
            deleted = c.getInt(c.getColumnIndexOrThrow("deleted")) == 1,
            syncStatus = c.getInt(c.getColumnIndexOrThrow("sync_status"))
        )
    }
}
