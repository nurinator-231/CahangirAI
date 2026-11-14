package com.cahangir.assistant.sync

import org.json.JSONArray
import org.json.JSONObject

/** Pairing and device-management calls to the Debian server. */
object SyncApiClient {

    /** Registers this device. The admin token is sent once in a header and never stored. */
    fun registerDevice(serverUrl: String, adminToken: String, deviceId: String, deviceName: String): Result<String> = try {
        val body = JSONObject().put("device_id", deviceId).put("device_name", deviceName).put("platform", "android").toString()
        val (code, text) = SyncEngine.http("POST", "${serverUrl.trimEnd('/')}/api/auth/register-device", null, body, 10000, mapOf("X-Admin-Token" to adminToken.trim()))
        when (code) {
            200 -> Result.success(JSONObject(text).getString("api_token"))
            403 -> Result.failure(Exception("Admin token yanlışdır."))
            429 -> Result.failure(Exception("Çox uğursuz cəhd — 10 dəqiqə sonra yenidən yoxlayın."))
            else -> Result.failure(Exception("HTTP $code: ${text.take(200)}"))
        }
    } catch (e: Exception) {
        Result.failure(e)
    }

    fun health(serverUrl: String): Result<JSONObject> = try {
        val (code, text) = SyncEngine.http("GET", "${serverUrl.trimEnd('/')}/api/health", null, null, 5000)
        if (code == 200) Result.success(JSONObject(text)) else Result.failure(Exception("HTTP $code"))
    } catch (e: Exception) {
        Result.failure(e)
    }

    fun listPairedDevices(serverUrl: String, deviceToken: String): Result<JSONArray> = try {
        val (code, text) = SyncEngine.http("GET", "${serverUrl.trimEnd('/')}/api/devices", deviceToken, null, 8000)
        if (code == 200) Result.success(JSONArray(text)) else Result.failure(Exception(SyncEngine.httpError(code, text)))
    } catch (e: Exception) {
        Result.failure(e)
    }

    fun revokeDevice(serverUrl: String, adminToken: String, deviceId: String): Result<Unit> = try {
        val body = JSONObject().put("device_id", deviceId).toString()
        val (code, text) = SyncEngine.http("POST", "${serverUrl.trimEnd('/')}/api/auth/revoke-device", null, body, 8000, mapOf("X-Admin-Token" to adminToken.trim()))
        when (code) {
            200 -> Result.success(Unit)
            403 -> Result.failure(Exception("Admin token yanlışdır."))
            else -> Result.failure(Exception("HTTP $code: ${text.take(200)}"))
        }
    } catch (e: Exception) {
        Result.failure(e)
    }

    /** Authenticated POST to the AI router; returns (http status, body). */
    fun aiPost(serverUrl: String, deviceToken: String, path: String, body: JSONObject): Pair<Int, String> =
        SyncEngine.http("POST", "${serverUrl.trimEnd('/')}$path", deviceToken, body.toString(), 60000)

    fun aiGet(serverUrl: String, deviceToken: String, path: String): Pair<Int, String> =
        SyncEngine.http("GET", "${serverUrl.trimEnd('/')}$path", deviceToken, null, 10000)
}
