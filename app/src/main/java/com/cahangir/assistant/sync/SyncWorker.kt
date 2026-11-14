package com.cahangir.assistant.sync

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.cahangir.assistant.security.SecurityManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class SyncWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        if (!SecurityManager(applicationContext).isConfigured) return@withContext Result.success()
        try {
            SyncManager(applicationContext).performSync()
            Result.success()
        } catch (e: SyncEngine.SyncException) {
            Log.w("SyncWorker", "Sync failed: ${e.message}")
            // Revoked/unknown device: retrying cannot help.
            if (e.httpCode == 401 || e.httpCode == 403) Result.failure() else Result.retry()
        } catch (e: Exception) {
            Log.e("SyncWorker", "Unexpected sync error", e)
            Result.retry()
        }
    }
}
