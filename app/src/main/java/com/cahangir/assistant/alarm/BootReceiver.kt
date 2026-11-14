package com.cahangir.assistant.alarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.cahangir.assistant.sync.SyncManager

/** Re-arms alarms after reboot, app update, clock change and time-zone change. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Log.i("CahangirBoot", "Rescheduling reminders after ${intent.action}")
        ReminderScheduler.scheduleNextAlarm(context)
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            SyncManager.schedulePeriodicSync(context)
        }
        // Reminders that became due while the device was off are delivered as "missed".
        context.sendBroadcast(Intent(context, ReminderReceiver::class.java).setAction(ReminderReceiver.ACTION_FIRE))
    }
}
