package com.cahangir.assistant.data.local.repository

import android.content.Context
import com.cahangir.assistant.alarm.ReminderScheduler
import com.cahangir.assistant.data.local.CahangirDbHelper
import com.cahangir.assistant.data.local.EntityStore
import com.cahangir.assistant.sync.SyncManager
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList

/** App-wide access to the native store plus change notification. */
class CahangirRepository private constructor(private val context: Context) {

    val store = EntityStore(CahangirDbHelper.getInstance(context))

    companion object {
        @Volatile
        private var instance: CahangirRepository? = null
        private val listeners = CopyOnWriteArrayList<() -> Unit>()

        fun get(context: Context): CahangirRepository =
            instance ?: synchronized(this) { instance ?: CahangirRepository(context.applicationContext).also { instance = it } }
    }

    fun addListener(l: () -> Unit) { listeners.add(l) }
    fun removeListener(l: () -> Unit) { listeners.remove(l) }

    /** Called after any data change (local edit or sync): refresh UI, re-arm alarms. */
    fun notifyDataChanged(entities: Collection<String> = emptyList()) {
        for (l in listeners) try { l.invoke() } catch (_: Exception) {}
        if (entities.isEmpty() || "reminders" in entities) ReminderScheduler.scheduleNextAlarm(context)
    }

    /** Local edit from the UI: saved immediately, synced in the background when possible. */
    fun save(entity: String, patch: JSONObject): JSONObject {
        val v = store.saveLocal(entity, patch)
        if (entity == "reminders" && (patch.has("due") || patch.has("snooze"))) store.setReminderFired(v.getString("id"), null)
        notifyDataChanged(listOf(entity))
        SyncManager.enqueueImmediateSync(context)
        return v
    }

    fun delete(entity: String, id: String): Boolean {
        val r = store.deleteLocal(entity, id)
        notifyDataChanged(listOf(entity))
        SyncManager.enqueueImmediateSync(context)
        return r
    }
}
