package com.cahangir.assistant.bridge

import android.Manifest
import android.app.Activity
import android.app.AlarmManager
import android.app.NotificationManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import android.util.Log
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import androidx.core.content.ContextCompat
import com.cahangir.assistant.BuildConfig
import com.cahangir.assistant.alarm.ReminderScheduler
import com.cahangir.assistant.calendar.CalendarIntegrationManager
import com.cahangir.assistant.clipboard.ClipboardShare
import com.cahangir.assistant.data.local.Entities
import com.cahangir.assistant.data.local.repository.CahangirRepository
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

/**
 * JavaScript <-> native bridge. Native SQLite (EntityStore) is the single source of
 * truth for tasks, events, plan blocks, reminders, memories, projects and clipboard
 * items; the WebView only renders and edits through these methods. Network work runs
 * on a background executor and resolves a JS promise via window._nativeResolve.
 */
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
    private val onPickAndSendFile: (host: String, port: Int, peerName: String) -> Unit,
    private val onRequestNotificationPermission: () -> Unit,
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val io = Executors.newCachedThreadPool()
    private val repo = CahangirRepository.get(activity)
    private val security = SecurityManager(activity)
    private val transferStorage = P2pTransferStorage(activity)

    fun evaluateJs(script: String) = mainHandler.post { webView.evaluateJavascript(script, null) }

    private fun ok(v: Any?) = JSONObject().put("ok", true).put("value", v ?: JSONObject.NULL)
    private fun err(msg: String?) = JSONObject().put("ok", false).put("error", msg ?: "error")

    /** Runs `block` off the UI thread and resolves the JS promise `reqId`. */
    private fun async(reqId: String, block: () -> Any?) {
        io.execute {
            val res = try { ok(block()) } catch (e: Exception) { Log.w("CahangirBridge", "async failed", e); err(e.message) }
            evaluateJs("window._nativeResolve && window._nativeResolve(${JSONObject.quote(reqId)}, ${res});")
        }
    }

    // ---------------- Voice ----------------
    @JavascriptInterface
    fun speak(text: String) = mainHandler.post {
        ttsEngine.speak(text, onStart = { evaluateJs("window._ttsStarted && window._ttsStarted();") }, onEnd = { evaluateJs("window._ttsEnded && window._ttsEnded();") })
    }.let { }

    @JavascriptInterface
    fun stopSpeak() = mainHandler.post { ttsEngine.stop() }.let { }

    @JavascriptInterface
    fun listen() = mainHandler.post {
        onRequestAudioPermission()
        sttManager.startListening(
            onReady = { evaluateJs("if (typeof setMode === 'function') setMode('listening');") },
            onResult = { text -> evaluateJs("window._nativeHeard && window._nativeHeard(${JSONObject.quote(text)});") },
            onError = { evaluateJs("window._nativeListenError && window._nativeListenError();") }
        )
    }.let { }

    @JavascriptInterface
    fun stopListen() = mainHandler.post { sttManager.stopListening() }.let { }

    // ---------------- Data (native source of truth) ----------------
    private fun checkEntity(e: String) = require(e in Entities.NAMES) { "unknown entity $e" }

    @JavascriptInterface
    fun listEntities(entity: String, includeDeleted: Boolean): String {
        checkEntity(entity)
        return repo.store.listJson(entity, includeDeleted)
    }

    @JavascriptInterface
    fun saveEntity(entity: String, json: String): String = try {
        checkEntity(entity)
        repo.save(entity, JSONObject(json)).toString()
    } catch (e: Exception) {
        err(e.message).toString()
    }

    @JavascriptInterface
    fun saveEntities(entity: String, jsonArray: String): String = try {
        checkEntity(entity)
        val arr = JSONArray(jsonArray)
        val out = JSONArray()
        repo.store.inTransaction { for (i in 0 until arr.length()) out.put(repo.store.saveLocal(entity, arr.getJSONObject(i))) }
        repo.notifyDataChanged(listOf(entity))
        SyncManager.enqueueImmediateSync(activity)
        out.toString()
    } catch (e: Exception) {
        err(e.message).toString()
    }

    @JavascriptInterface
    fun deleteEntity(entity: String, id: String): Boolean {
        checkEntity(entity)
        return repo.delete(entity, id)
    }

    @JavascriptInterface
    fun completeReminder(id: String) = ReminderScheduler.complete(activity, id)

    @JavascriptInterface
    fun snoozeReminder(id: String, minutes: Int) = ReminderScheduler.snooze(activity, id, minutes.coerceIn(1, 1440) * 60_000L)

    @JavascriptInterface
    fun setUserName(name: String) {
        activity.getSharedPreferences("cahangir_prefs", Context.MODE_PRIVATE).edit().putString("user_name", name.take(60)).apply()
    }

    // ---------------- Server, pairing, sync ----------------
    @JavascriptInterface
    fun getServerStatus(): String = JSONObject()
        .put("isConfigured", security.isConfigured)
        .put("serverUrl", security.serverUrl)
        .put("deviceId", security.deviceId)
        .put("deviceName", security.deviceName)
        .put("lastSync", security.lastSyncTimestamp)
        .put("lastServerRev", security.lastServerRev)
        .put("status", security.lastSyncStatus)
        .put("error", security.lastSyncError)
        .put("pending", repo.store.pendingCount())
        .put("autoSyncMinutes", security.autoSyncMinutes)
        .put("clipboardAccept", security.clipboardAccept)
        .put("p2pReady", security.meshKey.isNotBlank())
        .put("appVersion", BuildConfig.VERSION_NAME)
        .toString()

    /** Pairs this phone. The admin token is used once and is not stored. */
    @JavascriptInterface
    fun pair(reqId: String, serverUrl: String, adminToken: String, deviceName: String) = async(reqId) {
        val url = serverUrl.trim().trimEnd('/')
        if (deviceName.isNotBlank()) security.deviceName = deviceName
        val token = SyncApiClient.registerDevice(url, adminToken, security.deviceId, security.deviceName).getOrThrow()
        val changedServer = security.serverUrl != url
        security.serverUrl = url
        security.deviceToken = token
        if (changedServer) { security.lastServerRev = 0; security.lastSyncTimestamp = 0 }
        SyncManager.schedulePeriodicSync(activity)
        try { SyncManager(activity).performSync() } catch (e: Exception) { Log.w("CahangirBridge", "first sync failed", e) }
        JSONObject(getServerStatus())
    }

    @JavascriptInterface
    fun unpair() {
        security.clearCredentials()
        SyncManager.schedulePeriodicSync(activity)
    }

    @JavascriptInterface
    fun testServer(reqId: String, serverUrl: String) = async(reqId) { SyncApiClient.health(serverUrl.trim()).getOrThrow() }

    @JavascriptInterface
    fun syncNow(reqId: String) = async(reqId) {
        val r = SyncManager(activity).performSync()
        JSONObject().put("pushed", r.pushed).put("received", r.appliedRemote).put("conflicts", r.conflicts.size)
    }

    @JavascriptInterface
    fun setAutoSyncMinutes(minutes: Int) {
        security.autoSyncMinutes = if (minutes <= 0) 0 else maxOf(15, minutes)
        SyncManager.schedulePeriodicSync(activity)
    }

    @JavascriptInterface
    fun setClipboardAccept(accept: Boolean) { security.clipboardAccept = accept }

    @JavascriptInterface
    fun listPairedDevices(reqId: String) = async(reqId) { SyncApiClient.listPairedDevices(security.serverUrl, security.deviceToken).getOrThrow() }

    @JavascriptInterface
    fun revokeDevice(reqId: String, adminToken: String, deviceId: String) = async(reqId) {
        SyncApiClient.revokeDevice(security.serverUrl, adminToken, deviceId).getOrThrow(); true
    }

    @JavascriptInterface
    fun listConflicts(reqId: String) = async(reqId) {
        val (c, t) = SyncApiClient.aiGet(security.serverUrl, security.deviceToken, "/api/sync/conflicts")
        if (c == 200) JSONArray(t) else throw Exception("HTTP $c")
    }

    // ---------------- AI (Debian free-tier router) ----------------
    @JavascriptInterface
    fun aiProviders(reqId: String) = async(reqId) {
        if (!security.isConfigured) throw Exception("Server qoşulmayıb")
        val (c, t) = SyncApiClient.aiGet(security.serverUrl, security.deviceToken, "/api/ai/providers")
        if (c == 200) JSONObject(t) else throw Exception("HTTP $c")
    }

    @JavascriptInterface
    fun aiPost(reqId: String, path: String, bodyJson: String) = async(reqId) {
        require(path == "/api/ai/parse" || path == "/api/ai/chat") { "invalid path" }
        if (!security.isConfigured) throw Exception("Server qoşulmayıb")
        val (c, t) = SyncApiClient.aiPost(security.serverUrl, security.deviceToken, path, JSONObject(bodyJson))
        JSONObject().put("status", c).put("body", try { JSONObject(t) } catch (_: Exception) { JSONObject().put("detail", t.take(300)) })
    }

    // ---------------- P2P file transfer ----------------
    @JavascriptInterface
    fun getP2pServerStatus(): String = JSONObject()
        .put("isRunning", p2pServer.isServerRunning())
        .put("port", P2pServer.DEFAULT_PORT)
        .put("ips", JSONArray(P2pServer.getNetworkIps()))
        .put("deviceId", security.deviceId)
        .put("deviceName", security.deviceName)
        .put("p2pReady", security.meshKey.isNotBlank())
        .toString()

    @JavascriptInterface
    fun pingPeer(reqId: String, host: String, port: Int) = async(reqId) { p2pClient.ping(host, if (port > 0) port else P2pServer.DEFAULT_PORT).getOrThrow() }

    @JavascriptInterface
    fun pickAndSendFile(host: String, port: Int, peerName: String) = mainHandler.post {
        onPickAndSendFile(host, if (port > 0) port else P2pServer.DEFAULT_PORT, peerName)
    }.let { }

    @JavascriptInterface
    fun cancelFileTransfer() = p2pClient.cancelTransfer()

    @JavascriptInterface
    fun getTransferHistory(): String = JSONArray(transferStorage.getTransfers().map { it.toJsonObject() }).toString()

    @JavascriptInterface
    fun clearTransferHistory() = transferStorage.clearTransfers()

    // ---------------- Clipboard ----------------
    /** Reads the clipboard (user just tapped the button, app in foreground) and shares it. */
    @JavascriptInterface
    fun shareClipboard(reqId: String, textOrEmpty: String) {
        val text = if (textOrEmpty.isNotEmpty()) textOrEmpty else getSystemClipboard()
        async(reqId) { ClipboardShare.share(activity, text) }
    }

    @JavascriptInterface
    fun getSystemClipboard(): String = try {
        val cm = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(activity)?.toString() ?: ""
    } catch (_: Exception) { "" }

    @JavascriptInterface
    fun copyToClipboard(text: String) = mainHandler.post {
        try {
            com.cahangir.assistant.clipboard.ClipboardHub.markSeen(com.cahangir.assistant.clipboard.ClipboardHub.hash(text))
            (activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Cahangir", text))
            showToast("✓ Panoya kopyalandı")
        } catch (e: Exception) { Log.w("CahangirBridge", "copy failed", e) }
    }.let { }

    // ---------------- Permissions & reliability ----------------
    @JavascriptInterface
    fun getPermissionStatus(): String {
        val nm = activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val notif = if (Build.VERSION.SDK_INT >= 33) ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED else nm.areNotificationsEnabled()
        return JSONObject()
            .put("notifications", notif && nm.areNotificationsEnabled())
            .put("exactAlarms", ReminderScheduler.canScheduleExact(activity))
            .put("fullScreen", Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent())
            .put("microphone", ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
            .toString()
    }

    @JavascriptInterface
    fun requestNotificationPermission() = mainHandler.post { onRequestNotificationPermission() }.let { }

    @JavascriptInterface
    fun openPermissionSettings(kind: String) = mainHandler.post {
        val pkg = Uri.parse("package:${activity.packageName}")
        val intent = when {
            kind == "exact" && Build.VERSION.SDK_INT >= 31 -> Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, pkg)
            kind == "fullscreen" && Build.VERSION.SDK_INT >= 34 -> Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg)
            kind == "battery" -> Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
            else -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
        }
        try { activity.startActivity(intent) } catch (e: Exception) {
            activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg))
        }
    }.let { }

    // ---------------- System, calendar, backup, misc ----------------
    @JavascriptInterface
    fun getSystemMetrics(): String = try { metricsManager.collectMetrics().toString() } catch (e: Exception) { err(e.message).toString() }

    @JavascriptInterface
    fun exportToCalendar(title: String, timeMillis: Long) = mainHandler.post {
        if (CalendarIntegrationManager.hasCalendarPermission(activity)) {
            if (CalendarIntegrationManager.addReminderToCalendar(activity, title, timeMillis)) showToast("✓ Təqvimə əlavə edildi")
        } else onRequestCalendarPermission(title, timeMillis)
    }.let { }

    @JavascriptInterface
    fun exportBackupSaf(jsonContent: String) = mainHandler.post { onExportBackup(jsonContent) }.let { }

    @JavascriptInterface
    fun importBackupSaf() = mainHandler.post { onImportBackup() }.let { }

    @JavascriptInterface
    fun setKeepScreenOn(keepAwake: Boolean) = mainHandler.post {
        if (keepAwake) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }.let { }

    @JavascriptInterface
    fun vibrate(durationMs: Long) = mainHandler.post {
        try {
            val dur = if (durationMs in 10..5000) durationMs else 100L
            val v = if (Build.VERSION.SDK_INT >= 31) (activity.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
            else @Suppress("DEPRECATION") (activity.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator)
            v?.vibrate(VibrationEffect.createOneShot(dur, VibrationEffect.DEFAULT_AMPLITUDE))
        } catch (e: Exception) { Log.w("CahangirBridge", "Vibration failed", e) }
    }.let { }

    @JavascriptInterface
    fun showToast(msg: String) = mainHandler.post { Toast.makeText(activity, msg, Toast.LENGTH_SHORT).show() }.let { }

    @JavascriptInterface
    fun isNativeReady(): Boolean = true

    @JavascriptInterface
    fun appVersion(): String = BuildConfig.VERSION_NAME
}
