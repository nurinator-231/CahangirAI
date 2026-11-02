package com.cahangir.assistant.alarm

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

object ReminderScheduler {

    private const val PREFS_NAME = "cahangir_prefs"
    private const val KEY_REMINDERS_DATA = "reminders_data"
    private const val ALARM_REQUEST_CODE = 1001

    fun getSyncData(context: Context): ReminderSyncData {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val json = prefs.getString(KEY_REMINDERS_DATA, null) ?: return ReminderSyncData("", emptyList())
        return try {
            ReminderSyncData.fromJsonString(json)
        } catch (e: Exception) {
            Log.e("CahangirScheduler", "Error parsing stored reminders", e)
            ReminderSyncData("", emptyList())
        }
    }

    fun saveSyncData(context: Context, data: ReminderSyncData) {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_REMINDERS_DATA, data.toJsonString()).apply()
        scheduleNextAlarm(context)
    }

    fun scheduleNextAlarm(context: Context) {
        val repo = com.cahangir.assistant.data.local.repository.CahangirRepository(context)
        val localActive = repo.getActiveReminders()
        val data = getSyncData(context)
        val now = System.currentTimeMillis()

        // Combine items from local database and sync data
        val upcomingFromRepo = localActive.filter { item ->
            !item.done && item.effectiveTime != null && item.effectiveTime!! > now
        }.map { item ->
            ReminderItem(
                id = item.id.toLongOrNull() ?: item.id.hashCode().toLong(),
                text = item.text,
                due = item.due,
                snooze = item.snooze,
                done = item.done,
                firedAt = null,
                timer = item.timer,
                repeat = item.repeat
            )
        }

        val allUpcoming = (upcomingFromRepo + data.reminders.filter { item ->
            !item.done && item.effectiveTime != null && item.effectiveTime!! > now
        }).distinctBy { it.id }.sortedBy { it.effectiveTime }

        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return

        val intent = Intent(context, ReminderReceiver::class.java)
        val pendingIntent = PendingIntent.getBroadcast(
            context,
            ALARM_REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val nextItem = allUpcoming.firstOrNull()
        if (nextItem != null && nextItem.effectiveTime != null) {
            intent.putExtra("reminder_id", nextItem.id)
            intent.putExtra("reminder_text", nextItem.text)
            intent.putExtra("reminder_is_timer", nextItem.timer)
            intent.putExtra("user_name", data.userName)

            // Re-create pending intent with updated extras
            val updatedPendingIntent = PendingIntent.getBroadcast(
                context,
                ALARM_REQUEST_CODE,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val triggerAt = nextItem.effectiveTime!!
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    if (alarmManager.canScheduleExactAlarms()) {
                        alarmManager.setExactAndAllowWhileIdle(
                            AlarmManager.RTC_WAKEUP,
                            triggerAt,
                            updatedPendingIntent
                        )
                        Log.i("CahangirScheduler", "Scheduled exact alarm for: ${nextItem.text} at $triggerAt")
                    } else {
                        alarmManager.setAndAllowWhileIdle(
                            AlarmManager.RTC_WAKEUP,
                            triggerAt,
                            updatedPendingIntent
                        )
                        Log.w("CahangirScheduler", "Exact alarm not permitted; using setAndAllowWhileIdle")
                    }
                } else {
                    alarmManager.setExactAndAllowWhileIdle(
                        AlarmManager.RTC_WAKEUP,
                        triggerAt,
                        updatedPendingIntent
                    )
                    Log.i("CahangirScheduler", "Scheduled exact alarm for: ${nextItem.text} at $triggerAt")
                }
            } catch (e: Exception) {
                Log.e("CahangirScheduler", "Failed to schedule alarm", e)
            }
        } else {
            // No upcoming alarms, cancel pending intent
            alarmManager.cancel(pendingIntent)
            Log.i("CahangirScheduler", "No pending alarms; cancelled alarm manager")
        }
    }

    fun acknowledgeReminder(context: Context, id: Long) {
        try {
            val repo = com.cahangir.assistant.data.local.repository.CahangirRepository(context)
            repo.completeReminder(id.toString())
        } catch (_: Exception) {}

        val current = getSyncData(context)
        val updated = current.reminders.map {
            if (it.id == id) it.copy(done = true) else it
        }
        saveSyncData(context, current.copy(reminders = updated))
    }

    fun snoozeReminder(context: Context, id: Long, durationMs: Long = 10 * 60 * 1000) {
        try {
            val repo = com.cahangir.assistant.data.local.repository.CahangirRepository(context)
            repo.snoozeReminder(id.toString(), durationMs)
        } catch (_: Exception) {}

        val current = getSyncData(context)
        val snoozeTime = System.currentTimeMillis() + durationMs
        val updated = current.reminders.map {
            if (it.id == id) it.copy(snooze = snoozeTime, firedAt = null) else it
        }
        saveSyncData(context, current.copy(reminders = updated))
    }
}
