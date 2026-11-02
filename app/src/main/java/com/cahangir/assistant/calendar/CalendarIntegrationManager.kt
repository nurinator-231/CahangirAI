package com.cahangir.assistant.calendar

import android.Manifest
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.TimeZone

object CalendarIntegrationManager {

    fun hasCalendarPermission(context: Context): Boolean {
        return ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.WRITE_CALENDAR
        ) == PackageManager.PERMISSION_GRANTED
    }

    fun addReminderToCalendar(
        context: Context,
        title: String,
        startTimeMillis: Long,
        durationMinutes: Int = 30
    ): Boolean {
        if (!hasCalendarPermission(context)) {
            Log.w("CalendarManager", "WRITE_CALENDAR permission not granted")
            return false
        }

        return try {
            val endTimeMillis = startTimeMillis + (durationMinutes * 60 * 1000L)
            val values = ContentValues().apply {
                put(CalendarContract.Events.DTSTART, startTimeMillis)
                put(CalendarContract.Events.DTEND, endTimeMillis)
                put(CalendarContract.Events.TITLE, "Cahangir: $title")
                put(CalendarContract.Events.DESCRIPTION, "Cahangir AI xatırlatması")
                put(CalendarContract.Events.CALENDAR_ID, 1) // Primary calendar
                put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().id)
                put(CalendarContract.Events.HAS_ALARM, 1)
            }

            val uri = context.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values)
            if (uri != null) {
                // Add an alert 5 minutes before
                val eventId = uri.lastPathSegment?.toLongOrNull()
                if (eventId != null) {
                    val reminderValues = ContentValues().apply {
                        put(CalendarContract.Reminders.EVENT_ID, eventId)
                        put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT)
                        put(CalendarContract.Reminders.MINUTES, 5)
                    }
                    context.contentResolver.insert(CalendarContract.Reminders.CONTENT_URI, reminderValues)
                }
                Log.i("CalendarManager", "Successfully added reminder to calendar: $title")
                true
            } else {
                false
            }
        } catch (e: Exception) {
            Log.e("CalendarManager", "Failed to insert event into calendar", e)
            false
        }
    }
}
