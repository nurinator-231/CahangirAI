package com.cahangir.assistant.alarm

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat

class ReminderReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_FIRE = "com.cahangir.assistant.ACTION_REMINDER_FIRE"
        const val CHANNEL_ID = "cahangir_reminders_channel"
        const val CHANNEL_NAME = "Cahangir Xatırlatmaları"
        const val EXTRA_ID = "reminder_id"

        fun notificationId(id: String) = (id.hashCode() and 0x7fffffff) % 1_000_000 + 1000

        fun createChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val attrs = AudioAttributes.Builder().setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).setUsage(AudioAttributes.USAGE_ALARM).build()
            val sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            val ch = NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Cahangir xatırlatmaları, son tarixlər və planlaşdırılmış işlər"
                enableLights(true)
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 500, 200, 500, 200, 500)
                setSound(sound, attrs)
                lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
            }
            (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(ch)
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val wl = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Cahangir:AlarmWakeLock")
        wl?.acquire(10_000L)
        try {
            createChannel(context)
            val fired = ReminderScheduler.processDue(context)
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            var fullScreenUsed = false
            for ((r, action) in fired) {
                val id = action.id
                val text = r.optString("text").ifBlank { "Xatırlatma" }
                val isTimer = r.optLong("timer") == 1L
                val nid = notificationId(id)
                val alarmIntent = Intent(context, AlarmActivity::class.java).apply {
                    putExtra(EXTRA_ID, id)
                    putExtra("reminder_text", text)
                    putExtra("reminder_is_timer", isTimer)
                    putExtra("user_name", context.getSharedPreferences("cahangir_prefs", Context.MODE_PRIVATE).getString("user_name", "") ?: "")
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                }
                val fullPi = PendingIntent.getActivity(context, nid, alarmIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                fun actionPi(act: String, offset: Int) = PendingIntent.getBroadcast(
                    context, nid + offset,
                    Intent(context, NotificationActionReceiver::class.java).setAction(act).putExtra(EXTRA_ID, id),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                val title = when {
                    action.missed -> "Cahangir: qaçırılmış xatırlatma"
                    isTimer -> "Cahangir: taymer"
                    r.optString("kind") == "deadline" -> "Cahangir: son tarix"
                    else -> "Cahangir: xatırlatma"
                }
                val builder = NotificationCompat.Builder(context, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                    .setContentTitle(title)
                    .setContentText(text)
                    .setStyle(NotificationCompat.BigTextStyle().bigText(text))
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_ALARM)
                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                    .setAutoCancel(true)
                    .setContentIntent(fullPi)
                    .addAction(android.R.drawable.checkbox_on_background, "✓ Oldu", actionPi(NotificationActionReceiver.ACTION_ACK, 1_000_000))
                    .addAction(android.R.drawable.ic_popup_reminder, "💤 10 dəq.", actionPi(NotificationActionReceiver.ACTION_SNOOZE, 2_000_000))
                val canFullScreen = Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent()
                if (!action.missed && !fullScreenUsed && canFullScreen) {
                    builder.setFullScreenIntent(fullPi, true)
                    fullScreenUsed = true
                }
                try {
                    nm.notify(nid, builder.build())
                } catch (e: SecurityException) {
                    Log.w("CahangirReceiver", "Notification permission missing", e)
                }
            }
        } catch (e: Exception) {
            Log.e("CahangirReceiver", "Failed to process reminders", e)
        } finally {
            ReminderScheduler.scheduleNextAlarm(context)
            if (wl?.isHeld == true) wl.release()
        }
    }
}
