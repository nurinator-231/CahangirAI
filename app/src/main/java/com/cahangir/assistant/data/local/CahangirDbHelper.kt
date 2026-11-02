package com.cahangir.assistant.data.local

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.util.Log

class CahangirDbHelper(context: Context) : SQLiteOpenHelper(
    context.applicationContext,
    DATABASE_NAME,
    null,
    DATABASE_VERSION
) {

    companion object {
        const val DATABASE_NAME = "cahangir_local.db"
        const val DATABASE_VERSION = 1

        @Volatile
        private var instance: CahangirDbHelper? = null

        fun getInstance(context: Context): CahangirDbHelper {
            return instance ?: synchronized(this) {
                instance ?: CahangirDbHelper(context).also { instance = it }
            }
        }
    }

    override fun onConfigure(db: SQLiteDatabase) {
        super.onConfigure(db)
        db.enableWriteAheadLogging()
        db.setForeignKeyConstraintsEnabled(true)
    }

    override fun onCreate(db: SQLiteDatabase) {
        Log.i("CahangirDB", "Creating local SQLite database tables...")

        // 1. Reminders table
        db.execSQL(
            """
            CREATE TABLE reminders (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL DEFAULT 'default',
                text TEXT NOT NULL,
                due INTEGER,
                snooze INTEGER,
                done INTEGER NOT NULL DEFAULT 0,
                timer INTEGER NOT NULL DEFAULT 0,
                repeat TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0,
                sync_status INTEGER NOT NULL DEFAULT 0 -- 0=synced, 1=pending_sync
            );
            """
        )
        db.execSQL("CREATE INDEX idx_reminders_updated ON reminders(updated_at);")
        db.execSQL("CREATE INDEX idx_reminders_due ON reminders(due);")
        db.execSQL("CREATE INDEX idx_reminders_done ON reminders(done);")
        db.execSQL("CREATE INDEX idx_reminders_sync ON reminders(sync_status);")

        // 2. Memories table
        db.execSQL(
            """
            CREATE TABLE memories (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL DEFAULT 'default',
                category TEXT NOT NULL DEFAULT 'general',
                fact_text TEXT NOT NULL,
                confidence REAL NOT NULL DEFAULT 1.0,
                source TEXT NOT NULL DEFAULT 'user',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0,
                sync_status INTEGER NOT NULL DEFAULT 0
            );
            """
        )
        db.execSQL("CREATE INDEX idx_memories_updated ON memories(updated_at);")
        db.execSQL("CREATE INDEX idx_memories_deleted ON memories(deleted);")
        db.execSQL("CREATE INDEX idx_memories_category ON memories(category);")
        db.execSQL("CREATE INDEX idx_memories_sync ON memories(sync_status);")

        // 3. Projects table
        db.execSQL(
            """
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL DEFAULT 'default',
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                notes TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                deleted INTEGER NOT NULL DEFAULT 0,
                sync_status INTEGER NOT NULL DEFAULT 0
            );
            """
        )
        db.execSQL("CREATE INDEX idx_projects_updated ON projects(updated_at);")
        db.execSQL("CREATE INDEX idx_projects_deleted ON projects(deleted);")
        db.execSQL("CREATE INDEX idx_projects_sync ON projects(sync_status);")

        // 4. Sync queue table for offline synchronization
        db.execSQL(
            """
            CREATE TABLE sync_queue (
                queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
                entity_type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                sync_action TEXT NOT NULL,
                timestamp INTEGER NOT NULL
            );
            """
        )
        db.execSQL("CREATE INDEX idx_sync_queue_time ON sync_queue(timestamp);")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        Log.i("CahangirDB", "Upgrading database from $oldVersion to $newVersion")
        // Future migration branches handled here
    }
}
