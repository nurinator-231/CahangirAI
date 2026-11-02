package com.cahangir.assistant.data.local.repository

import android.content.Context
import com.cahangir.assistant.alarm.ReminderScheduler
import com.cahangir.assistant.data.local.CahangirDbHelper
import com.cahangir.assistant.data.local.dao.*

class CahangirRepository(private val context: Context) {

    private val dbHelper = CahangirDbHelper.getInstance(context)
    val reminderDao = ReminderDao(dbHelper)
    val memoryDao = MemoryDao(dbHelper)
    val projectDao = ProjectDao(dbHelper)

    private val listeners = mutableListOf<() -> Unit>()

    fun addListener(listener: () -> Unit) {
        listeners.add(listener)
    }

    fun removeListener(listener: () -> Unit) {
        listeners.remove(listener)
    }

    private fun notifyDataChanged() {
        for (l in listeners) {
            try { l.invoke() } catch (_: Exception) {}
        }
        // Reschedule alarms whenever reminders change
        ReminderScheduler.scheduleNextAlarm(context)
    }

    // --- Reminders ---
    fun saveReminder(reminder: LocalReminder, isPendingSync: Boolean = true) {
        reminderDao.upsert(reminder, isPendingSync)
        notifyDataChanged()
    }

    fun completeReminder(id: String) {
        reminderDao.markDone(id, true)
        notifyDataChanged()
    }

    fun snoozeReminder(id: String, durationMs: Long = 10 * 60 * 1000L) {
        val snoozeUntil = System.currentTimeMillis() + durationMs
        reminderDao.snooze(id, snoozeUntil)
        notifyDataChanged()
    }

    fun deleteReminder(id: String) {
        reminderDao.softDelete(id)
        notifyDataChanged()
    }

    fun getActiveReminders(): List<LocalReminder> = reminderDao.getAllActive()

    // --- Memories ---
    fun saveMemory(memory: LocalMemory, isPendingSync: Boolean = true) {
        memoryDao.upsert(memory, isPendingSync)
        notifyDataChanged()
    }

    fun deleteMemory(id: String) {
        memoryDao.softDelete(id)
        notifyDataChanged()
    }

    fun getAllMemories(): List<LocalMemory> = memoryDao.getAll()

    fun searchMemories(query: String): List<LocalMemory> = memoryDao.search(query)

    // --- Projects ---
    fun saveProject(project: LocalProject, isPendingSync: Boolean = true) {
        projectDao.upsert(project, isPendingSync)
        notifyDataChanged()
    }

    fun deleteProject(id: String) {
        projectDao.softDelete(id)
        notifyDataChanged()
    }

    fun getAllProjects(): List<LocalProject> = projectDao.getAll()
}
