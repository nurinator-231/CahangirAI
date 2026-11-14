package com.cahangir.assistant.security

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.util.UUID

/**
 * Credentials and sync bookkeeping, stored in EncryptedSharedPreferences (keys in the
 * Android Keystore). The admin pairing token is used once during pairing and is no
 * longer stored on the device.
 */
class SecurityManager(context: Context) {

    private val prefs: SharedPreferences = open(context.applicationContext)

    companion object {
        @Volatile
        private var cached: SharedPreferences? = null

        private fun open(ctx: Context): SharedPreferences = cached ?: synchronized(this) {
            cached ?: try {
                val masterKey = MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
                EncryptedSharedPreferences.create(
                    ctx, "cahangir_secure_vault", masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
                )
            } catch (e: Exception) {
                Log.e("SecurityManager", "EncryptedSharedPreferences unavailable; using private prefs", e)
                ctx.getSharedPreferences("cahangir_secure_vault_fallback", Context.MODE_PRIVATE)
            }.also { p ->
                // Migration: older versions stored the admin pairing token permanently.
                if (p.contains("admin_token") && !p.getString("device_token", "").isNullOrBlank()) p.edit().remove("admin_token").apply()
                cached = p
            }
        }
    }

    var serverUrl: String
        get() = prefs.getString("server_url", "") ?: ""
        set(value) = prefs.edit().putString("server_url", value.trim().trimEnd('/')).apply()

    var deviceToken: String
        get() = prefs.getString("device_token", "") ?: ""
        set(value) = prefs.edit().putString("device_token", value.trim()).apply()

    var deviceId: String
        get() {
            var id = prefs.getString("device_id", "") ?: ""
            if (id.isBlank()) {
                val model = Build.MODEL.replace(" ", "_").lowercase()
                id = "${model}_${UUID.randomUUID().toString().substring(0, 8)}"
                prefs.edit().putString("device_id", id).apply()
            }
            return id
        }
        set(value) = prefs.edit().putString("device_id", value).apply()

    var deviceName: String
        get() = prefs.getString("device_name", "${Build.MANUFACTURER} ${Build.MODEL}") ?: "${Build.MANUFACTURER} ${Build.MODEL}"
        set(value) = prefs.edit().putString("device_name", value.trim().take(100)).apply()

    /** v1 cursor (epoch ms) kept for compatibility. */
    var lastSyncTimestamp: Long
        get() = prefs.getLong("last_sync_timestamp", 0L)
        set(value) = prefs.edit().putLong("last_sync_timestamp", value).apply()

    /** v2 cursor: last server revision received. */
    var lastServerRev: Long
        get() = prefs.getLong("last_server_rev", 0L)
        set(value) = prefs.edit().putLong("last_server_rev", value).apply()

    var lastSyncStatus: String
        get() = prefs.getString("last_sync_status", "never") ?: "never"
        set(value) = prefs.edit().putString("last_sync_status", value).apply()

    var lastSyncError: String
        get() = prefs.getString("last_sync_error", "") ?: ""
        set(value) = prefs.edit().putString("last_sync_error", value.take(300)).apply()

    var meshKey: String
        get() = prefs.getString("mesh_key", "") ?: ""
        set(value) = prefs.edit().putString("mesh_key", value).apply()

    var meshKeyId: Long
        get() = prefs.getLong("mesh_key_id", 0L)
        set(value) = prefs.edit().putLong("mesh_key_id", value).apply()

    /** Minutes between background syncs (WorkManager minimum is 15). 0 = manual only. */
    var autoSyncMinutes: Int
        get() = prefs.getInt("auto_sync_minutes", 15)
        set(value) = prefs.edit().putInt("auto_sync_minutes", value).apply()

    var clipboardAccept: Boolean
        get() = prefs.getBoolean("clipboard_accept", true)
        set(value) = prefs.edit().putBoolean("clipboard_accept", value).apply()

    val isConfigured: Boolean
        get() = serverUrl.isNotBlank() && deviceToken.isNotBlank()

    fun clearCredentials() {
        prefs.edit()
            .remove("device_token").remove("mesh_key").remove("mesh_key_id")
            .remove("last_sync_timestamp").remove("last_server_rev").putString("last_sync_status", "never")
            .apply()
    }
}
