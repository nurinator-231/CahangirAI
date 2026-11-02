package com.cahangir.assistant.alarm

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.widget.Toast

class NotificationActionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_ACK = "com.cahangir.assistant.ACTION_ACK"
        const val ACTION_SNOOZE = "com.cahangir.assistant.ACTION_SNOOZE"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val reminderId = intent.getLongExtra("reminder_id", 0L)
        val notifManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        notifManager?.cancel(reminderId.toInt())

        when (intent.action) {
            ACTION_ACK -> {
                ReminderScheduler.acknowledgeReminder(context, reminderId)
                Toast.makeText(context, "✓ Xatırlatma tamamlandı", Toast.LENGTH_SHORT).show()
            }
            ACTION_SNOOZE -> {
                ReminderScheduler.snoozeReminder(context, reminderId, 10 * 60 * 1000L)
                Toast.makeText(context, "💤 10 dəqiqə sonra yenidən xatırladılacaq", Toast.LENGTH_SHORT).show()
            }
        }
    }
}
