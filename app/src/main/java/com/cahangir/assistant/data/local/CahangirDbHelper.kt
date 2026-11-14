package com.cahangir.assistant.data.local

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class CahangirDbHelper private constructor(context: Context) : SQLiteOpenHelper(
    context.applicationContext, DATABASE_NAME, null, DATABASE_VERSION
) {
    companion object {
        const val DATABASE_NAME = "cahangir_local.db"
        const val DATABASE_VERSION = 2

        @Volatile
        private var instance: CahangirDbHelper? = null

        fun getInstance(context: Context): CahangirDbHelper {
            return instance ?: synchronized(this) {
                instance ?: run {
                    backupBeforeUpgrade(context.applicationContext)
                    CahangirDbHelper(context).also { instance = it }
                }
            }
        }

        /** Copies the database files before a schema upgrade so user data can always be restored. */
        private fun backupBeforeUpgrade(context: Context) {
            try {
                val dbFile = context.getDatabasePath(DATABASE_NAME)
                if (!dbFile.exists()) return
                val version = SQLiteDatabase.openDatabase(dbFile.path, null, SQLiteDatabase.OPEN_READONLY).use { it.version }
                if (version >= DATABASE_VERSION) return
                val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
                for (suffix in listOf("", "-wal", "-shm")) {
                    val src = File(dbFile.path + suffix)
                    if (src.exists()) src.copyTo(File(dbFile.parentFile, "cahangir_local.pre_v${DATABASE_VERSION}_$stamp.db$suffix"), overwrite = true)
                }
                Log.i("CahangirDB", "Pre-migration backup created (v$version -> v$DATABASE_VERSION)")
            } catch (e: Exception) {
                Log.e("CahangirDB", "Pre-migration backup failed", e)
            }
        }
    }

    override fun onConfigure(db: SQLiteDatabase) {
        super.onConfigure(db)
        db.enableWriteAheadLogging()
    }

    override fun onCreate(db: SQLiteDatabase) {
        createV1(db)
        upgradeToV2(db)
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        Log.i("CahangirDB", "Upgrading database from $oldVersion to $newVersion")
        if (oldVersion < 2) upgradeToV2(db)
    }

    /** Schema of app version 1 (kept so fresh installs and upgrades share one path). */
    private fun createV1(db: SQLiteDatabase) {
        db.execSQL("""CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default', text TEXT NOT NULL,
            due INTEGER, snooze INTEGER, done INTEGER NOT NULL DEFAULT 0, timer INTEGER NOT NULL DEFAULT 0, repeat TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, sync_status INTEGER NOT NULL DEFAULT 0);""")
        db.execSQL("""CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default', category TEXT NOT NULL DEFAULT 'general',
            fact_text TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1.0, source TEXT NOT NULL DEFAULT 'user', created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, sync_status INTEGER NOT NULL DEFAULT 0);""")
        db.execSQL("""CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'default', title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active', notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0, sync_status INTEGER NOT NULL DEFAULT 0);""")
        db.execSQL("""CREATE TABLE IF NOT EXISTS sync_queue (queue_id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL, sync_action TEXT NOT NULL, timestamp INTEGER NOT NULL);""")
    }

    private fun columns(db: SQLiteDatabase, table: String): Set<String> =
        db.rawQuery("PRAGMA table_info($table);", null).use { c ->
            val out = mutableSetOf<String>()
            while (c.moveToNext()) out.add(c.getString(1))
            out
        }

    private fun addColumn(db: SQLiteDatabase, table: String, decl: String) {
        if (decl.substringBefore(' ') !in columns(db, table)) db.execSQL("ALTER TABLE $table ADD COLUMN $decl;")
    }

    /** v2: planner entities, clipboard, revision tracking. Additive only. */
    private fun upgradeToV2(db: SQLiteDatabase) {
        for (spec in Entities.ALL) {
            val cols = spec.cols.joinToString(", ") { Entities.sqlDecl(it) }
            db.execSQL(
                "CREATE TABLE IF NOT EXISTS ${spec.name} (id TEXT PRIMARY KEY, $cols, created_at INTEGER NOT NULL, " +
                    "updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, sync_status INTEGER NOT NULL DEFAULT 1, " +
                    "server_rev INTEGER NOT NULL DEFAULT 0);"
            )
            for (c in spec.cols) addColumn(db, spec.name, Entities.sqlDecl(c))
            addColumn(db, spec.name, "sync_status INTEGER NOT NULL DEFAULT 1")
            addColumn(db, spec.name, "server_rev INTEGER NOT NULL DEFAULT 0")
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_${spec.name}_sync ON ${spec.name}(sync_status);")
            db.execSQL("CREATE INDEX IF NOT EXISTS idx_${spec.name}_upd ON ${spec.name}(updated_at);")
        }
        addColumn(db, "reminders", "fired_at INTEGER") // local-only alarm state
    }
}
