package com.cahangir.assistant.sync

import android.content.Context
import android.util.Log
import androidx.work.*
import com.cahangir.assistant.data.local.dao.LocalMemory
import com.cahangir.assistant.data.local.dao.LocalProject
import com.cahangir.assistant.data.local.dao.LocalReminder
import com.cahangir.assistant.data.local.repository.CahangirRepository
import com.cahangir.assistant.security.SecurityManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class SyncManager(private val context: Context) {

    private val repository = CahangirRepository(context)
    private val securityManager = SecurityManager(context)

    fun performSync(): Boolean {
        if (!securityManager.isConfigured) {
            Log.d("SyncManager", "Debian sync server not configured; operating in local offline mode.")
            return false
        }

        val pendingReminders = repository.reminderDao.getPendingSync()
        val pendingMemories = repository.memoryDao.getPendingSync()
        val pendingProjects = repository.projectDao.getPendingSync()

        val payload = JSONObject().apply {
            put("device_id", securityManager.deviceId)
            put("client_timestamp", securityManager.lastSyncTimestamp)

            val remArr = JSONArray()
            for (r in pendingReminders) {
                remArr.put(JSONObject().apply {
                    put("id", r.id)
                    put("user_id", r.userId)
                    put("text", r.text)
                    put("due", r.due ?: JSONObject.NULL)
                    put("snooze", r.snooze ?: JSONObject.NULL)
                    put("done", if (r.done) 1 else 0)
                    put("timer", if (r.timer) 1 else 0)
                    put("repeat", r.repeat ?: JSONObject.NULL)
                    put("created_at", r.createdAt)
                    put("updated_at", r.updatedAt)
                    put("deleted", if (r.deleted) 1 else 0)
                })
            }
            put("reminders", remArr)

            val memArr = JSONArray()
            for (m in pendingMemories) {
                memArr.put(JSONObject().apply {
                    put("id", m.id)
                    put("user_id", m.userId)
                    put("category", m.category)
                    put("fact_text", m.factText)
                    put("confidence", m.confidence.toDouble())
                    put("source", m.source)
                    put("created_at", m.createdAt)
                    put("updated_at", m.updatedAt)
                    put("deleted", if (m.deleted) 1 else 0)
                })
            }
            put("memories", memArr)

            val prjArr = JSONArray()
            for (p in pendingProjects) {
                prjArr.put(JSONObject().apply {
                    put("id", p.id)
                    put("user_id", p.userId)
                    put("title", p.title)
                    put("status", p.status)
                    put("notes", p.notes)
                    put("created_at", p.createdAt)
                    put("updated_at", p.updatedAt)
                    put("deleted", if (p.deleted) 1 else 0)
                })
            }
            put("projects", prjArr)
        }

        val (success, responseStr) = SyncApiClient.executeSync(
            serverUrl = securityManager.serverUrl,
            deviceToken = securityManager.deviceToken,
            payloadJson = payload.toString()
        )

        if (!success) {
            Log.w("SyncManager", "Sync round-trip failed: $responseStr")
            return false
        }

        // 1) Cavabı TAM parse et. Xəta olsa, bazaya heç nə yazılmır, pending qeydlər toxunulmaz qalır.
        val serverTimestamp: Long
        val deltaRem = mutableListOf<LocalReminder>()
        val deltaMem = mutableListOf<LocalMemory>()
        val deltaPrj = mutableListOf<LocalProject>()
        try {
            val respJson = JSONObject(responseStr)
            serverTimestamp = respJson.getLong("server_timestamp")
            val delta = respJson.getJSONObject("delta")

            delta.optJSONArray("reminders")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    deltaRem.add(LocalReminder(
                        id = o.getString("id"),
                        userId = o.optString("user_id", "default"),
                        text = o.getString("text"),
                        due = if (o.isNull("due")) null else o.getLong("due"),
                        snooze = if (o.isNull("snooze")) null else o.getLong("snooze"),
                        done = o.optInt("done", 0) == 1,
                        timer = o.optInt("timer", 0) == 1,
                        repeat = if (o.isNull("repeat")) null else o.getString("repeat"),
                        createdAt = o.getLong("created_at"),
                        updatedAt = o.getLong("updated_at"),
                        deleted = o.optInt("deleted", 0) == 1,
                        syncStatus = 0
                    ))
                }
            }
            delta.optJSONArray("memories")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    deltaMem.add(LocalMemory(
                        id = o.getString("id"),
                        userId = o.optString("user_id", "default"),
                        category = o.optString("category", "general"),
                        factText = o.getString("fact_text"),
                        confidence = o.optDouble("confidence", 1.0).toFloat(),
                        source = o.optString("source", "user"),
                        createdAt = o.getLong("created_at"),
                        updatedAt = o.getLong("updated_at"),
                        deleted = o.optInt("deleted", 0) == 1,
                        syncStatus = 0
                    ))
                }
            }
            delta.optJSONArray("projects")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    deltaPrj.add(LocalProject(
                        id = o.getString("id"),
                        userId = o.optString("user_id", "default"),
                        title = o.getString("title"),
                        status = o.optString("status", "active"),
                        notes = o.optString("notes", ""),
                        createdAt = o.getLong("created_at"),
                        updatedAt = o.getLong("updated_at"),
                        deleted = o.optInt("deleted", 0) == 1,
                        syncStatus = 0
                    ))
                }
            }
        } catch (e: Exception) {
            Log.e("SyncManager", "Failed to parse sync response; nothing was changed locally", e)
            return false
        }

        // 2) Hamısını BİR tranzaksiyada yaz: pending işarələmə + LWW ilə delta.
        try {
            val changed = repository.inTransaction {
                var n = 0
                // Yalnız göndərilən andan bəri dəyişməyənlər synced olur
                repository.reminderDao.markSyncedIfUnchanged(pendingReminders)
                repository.memoryDao.markSyncedIfUnchanged(pendingMemories)
                repository.projectDao.markSyncedIfUnchanged(pendingProjects)

                for (r in deltaRem) if (repository.reminderDao.upsertFromServer(r)) n++
                for (m in deltaMem) if (repository.memoryDao.upsertFromServer(m)) n++
                for (p in deltaPrj) if (repository.projectDao.upsertFromServer(p)) n++
                n
            }

            // Zaman damğası yalnız uğurlu yazıdan SONRA yenilənir
            securityManager.lastSyncTimestamp = serverTimestamp
            if (changed > 0) repository.onSyncApplied() // UI yenilə + alarmları yenidən planlaşdır
            Log.i("SyncManager", "Sync completed at server time $serverTimestamp (applied $changed server changes)")
            return true
        } catch (e: Exception) {
            Log.e("SyncManager", "Failed to apply sync response; transaction rolled back", e)
            return false
        }
    }

    companion object {
        private const val PERIODIC_SYNC_TAG = "cahangir_periodic_sync"
        private const val IMMEDIATE_SYNC_TAG = "cahangir_immediate_sync"

        fun schedulePeriodicSync(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val periodicRequest = PeriodicWorkRequestBuilder<SyncWorker>(2L, TimeUnit.HOURS)
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15L, TimeUnit.MINUTES)
                .addTag(PERIODIC_SYNC_TAG)
                .build()

            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                PERIODIC_SYNC_TAG,
                ExistingPeriodicWorkPolicy.KEEP,
                periodicRequest
            )
            Log.i("SyncManager", "Scheduled periodic sync with WorkManager")
        }

        fun enqueueImmediateSync(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()

            val oneTimeRequest = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .addTag(IMMEDIATE_SYNC_TAG)
                .build()

            WorkManager.getInstance(context).enqueueUniqueWork(
                IMMEDIATE_SYNC_TAG,
                ExistingWorkPolicy.REPLACE,
                oneTimeRequest
            )
        }
    }
}
