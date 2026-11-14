package com.cahangir.assistant.alarm

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import com.cahangir.assistant.data.local.repository.CahangirRepository
import org.json.JSONObject

/**
 * Arms one exact AlarmManager alarm for the earliest pending reminder. When it fires,
 * ReminderReceiver handles every due reminder and re-arms the next one. Rescheduled on
 * every data change, app start, boot, app update, time change and time-zone change.
 */
object ReminderScheduler {
    private const val ALARM_REQUEST_CODE = 1001
    private const val TAG = "CahangirScheduler"

    private fun pendingIntent(context: Context): PendingIntent = PendingIntent.getBroadcast(
        context, ALARM_REQUEST_CODE, Intent(context, ReminderReceiver::class.java).setAction(ReminderReceiver.ACTION_FIRE),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    fun canScheduleExact(context: Context): Boolean {
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return false
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()
    }

    fun scheduleNextAlarm(context: Context) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        val now = System.currentTimeMillis()
        val rows = try {
            CahangirRepository.get(context).store.list("reminders")
        } catch (e: Exception) {
            Log.e(TAG, "Cannot read reminders", e); return
        }
        val trigger = ReminderLogic.nextTrigger(rows, now)
        val pi = pendingIntent(context)
        if (trigger == null) {
            am.cancel(pi)
            return
        }
        try {
            if (canScheduleExact(context)) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, trigger, pi)
            } else {
                // Without the exact-alarm permission Android may delay this by several minutes.
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, trigger, pi)
                Log.w(TAG, "Exact alarms not permitted; reminder may be delayed")
            }
        } catch (e: SecurityException) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, trigger, pi)
        }
    }

    /** Marks due reminders as fired / advances recurring ones; returns those to show. */
    fun processDue(context: Context, now: Long = System.currentTimeMillis()): List<Pair<JSONObject, ReminderLogic.Action>> {
        val repo = CahangirRepository.get(context)
        val out = mutableListOf<Pair<JSONObject, ReminderLogic.Action>>()
        for (r in repo.store.list("reminders")) {
            if (!ReminderLogic.isDue(r, now)) continue
            val a = ReminderLogic.decide(r, now)
            if (a.nextDue != null) {
                repo.store.saveLocal("reminders", JSONObject().put("id", a.id).put("due", a.nextDue).put("snooze", JSONObject.NULL))
                repo.store.setReminderFired(a.id, null)
            } else {
                repo.store.setReminderFired(a.id, now)
            }
            if (a.notify) out.add(r to a)
        }
        repo.notifyDataChanged(listOf("reminders"))
        return out
    }

    fun complete(context: Context, id: String) {
        val repo = CahangirRepository.get(context)
        val r = repo.store.get("reminders", id) ?: return
        val recurring = ReminderLogic.parseRepeat(if (r.isNull("repeat")) null else r.opt("repeat")) != null
        val patch = JSONObject().put("id", id).put("snooze", JSONObject.NULL)
        if (!recurring) patch.put("done", 1)
        repo.store.saveLocal("reminders", patch)
        repo.notifyDataChanged(listOf("reminders"))
        com.cahangir.assistant.sync.SyncManager.enqueueImmediateSync(context)
    }

    fun snooze(context: Context, id: String, durationMs: Long = 10 * 60 * 1000L) {
        val repo = CahangirRepository.get(context)
        repo.store.saveLocal("reminders", JSONObject().put("id", id).put("snooze", System.currentTimeMillis() + durationMs))
        repo.store.setReminderFired(id, null)
        repo.notifyDataChanged(listOf("reminders"))
        com.cahangir.assistant.sync.SyncManager.enqueueImmediateSync(context)
    }
}
