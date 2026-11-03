package com.cahangir.assistant.bridge

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import com.cahangir.assistant.calendar.CalendarIntegrationManager
import com.cahangir.assistant.data.local.dao.LocalMemory
import com.cahangir.assistant.data.local.dao.LocalProject
import com.cahangir.assistant.data.local.dao.LocalReminder
import com.cahangir.assistant.data.local.repository.CahangirRepository
import com.cahangir.assistant.devices.DeviceManager
import com.cahangir.assistant.p2p.P2pClient
import com.cahangir.assistant.p2p.P2pServer
import com.cahangir.assistant.p2p.P2pTransferStorage
import com.cahangir.assistant.security.SecurityManager
import com.cahangir.assistant.stt.SpeechRecognitionManager
import com.cahangir.assistant.sync.SyncApiClient
import com.cahangir.assistant.sync.SyncManager
import com.cahangir.assistant.sysinfo.SystemMetricsManager
import com.cahangir.assistant.tts.TextToSpeechEngine
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

class CahangirBridge(
    private val activity: Activity,
    private val webView: WebView,
    private val ttsEngine: TextToSpeechEngine,
    private val sttManager: SpeechRecognitionManager,
    private val p2pServer: P2pServer,
    private val p2pClient: P2pClient,
    private val metricsManager: SystemMetricsManager,
    private val onRequestAudioPermission: () -> Unit,
    private val onRequestCalendarPermission: (title: String, timeMillis: Long) -> Unit,
    private val onExportBackup: (jsonContent: String) -> Unit,
    private val onImportBackup: () -> Unit,
    private val onPickAndSendFile: (peerIp: String, peerPort: Int) -> Unit
) {

    private val mainHandler = Handler(Looper.getMainLooper())
    private val asyncExecutor = Executors.newCachedThreadPool()
    private val repository = CahangirRepository(activity)
    private val securityManager = SecurityManager(activity)
    private val transferStorage = P2pTransferStorage(activity)

    // --- 1. Səs (TTS) ---
    @JavascriptInterface
    fun speak(text: String) {
        mainHandler.post {
            ttsEngine.speak(
                text = text,
                onStart = { evaluateJs("window._ttsStarted && window._ttsStarted();") },
                onEnd = { evaluateJs("window._ttsEnded && window._ttsEnded();") }
            )
        }
    }

    @JavascriptInterface
    fun stopSpeak() {
        mainHandler.post {
            ttsEngine.stop()
        }
    }

    // --- 2. Səs Tanıma (STT) ---
    @JavascriptInterface
    fun listen() {
        mainHandler.post {
            onRequestAudioPermission()
            sttManager.startListening(
                onReady = { evaluateJs("if (typeof setMode === 'function') setMode('listening');") },
                onResult = { text ->
                    val quoted = JSONObject.quote(text)
                    evaluateJs("window._nativeHeard && window._nativeHeard($quoted);")
                },
                onError = {
                    evaluateJs("if (typeof setMode === 'function') setMode('idle'); if (typeof toast === 'function') toast('Səs tanınmadı');")
                }
            )
        }
    }

    @JavascriptInterface
    fun stopListen() {
        mainHandler.post {
            sttManager.stopListening()
        }
    }

    // --- 3. Offline-First Yerli Baza & Sinxronizasiya ---
    @JavascriptInterface
    fun syncFullStore(storeJsonStr: String) {
        try {
            val storeObj = JSONObject(storeJsonStr)
            val itemsArr = storeObj.optJSONArray("items") ?: JSONArray()
            val now = System.currentTimeMillis()

            for (i in 0 until itemsArr.length()) {
                val item = itemsArr.getJSONObject(i)
                val kind = item.optString("kind", "reminder")
                val id = item.optString("id", "")
                if (id.isBlank()) continue

                when (kind) {
                    "reminder" -> {
                        val rem = LocalReminder(
                            id = id,
                            text = item.optString("text", ""),
                            due = if (item.has("due") && !item.isNull("due")) item.optLong("due") else null,
                            snooze = if (item.has("snooze") && !item.isNull("snooze")) item.optLong("snooze") else null,
                            done = item.optBoolean("done", false),
                            timer = item.optBoolean("timer", false),
                            repeat = if (item.has("repeat") && !item.isNull("repeat")) item.optString("repeat") else null,
                            createdAt = item.optLong("created", now),
                            updatedAt = now,
                            deleted = false,
                            syncStatus = 1
                        )
                        repository.saveReminder(rem, isPendingSync = true)
                    }
                    "memory" -> {
                        val mem = LocalMemory(
                            id = id,
                            factText = item.optString("text", ""),
                            createdAt = item.optLong("created", now),
                            updatedAt = now,
                            deleted = false,
                            syncStatus = 1
                        )
                        repository.saveMemory(mem, isPendingSync = true)
                    }
                    "project" -> {
                        val prj = LocalProject(
                            id = id,
                            title = item.optString("text", ""),
                            createdAt = item.optLong("created", now),
                            updatedAt = now,
                            deleted = false,
                            syncStatus = 1
                        )
                        repository.saveProject(prj, isPendingSync = true)
                    }
                }
            }

            if (securityManager.isConfigured) {
                SyncManager.enqueueImmediateSync(activity)
            }
        } catch (e: Exception) {
            Log.e("CahangirBridge", "Failed to sync full store", e)
        }
    }

    @JavascriptInterface
    fun syncReminders(payloadJson: String) {
        syncFullStore(payloadJson)
    }

    // --- 4. Debian Server Konfiqurasiyası & Cihaz Qoşulması ---
    @JavascriptInterface
    fun configureServer(serverUrl: String, adminToken: String): String {
        val cleanUrl = serverUrl.trim().trimEnd('/')
        val (success, tokenOrErr) = SyncApiClient.registerDevice(
            serverUrl = cleanUrl,
            adminToken = adminToken.trim(),
            deviceId = securityManager.deviceId,
            deviceName = securityManager.deviceName
        )

        return if (success) {
            securityManager.serverUrl = cleanUrl
            securityManager.adminToken = adminToken.trim()
            securityManager.deviceToken = tokenOrErr
            SyncManager.enqueueImmediateSync(activity)
            JSONObject().apply {
                put("success", true)
                put("message", "Debian serverə uğurla qoşuldu!")
                put("serverUrl", cleanUrl)
            }.toString()
        } else {
            JSONObject().apply {
                put("success", false)
                put("error", tokenOrErr)
            }.toString()
        }
    }

    @JavascriptInterface
    fun getServerStatus(): String {
        return JSONObject().apply {
            put("isConfigured", securityManager.isConfigured)
            put("serverUrl", securityManager.serverUrl)
            put("adminToken", securityManager.adminToken)
            put("deviceId", securityManager.deviceId)
            put("deviceName", securityManager.deviceName)
            put("lastSync", securityManager.lastSyncTimestamp)
        }.toString()
    }

    @JavascriptInterface
    fun triggerSyncNow() {
        if (securityManager.isConfigured) {
            SyncManager.enqueueImmediateSync(activity)
            showToast("Sinxronizasiya başladıldı...")
        } else {
            showToast("Server ayarlanmayıb — oflayn rejim")
        }
    }

    // --- 5. P2P Server & Fayl Ötürmə (File Transfer) ---
    @JavascriptInterface
    fun getP2pServerStatus(): String {
        val ips = P2pServer.getNetworkIps()
        val ipsArr = JSONArray()
        ips.forEach { ipsArr.put(it) }

        return JSONObject().apply {
            put("isRunning", p2pServer.isServerRunning())
            put("port", 8767)
            put("ips", ipsArr)
            put("deviceId", securityManager.deviceId)
            put("deviceName", securityManager.deviceName)
        }.toString()
    }

    @JavascriptInterface
    fun pickAndSendFile(peerIp: String, peerPort: Int) {
        mainHandler.post {
            onPickAndSendFile(peerIp, if (peerPort > 0) peerPort else 8767)
        }
    }

    @JavascriptInterface
    fun cancelFileTransfer() {
        p2pClient.cancelTransfer()
    }

    @JavascriptInterface
    fun getTransferHistory(): String {
        val list = transferStorage.getTransfers()
        val arr = JSONArray()
        list.forEach { arr.put(it.toJsonObject()) }
        return arr.toString()
    }

    @JavascriptInterface
    fun clearTransferHistory() {
        transferStorage.clearTransfers()
    }

    // --- 6. Pano Sinxronizasiyası (Universal Clipboard) ---
    @JavascriptInterface
    fun sendClipboardToPeer(peerIp: String, peerPort: Int, text: String): String {
        val port = if (peerPort > 0) peerPort else 8767
        return try {
            val res = p2pClient.sendClipboard(peerIp, port, text)
            if (res.isSuccess) {
                JSONObject().apply {
                    put("success", true)
                    put("message", res.getOrNull())
                }.toString()
            } else {
                JSONObject().apply {
                    put("success", false)
                    put("error", res.exceptionOrNull()?.message ?: "Xəta baş verdi")
                }.toString()
            }
        } catch (e: Exception) {
            JSONObject().apply {
                put("success", false)
                put("error", e.message)
            }.toString()
        }
    }

    @JavascriptInterface
    fun getSystemClipboard(): String {
        return try {
            val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = cm.primaryClip
            if (clip != null && clip.itemCount > 0) {
                clip.getItemAt(0).coerceToText(activity).toString()
            } else ""
        } catch (_: Exception) {
            ""
        }
    }

    @JavascriptInterface
    fun copyToClipboard(text: String) {
        mainHandler.post {
            try {
                val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val clip = ClipData.newPlainText("Cahangir", text)
                cm.setPrimaryClip(clip)
                showToast("✓ Panoya kopyalandı")
            } catch (e: Exception) {
                Log.w("CahangirBridge", "Failed to copy", e)
            }
        }
    }

    // --- 7. Cihazlar (Devices & Connect) ---
    @JavascriptInterface
    fun listPairedDevices(serverUrl: String, adminToken: String): String {
        val sUrl = if (serverUrl.isNotBlank()) serverUrl else securityManager.serverUrl
        val aTok = if (adminToken.isNotBlank()) adminToken.trim() else securityManager.adminToken
        if (sUrl.isBlank()) {
            return JSONObject().apply {
                put("success", false)
                put("error", "Server ünvanı təyin olunmayıb")
            }.toString()
        }

        val res = DeviceManager.listDevices(sUrl, aTok)
        return if (res.isSuccess) {
            JSONObject().apply {
                put("success", true)
                put("devices", res.getOrNull())
            }.toString()
        } else {
            JSONObject().apply {
                put("success", false)
                put("error", res.exceptionOrNull()?.message ?: "Cihazlar alına bilmədi")
            }.toString()
        }
    }

    @JavascriptInterface
    fun revokePairedDevice(serverUrl: String, adminToken: String, deviceId: String): String {
        val sUrl = if (serverUrl.isNotBlank()) serverUrl else securityManager.serverUrl
        val aTok = if (adminToken.isNotBlank()) adminToken.trim() else securityManager.adminToken
        val res = DeviceManager.revokeDevice(sUrl, aTok, deviceId)
        return if (res.isSuccess) {
            JSONObject().apply {
                put("success", true)
            }.toString()
        } else {
            JSONObject().apply {
                put("success", false)
                put("error", res.exceptionOrNull()?.message ?: "Ləğv edilmədi")
            }.toString()
        }
    }

    // --- 8. Sistem Monitorinqi (System Metrics) ---
    @JavascriptInterface
    fun getSystemMetrics(): String {
        return try {
            metricsManager.collectMetrics().toString()
        } catch (e: Exception) {
            JSONObject().apply { put("error", e.message) }.toString()
        }
    }

    // --- 9. Təqvim & SAF Fayl Əməliyyatları ---
    @JavascriptInterface
    fun exportToCalendar(title: String, timeMillis: Long) {
        mainHandler.post {
            if (CalendarIntegrationManager.hasCalendarPermission(activity)) {
                val ok = CalendarIntegrationManager.addReminderToCalendar(activity, title, timeMillis)
                if (ok) showToast("✓ Təqvimə əlavə edildi")
            } else {
                onRequestCalendarPermission(title, timeMillis)
            }
        }
    }

    @JavascriptInterface
    fun exportBackupSaf(jsonContent: String) {
        mainHandler.post {
            onExportBackup(jsonContent)
        }
    }

    @JavascriptInterface
    fun importBackupSaf() {
        mainHandler.post {
            onImportBackup()
        }
    }

    // --- 10. Köməkçilər ---
    @JavascriptInterface
    fun setKeepScreenOn(keepAwake: Boolean) {
        mainHandler.post {
            if (keepAwake) {
                activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    @JavascriptInterface
    fun vibrate(durationMs: Long) {
        mainHandler.post {
            try {
                val dur = if (durationMs in 10..5000) durationMs else 100L
                val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    val vm = activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
                    vm?.defaultVibrator
                } else {
                    @Suppress("DEPRECATION")
                    activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
                }

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator?.vibrate(VibrationEffect.createOneShot(dur, VibrationEffect.DEFAULT_AMPLITUDE))
                } else {
                    @Suppress("DEPRECATION")
                    vibrator?.vibrate(dur)
                }
            } catch (e: Exception) {
                Log.w("CahangirBridge", "Vibration failed", e)
            }
        }
    }

    @JavascriptInterface
    fun showToast(msg: String) {
        mainHandler.post {
            Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show()
        }
    }

    @JavascriptInterface
    fun isNativeReady(): Boolean = true

    fun evaluateJs(script: String) {
        mainHandler.post {
            webView.evaluateJavascript(script, null)
        }
    }
}
