package com.cahangir.assistant.sync

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.work.*
import com.cahangir.assistant.BuildConfig
import com.cahangir.assistant.clipboard.ClipboardHub
import com.cahangir.assistant.data.local.Entities
import com.cahangir.assistant.data.local.repository.CahangirRepository
import com.cahangir.assistant.p2p.P2pServer
import com.cahangir.assistant.security.SecurityManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class SyncManager(private val context: Context) {

    private val repository = CahangirRepository.get(context)
    private val security = SecurityManager(context)

    /** Runs one full sync. Returns the report, or throws SyncEngine.SyncException. */
    @Synchronized
    fun performSync(): SyncEngine.Report {
        val p2p = JSONObject()
            .put("hosts", JSONArray(P2pServer.getNetworkIps().take(8)))
            .put("port", P2pServer.DEFAULT_PORT)
            .put("platform", "android")
            .put("app_version", BuildConfig.VERSION_NAME)
        val cfg = SyncEngine.Config(
            serverUrl = security.serverUrl,
            deviceToken = security.deviceToken,
            deviceId = security.deviceId,
            sinceRev = security.lastServerRev,
            clientTimestamp = security.lastSyncTimestamp,
            p2p = p2p,
        )
        try {
            val report = SyncEngine(repository.store, Entities.NAMES).run(cfg) { rev, ts ->
                security.lastServerRev = rev
                security.lastSyncTimestamp = ts
            }
            report.meshKey?.let { if (it != security.meshKey) { security.meshKey = it; security.meshKeyId = report.meshKeyId } }
            security.lastSyncStatus = "ok"
            security.lastSyncError = ""
            if (report.changedEntities.isNotEmpty()) repository.notifyDataChanged(report.changedEntities)
            applyIncomingClipboard(report.incomingClipboard)
            Log.i("SyncManager", "Sync ok: pushed=${report.pushed} received=${report.appliedRemote} rev=${report.serverRev}")
            return report
        } catch (e: SyncEngine.SyncException) {
            security.lastSyncStatus = "error"
            security.lastSyncError = e.message ?: "error"
            throw e
        }
    }

    private fun applyIncomingClipboard(items: List<JSONObject>) {
        val newest = items.lastOrNull() ?: return
        if (!security.clipboardAccept) return
        if (System.currentTimeMillis() - newest.optLong("created_at") > 10 * 60 * 1000) return
        val text = newest.optString("text")
        val hash = ClipboardHub.hash(text)
        if (!ClipboardHub.markSeen(hash)) return
        Handler(Looper.getMainLooper()).post {
            try {
                val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("Cahangir", text))
            } catch (e: Exception) {
                Log.w("SyncManager", "Could not set clipboard", e)
            }
        }
    }

    companion object {
        private const val PERIODIC_SYNC_TAG = "cahangir_periodic_sync"
        private const val IMMEDIATE_SYNC_TAG = "cahangir_immediate_sync"

        fun schedulePeriodicSync(context: Context) {
            val minutes = SecurityManager(context).autoSyncMinutes
            val wm = WorkManager.getInstance(context)
            if (minutes <= 0) {
                wm.cancelUniqueWork(PERIODIC_SYNC_TAG)
                return
            }
            val request = PeriodicWorkRequestBuilder<SyncWorker>(maxOf(15L, minutes.toLong()), TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                .addTag(PERIODIC_SYNC_TAG)
                .build()
            wm.enqueueUniquePeriodicWork(PERIODIC_SYNC_TAG, ExistingPeriodicWorkPolicy.UPDATE, request)
        }

        /** Debounced: rapid local edits collapse into one sync a few seconds later. */
        fun enqueueImmediateSync(context: Context, delaySeconds: Long = 3) {
            if (!SecurityManager(context).isConfigured) return
            val request = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setInitialDelay(delaySeconds, TimeUnit.SECONDS)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .addTag(IMMEDIATE_SYNC_TAG)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(IMMEDIATE_SYNC_TAG, ExistingWorkPolicy.REPLACE, request)
        }
    }
}
