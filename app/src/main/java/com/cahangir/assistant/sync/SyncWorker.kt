package com.cahangir.assistant.sync

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.cahangir.assistant.security.SecurityManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class SyncWorker(
    appContext: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(appContext, workerParams) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val securityManager = SecurityManager(applicationContext)
        if (!securityManager.isConfigured) {
            Log.d("SyncWorker", "Debian server not configured; skipping sync.")
            return@withContext Result.success()
        }

        val syncManager = SyncManager(applicationContext)
        val success = syncManager.performSync()

        if (success) {
            Log.i("SyncWorker", "Background sync completed successfully.")
            Result.success()
        } else {
            Log.w("SyncWorker", "Background sync failed. Will retry according to backoff policy.")
            Result.retry()
        }
    }
}
