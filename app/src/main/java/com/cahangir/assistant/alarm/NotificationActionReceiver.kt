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
        val id = intent.getStringExtra(ReminderReceiver.EXTRA_ID) ?: return
        (context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)?.cancel(ReminderReceiver.notificationId(id))
        when (intent.action) {
            ACTION_ACK -> {
                ReminderScheduler.complete(context, id)
                Toast.makeText(context, "✓ Xatırlatma tamamlandı", Toast.LENGTH_SHORT).show()
            }
            ACTION_SNOOZE -> {
                ReminderScheduler.snooze(context, id)
                Toast.makeText(context, "💤 10 dəqiqə sonra yenidən xatırladılacaq", Toast.LENGTH_SHORT).show()
            }
        }
    }
}
