package com.cahangir.assistant.sync

import android.util.Log
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

object SyncApiClient {

    private const val CONNECT_TIMEOUT_MS = 6000
    private const val READ_TIMEOUT_MS = 12000

    fun registerDevice(
        serverUrl: String,
        adminToken: String,
        deviceId: String,
        deviceName: String
    ): Pair<Boolean, String> {
        val endpoint = "${serverUrl.trimEnd('/')}/api/auth/register-device"
        val payload = JSONObject().apply {
            put("admin_token", adminToken)
            put("device_id", deviceId)
            put("device_name", deviceName)
        }.toString()

        return try {
            val url = URL(endpoint)
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }

            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(payload) }

            val code = conn.responseCode
            if (code == 200) {
                val resp = conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                val json = JSONObject(resp)
                val token = json.getString("api_token")
                Pair(true, token)
            } else {
                val err = conn.errorStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: "HTTP $code"
                Pair(false, err)
            }
        } catch (e: Exception) {
            Log.e("SyncApiClient", "Failed to register device", e)
            Pair(false, e.message ?: "Network connection error")
        }
    }

    fun executeSync(
        serverUrl: String,
        deviceToken: String,
        payloadJson: String
    ): Pair<Boolean, String> {
        val endpoint = "${serverUrl.trimEnd('/')}/api/sync"
        return try {
            val url = URL(endpoint)
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Authorization", "Bearer $deviceToken")
            }

            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(payloadJson) }

            val code = conn.responseCode
            if (code == 200) {
                val resp = conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                Pair(true, resp)
            } else {
                val err = conn.errorStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: "HTTP $code"
                Pair(false, err)
            }
        } catch (e: Exception) {
            Log.w("SyncApiClient", "Sync request failed: ${e.message}")
            Pair(false, e.message ?: "Sync connection failed")
        }
    }

    fun checkHealth(serverUrl: String): Boolean {
        val endpoint = "${serverUrl.trimEnd('/')}/api/health"
        return try {
            val url = URL(endpoint)
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 3000
                readTimeout = 3000
            }
            conn.responseCode == 200
        } catch (_: Exception) {
            false
        }
    }
}
