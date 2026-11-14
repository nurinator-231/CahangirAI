package com.cahangir.assistant.alarm

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

class ReminderLogicTest {
    private val baku = ZoneId.of("Asia/Baku")
    private val berlin = ZoneId.of("Europe/Berlin")
    private fun at(z: ZoneId, y: Int, mo: Int, d: Int, h: Int, mi: Int = 0) = LocalDateTime.of(y, mo, d, h, mi).atZone(z).toInstant().toEpochMilli()

    @Test fun nextDueDailyWeeklyInterval() {
        val due = at(baku, 2026, 11, 14, 8); val now = at(baku, 2026, 11, 14, 9)
        assertEquals(at(baku, 2026, 11, 15, 8), ReminderLogic.nextDue(due, "{\"type\":\"daily\"}", now, baku))
        assertEquals(at(baku, 2026, 11, 21, 8), ReminderLogic.nextDue(due, JSONObject().put("type", "weekly"), now, baku))
        assertEquals(at(baku, 2026, 11, 14, 9, 30), ReminderLogic.nextDue(due, "{\"type\":\"interval\",\"ms\":1800000}", now, baku))
        assertNull(ReminderLogic.nextDue(due, null, now, baku))
        assertNull(ReminderLogic.nextDue(due, "{\"type\":\"yearly\"}", now, baku))
    }

    @Test fun dailyKeepsWallClockAcrossDst() {
        // Europe/Berlin switches to winter time on 25 Oct 2026: 08:00 stays 08:00 local.
        val due = at(berlin, 2026, 10, 24, 8)
        val next = ReminderLogic.nextDue(due, "{\"type\":\"daily\"}", due + 1000, berlin)!!
        assertEquals(at(berlin, 2026, 10, 25, 8), next)
        assertEquals(25 * 3600_000L, next - due)
    }

    private fun rem(id: String, due: Long?, snooze: Long? = null, fired: Long? = null, done: Int = 0, repeat: String? = null) =
        JSONObject().put("id", id).put("text", id).put("due", due ?: JSONObject.NULL).put("snooze", snooze ?: JSONObject.NULL)
            .put("fired_at", fired ?: JSONObject.NULL).put("done", done).put("deleted", 0).put("repeat", repeat ?: JSONObject.NULL)

    @Test fun dueFiredSnoozeAndTrigger() {
        val now = 1_800_000_000_000L
        val a = rem("a", now - 1000)
        assertTrue(ReminderLogic.isDue(a, now))
        assertFalse(ReminderLogic.isDue(rem("a", now - 1000, fired = now - 500), now))
        assertTrue(ReminderLogic.isDue(rem("a", now - 1000, snooze = now - 10, fired = now - 500), now)) // snoozed again after firing
        assertFalse(ReminderLogic.isDue(rem("d", now - 1000, done = 1), now))
        assertFalse(ReminderLogic.isDue(rem("f", now + 1000), now))
        assertEquals(now + 1000, ReminderLogic.nextTrigger(listOf(rem("f", now + 1000), rem("g", now + 5000)), now))
        assertEquals(now, ReminderLogic.nextTrigger(listOf(a), now)) // overdue and unfired -> fire now
        assertNull(ReminderLogic.nextTrigger(listOf(rem("x", null)), now))
    }

    @Test fun decideMissedStaleRecurring() {
        val now = at(baku, 2026, 11, 14, 9)
        val fresh = ReminderLogic.decide(rem("a", now - 60_000), now, baku)
        assertTrue(fresh.notify); assertFalse(fresh.missed); assertTrue(fresh.markFired); assertNull(fresh.nextDue)
        val missed = ReminderLogic.decide(rem("b", now - 3_600_000), now, baku)
        assertTrue(missed.notify && missed.missed)
        assertFalse(ReminderLogic.decide(rem("c", now - 3 * 86_400_000L), now, baku).notify)
        val rec = ReminderLogic.decide(rem("d", at(baku, 2026, 11, 14, 8), repeat = "{\"type\":\"daily\"}"), now, baku)
        assertEquals(at(baku, 2026, 11, 15, 8), rec.nextDue); assertFalse(rec.markFired)
    }
}
