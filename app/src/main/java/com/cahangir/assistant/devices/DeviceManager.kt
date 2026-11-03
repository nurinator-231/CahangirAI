package com.cahangir.assistant.devices

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

object DeviceManager {

    fun listDevices(serverUrl: String, adminToken: String): Result<JSONArray> {
        return try {
            val cleanUrl = serverUrl.trim().trimEnd('/')
            val encodedToken = URLEncoder.encode(adminToken.trim(), "UTF-8")
            val url = URL("$cleanUrl/api/auth/devices?admin_token=$encodedToken")
            val conn = url.openConnection() as HttpURLConnection
            conn.connectTimeout = 6000
            conn.readTimeout = 6000
            conn.requestMethod = "GET"

            val code = conn.responseCode
            if (code in 200..299) {
                val res = conn.inputStream.bufferedReader().readText()
                Result.success(JSONArray(res))
            } else {
                val err = conn.errorStream?.bufferedReader()?.readText() ?: "HTTP $code"
                Result.failure(Exception(err))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun revokeDevice(serverUrl: String, adminToken: String, deviceId: String): Result<Boolean> {
        return try {
            val cleanUrl = serverUrl.trim().trimEnd('/')
            val url = URL("$cleanUrl/api/auth/revoke-device")
            val conn = url.openConnection() as HttpURLConnection
            conn.connectTimeout = 6000
            conn.readTimeout = 6000
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            conn.doOutput = true

            val body = JSONObject().apply {
                put("admin_token", adminToken.trim())
                put("device_id", deviceId.trim())
            }.toString()

            conn.outputStream.use { os ->
                os.write(body.toByteArray(Charsets.UTF_8))
                os.flush()
            }

            val code = conn.responseCode
            if (code in 200..299) {
                Result.success(true)
            } else {
                val err = conn.errorStream?.bufferedReader()?.readText() ?: "HTTP $code"
                Result.failure(Exception(err))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }
}
