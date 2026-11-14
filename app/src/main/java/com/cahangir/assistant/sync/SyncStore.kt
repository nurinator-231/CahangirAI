package com.cahangir.assistant.sync

import org.json.JSONObject

/** Storage operations the sync engine needs (SQLite in the app, in-memory in tests). */
interface SyncStore {
    fun pending(entity: String): List<JSONObject>
    fun ack(entity: String, id: String, rev: Long, pushedUpdatedAt: Long)
    fun applyRemote(entity: String, row: JSONObject, force: Boolean): Boolean
}
