package com.cahangir.assistant.p2p

import org.json.JSONObject

data class P2pTransferRecord(
    val id: String,
    val filename: String,
    val fileSize: Long,
    val direction: String, // "send" or "receive"
    val peerDevice: String,
    val status: String,    // "completed", "failed", "in_progress"
    val speedMbps: Double,
    val sha256: String,
    val timestamp: Long
) {
    fun toJsonObject(): JSONObject {
        return JSONObject().apply {
            put("id", id)
            put("filename", filename)
            put("file_size", fileSize)
            put("direction", direction)
            put("peer_device", peerDevice)
            put("status", status)
            put("speed_mbps", speedMbps)
            put("sha256", sha256)
            put("timestamp", timestamp)
        }
    }

    companion object {
        fun fromJsonObject(obj: JSONObject): P2pTransferRecord {
            return P2pTransferRecord(
                id = obj.optString("id", ""),
                filename = obj.optString("filename", ""),
                fileSize = obj.optLong("file_size", 0L),
                direction = obj.optString("direction", "receive"),
                peerDevice = obj.optString("peer_device", ""),
                status = obj.optString("status", "completed"),
                speedMbps = obj.optDouble("speed_mbps", 0.0),
                sha256 = obj.optString("sha256", ""),
                timestamp = obj.optLong("timestamp", System.currentTimeMillis())
            )
        }
    }
}
