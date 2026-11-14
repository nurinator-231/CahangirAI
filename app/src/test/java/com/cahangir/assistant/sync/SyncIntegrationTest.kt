package com.cahangir.assistant.sync

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** In-memory SyncStore with the same semantics as EntityStore (pending/ack/applyRemote). */
class MemStore : SyncStore {
    val rows = HashMap<String, HashMap<String, JSONObject>>()
    private fun t(e: String) = rows.getOrPut(e) { HashMap() }
    fun saveLocal(e: String, patch: JSONObject): JSONObject {
        val r = t(e)[patch.getString("id")] ?: JSONObject().put("created_at", System.currentTimeMillis()).put("deleted", 0).put("server_rev", 0)
        patch.keys().forEach { r.put(it, patch.get(it)) }
        r.put("updated_at", maxOf(System.currentTimeMillis(), r.optLong("updated_at") + 1)).put("sync_status", 1)
        t(e)[r.getString("id")] = r
        return r
    }
    override fun pending(entity: String) = t(entity).values.filter { it.optInt("sync_status") == 1 }.map { JSONObject(it.toString()) }
    override fun ack(entity: String, id: String, rev: Long, pushedUpdatedAt: Long) {
        val r = t(entity)[id] ?: return
        r.put("server_rev", rev); if (r.optLong("updated_at") == pushedUpdatedAt) r.put("sync_status", 0)
    }
    override fun applyRemote(entity: String, row: JSONObject, force: Boolean): Boolean {
        val local = t(entity)[row.getString("id")]
        if (local != null && local.optInt("sync_status") == 1 && !force) { local.put("server_rev", maxOf(local.optLong("server_rev"), row.optLong("server_rev"))); return false }
        t(entity)[row.getString("id")] = JSONObject(row.toString()).put("sync_status", 0)
        return true
    }
}

/**
 * Runs the real Kotlin sync engine against a live backend (scripts/integration-test.sh
 * passes -Pcahangir.testServer / -Pcahangir.testAdmin). Skipped otherwise.
 */
class SyncIntegrationTest {
    private val server = System.getProperty("cahangir.testServer", "")
    private val admin = System.getProperty("cahangir.testAdmin", "")
    private val entities = listOf("reminders", "memories", "projects", "tasks", "events", "plan_blocks", "clipboard_items")

    private fun register(id: String): String = SyncApiClient.registerDevice(server, admin, id, "android-test-$id").getOrThrow()

    @Test fun androidAndOtherDeviceConverge() {
        assumeTrue("set -Pcahangir.testServer to run", server.isNotBlank())
        val phone = MemStore(); val other = MemStore()
        val idA = "android_it_${System.nanoTime()}"; val idB = "win_it_${System.nanoTime()}"
        val tokA = register(idA); val tokB = register(idB)
        var revA = 0L; var revB = 0L
        fun syncA() = SyncEngine(phone, entities).run(SyncEngine.Config(server, tokA, idA, revA, 0)) { r, _ -> revA = r }
        fun syncB() = SyncEngine(other, entities).run(SyncEngine.Config(server, tokB, idB, revB, 0)) { r, _ -> revB = r }
        syncA(); syncB()

        // Phone creates a task + reminder; the other device receives them.
        phone.saveLocal("tasks", JSONObject().put("id", "t_phone").put("title", "Assignment").put("estimated_minutes", 120).put("priority", "high"))
        phone.saveLocal("reminders", JSONObject().put("id", "r_phone").put("text", "Deadline").put("due", 1_800_000_000_000L).put("repeat", "{\"type\":\"daily\"}"))
        val ra = syncA()
        assertEquals(2, ra.pushed)
        assertTrue(phone.pending("tasks").isEmpty())
        assertNotNull(ra.meshKey)
        syncB()
        assertEquals("Assignment", other.rows["tasks"]!!["t_phone"]!!.getString("title"))
        assertEquals("{\"type\":\"daily\"}", other.rows["reminders"]!!["r_phone"]!!.getString("repeat"))

        // The other device edits; the phone gets the edit (base_rev -> no conflict).
        other.saveLocal("tasks", JSONObject().put("id", "t_phone").put("title", "Assignment v2"))
        assertTrue(syncB().conflicts.isEmpty())
        syncA()
        assertEquals("Assignment v2", phone.rows["tasks"]!!["t_phone"]!!.getString("title"))

        // Deletion (tombstone) from the phone reaches the other device.
        phone.saveLocal("tasks", JSONObject().put("id", "t_phone").put("deleted", 1))
        syncA(); syncB()
        assertEquals(1, other.rows["tasks"]!!["t_phone"]!!.getInt("deleted"))

        // Revoked device gets a clear error.
        SyncApiClient.revokeDevice(server, admin, idA).getOrThrow()
        phone.saveLocal("tasks", JSONObject().put("id", "t2").put("title", "x"))
        val e = assertThrows(SyncEngine.SyncException::class.java) { syncA() }
        assertEquals(403, e.httpCode)
    }
}
