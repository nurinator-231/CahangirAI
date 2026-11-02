package com.cahangir.assistant.alarm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class ReminderModelTest {

    @Test
    fun testReminderEffectiveTime() {
        val itemWithDue = ReminderItem(
            id = 1L,
            text = "Toplantı",
            due = 1730000000000L,
            snooze = null,
            done = false,
            firedAt = null,
            timer = false,
            repeat = null
        )
        assertEquals(1730000000000L, itemWithDue.effectiveTime)

        val itemWithSnooze = itemWithDue.copy(snooze = 1730000600000L)
        assertEquals(1730000600000L, itemWithSnooze.effectiveTime)

        val itemWithoutTime = itemWithDue.copy(due = null, snooze = null)
        assertNull(itemWithoutTime.effectiveTime)
        assertFalse(itemWithoutTime.done)
    }
}
