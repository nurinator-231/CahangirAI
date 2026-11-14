package com.cahangir.assistant.clipboard

import android.content.Context
import com.cahangir.assistant.data.local.repository.CahangirRepository
import com.cahangir.assistant.p2p.P2pClient
import com.cahangir.assistant.security.SecurityManager
import com.cahangir.assistant.sync.SyncApiClient
import org.json.JSONArray
import org.json.JSONObject

/**
 * Shares text with the user's other devices. Only called on an explicit user action
 * (button, share sheet) — Android does not allow background clipboard reading anyway.
 * The item is stored and synced through the Debian server (reaches offline devices
 * later) and pushed directly to reachable paired devices right away.
 * Must be called off the main thread.
 */
object ClipboardShare {
    fun share(context: Context, text: String): JSONObject {
        if (text.isBlank()) throw IllegalArgumentException("Pano boşdur")
        if (text.length > 100_000) throw IllegalArgumentException("Mətn çox uzundur (maksimum 100 KB)")
        val security = SecurityManager(context)
        val repo = CahangirRepository.get(context)
        val hash = ClipboardHub.hash(text)
        ClipboardHub.markSeen(hash)
        val item = repo.save("clipboard_items", JSONObject().put("text", text).put("hash", hash).put("origin_name", security.deviceName))
        val id = item.getString("id")
        val delivered = JSONArray()
        val failed = JSONArray()
        if (security.isConfigured && security.meshKey.isNotBlank()) {
            SyncApiClient.listPairedDevices(security.serverUrl, security.deviceToken).getOrNull()?.let { devs ->
                val client = P2pClient(context)
                for (i in 0 until devs.length()) {
                    val d = devs.getJSONObject(i)
                    if (d.optString("device_id") == security.deviceId) continue
                    val host = d.optJSONArray("p2p_hosts")?.optString(0)?.takeIf { it.isNotBlank() } ?: continue
                    val port = d.optInt("p2p_port", 0).takeIf { it > 0 } ?: continue
                    client.sendClipboard(host, port, id, text)
                        .onSuccess { delivered.put(d.optString("device_name")) }
                        .onFailure { failed.put(JSONObject().put("device", d.optString("device_name")).put("error", it.message)) }
                }
            }
        }
        return JSONObject().put("id", id).put("delivered_direct", delivered).put("failed_direct", failed).put("queued_for_sync", true)
    }
}
