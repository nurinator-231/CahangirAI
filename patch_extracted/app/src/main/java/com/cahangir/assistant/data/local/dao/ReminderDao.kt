package com.cahangir.assistant.data.local.dao

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import com.cahangir.assistant.data.local.CahangirDbHelper

data class LocalReminder(
    val id: String,
    val userId: String = "default",
    val text: String,
    val due: Long?,
    val snooze: Long?,
    val done: Boolean,
    val timer: Boolean,
    val repeat: String?,
    val createdAt: Long,
    val updatedAt: Long,
    val deleted: Boolean = false,
    val syncStatus: Int = 0 // 0=synced, 1=pending
) {
    val effectiveTime: Long?
        get() = when {
            snooze != null && snooze > 0 -> snooze
            due != null && due > 0 -> due
            else -> null
        }
}

class ReminderDao(private val dbHelper: CahangirDbHelper) {

    fun upsert(item: LocalReminder, isPendingSync: Boolean = true) {
        val db = dbHelper.writableDatabase
        val values = ContentValues().apply {
            put("id", item.id)
            put("user_id", item.userId)
            put("text", item.text)
            put("due", item.due)
            put("snooze", item.snooze)
            put("done", if (item.done) 1 else 0)
            put("timer", if (item.timer) 1 else 0)
            put("repeat", item.repeat)
            put("created_at", item.createdAt)
            put("updated_at", item.updatedAt)
            put("deleted", if (item.deleted) 1 else 0)
            put("sync_status", if (isPendingSync) 1 else 0)
        }
        db.insertWithOnConflict("reminders", null, values, SQLiteDatabase.CONFLICT_REPLACE)
    }

    fun getAllActive(): List<LocalReminder> {
        val db = dbHelper.readableDatabase
        val cursor = db.rawQuery(
            """
            SELECT * FROM reminders 
            WHERE deleted = 0 AND done = 0 
            ORDER BY CASE WHEN snooze IS NOT NULL AND snooze > 0 THEN snooze ELSE due END ASC;
            """,
            null
        )
        val list = mutableListOf<LocalReminder>()
        cursor.use { c ->
            while (c.moveToNext()) {
                list.add(cursorToReminder(c))
            }
        }
        return list
    }

    fun getAll(): List<LocalReminder> {
        val db = dbHelper.readableDatabase
        val cursor = db.rawQuery("SELECT * FROM reminders WHERE deleted = 0 ORDER BY updated_at DESC;", null)
        val list = mutableListOf<LocalReminder>()
        cursor.use { c ->
            while (c.moveToNext()) {
                list.add(cursorToReminder(c))
            }
        }
        return list
    }

    fun getPendingSync(): List<LocalReminder> {
        val db = dbHelper.readableDatabase
        val cursor = db.rawQuery("SELECT * FROM reminders WHERE sync_status = 1;", null)
        val list = mutableListOf<LocalReminder>()
        cursor.use { c ->
            while (c.moveToNext()) {
                list.add(cursorToReminder(c))
            }
        }
        return list
    }

    fun markDone(id: String, done: Boolean) {
        val db = dbHelper.writableDatabase
        val values = ContentValues().apply {
            put("done", if (done) 1 else 0)
            put("updated_at", System.currentTimeMillis())
            put("sync_status", 1)
        }
        db.update("reminders", values, "id = ?", arrayOf(id))
    }

    fun snooze(id: String, snoozeUntil: Long) {
        val db = dbHelper.writableDatabase
        val values = ContentValues().apply {
            put("snooze", snoozeUntil)
            put("updated_at", System.currentTimeMillis())
            put("sync_status", 1)
        }
        db.update("reminders", values, "id = ?", arrayOf(id))
    }

    fun softDelete(id: String) {
        val db = dbHelper.writableDatabase
        val values = ContentValues().apply {
            put("deleted", 1)
            put("updated_at", System.currentTimeMillis())
            put("sync_status", 1)
        }
        db.update("reminders", values, "id = ?", arrayOf(id))
    }

    fun markSynced(ids: List<String>) {
        if (ids.isEmpty()) return
        val db = dbHelper.writableDatabase
        db.beginTransaction()
        try {
            val values = ContentValues().apply { put("sync_status", 0) }
            for (id in ids) {
                db.update("reminders", values, "id = ?", arrayOf(id))
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun getById(id: String): LocalReminder? {
        val db = dbHelper.readableDatabase
        return db.rawQuery("SELECT * FROM reminders WHERE id = ?;", arrayOf(id)).use { c ->
            if (c.moveToFirst()) cursorToReminder(c) else null
        }
    }

    /** Yalnız göndərilən andan bəri dəyişməyibsə synced işarələ (sorğu zamanı edilən redaktə itməsin). */
    fun markSyncedIfUnchanged(pushed: List<LocalReminder>) {
        if (pushed.isEmpty()) return
        val db = dbHelper.writableDatabase
        db.beginTransaction()
        try {
            val values = ContentValues().apply { put("sync_status", 0) }
            for (item in pushed) {
                db.update("reminders", values, "id = ? AND updated_at = ?", arrayOf(item.id, item.updatedAt.toString()))
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    /** Serverdən gələn qeydi LWW qaydası ilə yaz. Yazılıbsa true qaytarır. */
    fun upsertFromServer(item: LocalReminder): Boolean {
        val local = getById(item.id)
        val ok = com.cahangir.assistant.sync.SyncRules.shouldApplyServerItem(
            local?.updatedAt, local?.syncStatus == 1, item.updatedAt
        )
        if (!ok) return false
        upsert(item, isPendingSync = false)
        return true
    }

    private fun cursorToReminder(c: android.database.Cursor): LocalReminder {
        val dueIdx = c.getColumnIndexOrThrow("due")
        val snoozeIdx = c.getColumnIndexOrThrow("snooze")
        val repeatIdx = c.getColumnIndexOrThrow("repeat")

        return LocalReminder(
            id = c.getString(c.getColumnIndexOrThrow("id")),
            userId = c.getString(c.getColumnIndexOrThrow("user_id")),
            text = c.getString(c.getColumnIndexOrThrow("text")),
            due = if (c.isNull(dueIdx)) null else c.getLong(dueIdx),
            snooze = if (c.isNull(snoozeIdx)) null else c.getLong(snoozeIdx),
            done = c.getInt(c.getColumnIndexOrThrow("done")) == 1,
            timer = c.getInt(c.getColumnIndexOrThrow("timer")) == 1,
            repeat = if (c.isNull(repeatIdx)) null else c.getString(repeatIdx),
            createdAt = c.getLong(c.getColumnIndexOrThrow("created_at")),
            updatedAt = c.getLong(c.getColumnIndexOrThrow("updated_at")),
            deleted = c.getInt(c.getColumnIndexOrThrow("deleted")) == 1,
            syncStatus = c.getInt(c.getColumnIndexOrThrow("sync_status"))
        )
    }
}
