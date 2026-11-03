package com.cahangir.assistant.p2p

import android.content.Context
import org.json.JSONArray

class P2pTransferStorage(context: Context) {
    private val prefs = context.getSharedPreferences("cahangir_p2p_transfers", Context.MODE_PRIVATE)

    @Synchronized
    fun addTransfer(record: P2pTransferRecord) {
        val list = getTransfers().toMutableList()
        list.removeAll { it.id == record.id }
        list.add(0, record)
        val trimmed = if (list.size > 50) list.subList(0, 50) else list

        val arr = JSONArray()
        trimmed.forEach { arr.put(it.toJsonObject()) }
        prefs.edit().putString("transfers_json", arr.toString()).apply()
    }

    @Synchronized
    fun getTransfers(): List<P2pTransferRecord> {
        val jsonStr = prefs.getString("transfers_json", "[]") ?: "[]"
        val result = mutableListOf<P2pTransferRecord>()
        try {
            val arr = JSONArray(jsonStr)
            for (i in 0 until arr.length()) {
                val obj = arr.getJSONObject(i)
                result.add(P2pTransferRecord.fromJsonObject(obj))
            }
        } catch (_: Exception) {}
        return result
    }

    @Synchronized
    fun clearTransfers() {
        prefs.edit().remove("transfers_json").apply()
    }
}
