package com.cahangir.assistant.sync

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Sync protocol v2 (same as the Windows client): push pending rows with base_rev, pull
 * everything after the revision cursor, page until has_more=false, apply server-won
 * conflicts, refresh the P2P mesh key. Pure JVM code (no Android APIs) so it is
 * exercised by JVM tests against a real backend.
 */
class SyncEngine(private val store: SyncStore, private val entities: List<String>) {

    data class Config(
        val serverUrl: String,
        val deviceToken: String,
        val deviceId: String,
        val sinceRev: Long,
        val clientTimestamp: Long,
        val p2p: JSONObject? = null,
    )

    data class Report(
        var pushed: Int = 0,
        var appliedRemote: Int = 0,
        val conflicts: MutableList<JSONObject> = mutableListOf(),
        val rejected: MutableList<JSONObject> = mutableListOf(),
        var serverRev: Long = 0,
        var serverTimestamp: Long = 0,
        val incomingClipboard: MutableList<JSONObject> = mutableListOf(),
        val changedEntities: MutableSet<String> = mutableSetOf(),
        var meshKey: String? = null,
        var meshKeyId: Long = 0,
    )

    class SyncException(message: String, val httpCode: Int = 0) : Exception(message)

    fun run(cfg: Config, onCursor: (rev: Long, ts: Long) -> Unit = { _, _ -> }): Report {
        if (cfg.serverUrl.isBlank() || cfg.deviceToken.isBlank()) throw SyncException("Server qoşulmayıb (oflayn rejim).")
        val base = cfg.serverUrl.trimEnd('/')
        val report = Report()
        var since = cfg.sinceRev
        var first = true
        while (true) {
            val body = JSONObject()
                .put("device_id", cfg.deviceId)
                .put("since_rev", since)
                .put("client_timestamp", cfg.clientTimestamp)
            val pushed = mutableListOf<Triple<String, String, Long>>()
            if (first) {
                for (e in entities) {
                    val arr = JSONArray()
                    for (row in store.pending(e)) {
                        val r = JSONObject(row.toString())
                        val rev = r.optLong("server_rev", 0)
                        r.remove("sync_status"); r.remove("fired_at"); r.remove("server_rev")
                        r.put("base_rev", if (rev > 0) rev else JSONObject.NULL)
                        pushed.add(Triple(e, r.getString("id"), r.optLong("updated_at")))
                        arr.put(r)
                    }
                    body.put(e, arr)
                }
                cfg.p2p?.let { body.put("p2p", it) }
            }
            val (code, text) = http("POST", "$base/api/sync", cfg.deviceToken, body.toString())
            if (code !in 200..299) throw SyncException(httpError(code, text), code)
            val res = try { JSONObject(text) } catch (e: Exception) { throw SyncException("Server cavabı oxunmadı") }
            if (res.optInt("protocol", 1) < 2) throw SyncException("Server köhnə versiyadır; Debian backend-i yeniləyin.")

            val acks = res.optJSONObject("acks") ?: JSONObject()
            for ((e, id, upd) in pushed) {
                val m = acks.optJSONObject(e) ?: continue
                if (m.has(id)) { store.ack(e, id, m.getLong(id), upd); report.pushed++ }
            }
            val serverWon = mutableSetOf<String>()
            res.optJSONArray("conflicts")?.let { cs ->
                for (i in 0 until cs.length()) {
                    val c = cs.getJSONObject(i)
                    if (c.optString("winner") == "server") serverWon.add(c.optString("entity") + "/" + c.optString("id"))
                    report.conflicts.add(c)
                }
            }
            res.optJSONArray("rejected")?.let { r -> for (i in 0 until r.length()) report.rejected.add(r.getJSONObject(i)) }
            val delta = res.optJSONObject("delta") ?: JSONObject()
            for (e in entities) {
                val rows = delta.optJSONArray(e) ?: continue
                for (i in 0 until rows.length()) {
                    val row = rows.getJSONObject(i)
                    if (store.applyRemote(e, row, serverWon.contains(e + "/" + row.optString("id")))) {
                        report.appliedRemote++
                        report.changedEntities.add(e)
                        if (e == "clipboard_items" && row.optString("origin_device") != cfg.deviceId && row.optInt("deleted") != 1) {
                            report.incomingClipboard.add(row)
                        }
                    }
                }
            }
            since = res.optLong("server_rev", since)
            report.serverRev = since
            report.serverTimestamp = res.optLong("server_timestamp", System.currentTimeMillis())
            onCursor(since, report.serverTimestamp)
            first = false
            if (!res.optBoolean("has_more", false)) break
        }
        try {
            val (code, text) = http("GET", "$base/api/p2p/credentials", cfg.deviceToken, null)
            if (code == 200) {
                val o = JSONObject(text)
                report.meshKey = o.optString("mesh_key").takeIf { it.length == 64 }
                report.meshKeyId = o.optLong("key_id")
            }
        } catch (_: Exception) { /* key refresh is best effort */ }
        report.incomingClipboard.sortBy { it.optLong("created_at") }
        return report
    }

    companion object {
        fun httpError(code: Int, body: String): String = when (code) {
            401 -> "Bu cihaz serverdə tanınmır — yenidən cütləşdirin."
            403 -> "Bu cihazın girişi ləğv edilib (revoked)."
            429 -> "Server çox sorğu aldı, sonra yenidən cəhd ediləcək."
            else -> "Server xətası HTTP $code: ${body.take(200)}"
        }

        fun http(method: String, url: String, token: String?, body: String?, timeoutMs: Int = 20000, extraHeaders: Map<String, String> = emptyMap()): Pair<Int, String> {
            val conn = try {
                URL(url).openConnection() as HttpURLConnection
            } catch (e: Exception) {
                throw SyncException("Ünvan düzgün deyil: $url")
            }
            try {
                conn.requestMethod = method
                conn.connectTimeout = minOf(timeoutMs, 8000)
                conn.readTimeout = timeoutMs
                conn.setRequestProperty("Accept", "application/json")
                token?.let { conn.setRequestProperty("Authorization", "Bearer $it") }
                extraHeaders.forEach { (k, v) -> conn.setRequestProperty(k, v) }
                if (body != null) {
                    conn.doOutput = true
                    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
                val code = conn.responseCode
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
                return code to text
            } catch (e: IOException) {
                throw SyncException("Serverə qoşulmaq mümkün olmadı: ${e.message}")
            } finally {
                conn.disconnect()
            }
        }
    }
}
