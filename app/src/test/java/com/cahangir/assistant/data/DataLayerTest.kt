package com.cahangir.assistant.data

import com.cahangir.assistant.data.local.dao.LocalMemory
import com.cahangir.assistant.data.local.dao.LocalProject
import com.cahangir.assistant.data.local.dao.LocalReminder
import org.junit.Assert.*
import org.junit.Test

class DataLayerTest {

    @Test
    fun testLocalReminderEffectiveTime() {
        val now = 1730000000000L
        val reminder = LocalReminder(
            id = "rem_1",
            text = "Çay dəmlə",
            due = now + 1800000L,
            snooze = null,
            done = false,
            timer = false,
            repeat = null,
            createdAt = now,
            updatedAt = now,
            deleted = false,
            syncStatus = 1
        )

        assertEquals(now + 1800000L, reminder.effectiveTime)

        // With snooze
        val snoozed = reminder.copy(snooze = now + 2400000L)
        assertEquals(now + 2400000L, snoozed.effectiveTime)

        assertFalse(reminder.done)
        assertEquals(1, reminder.syncStatus)
    }

    @Test
    fun testLocalMemoryData() {
        val memory = LocalMemory(
            id = "mem_1",
            factText = "Mənim adım Əhməddir",
            category = "personal",
            createdAt = 1000L,
            updatedAt = 2000L
        )

        assertEquals("mem_1", memory.id)
        assertEquals("personal", memory.category)
        assertEquals("Mənim adım Əhməddir", memory.factText)
        assertFalse(memory.deleted)
    }

    @Test
    fun testLocalProjectData() {
        val project = LocalProject(
            id = "prj_1",
            title = "Yeni vebsayt",
            status = "active",
            notes = "Kotlin və FastAPI ilə",
            createdAt = 1000L,
            updatedAt = 2000L
        )

        assertEquals("prj_1", project.id)
        assertEquals("active", project.status)
        assertEquals("Yeni vebsayt", project.title)
    }
}
