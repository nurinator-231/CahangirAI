package com.cahangir.assistant.alarm

import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * Pure reminder rules shared with the Windows engine (desktop/src-tauri/src/reminders.rs)
 * and planner.js. Recurrence steps calendar days in the device's time zone, so a daily
 * 08:00 reminder stays at 08:00 across DST and time-zone changes.
 */
object ReminderLogic {
    const val MISSED_GRACE_MS = 10 * 60 * 1000L
    const val STALE_MS = 24 * 3600 * 1000L

    fun parseRepeat(v: Any?): JSONObject? = when (v) {
        is JSONObject -> v
        is String -> if (v.isBlank()) null else try { JSONObject(v) } catch (_: Exception) { null }
        else -> null
    }

    fun nextDue(due: Long, repeat: Any?, now: Long, zone: ZoneId = ZoneId.systemDefault()): Long? {
        val rep = parseRepeat(repeat) ?: return null
        val type = rep.optString("type")
        var d: ZonedDateTime = Instant.ofEpochMilli(due).atZone(zone)
        var guard = 0
        while (true) {
            d = when (type) {
                "daily" -> d.plusDays(1)
                "weekly" -> d.plusWeeks(1)
                "interval" -> d.plusNanos(maxOf(60_000L, rep.optLong("ms", 60_000L)) * 1_000_000L)
                else -> return null
            }
            guard++
            if (d.toInstant().toEpochMilli() > now || guard > 100_000) return d.toInstant().toEpochMilli()
        }
    }

    fun effectiveTime(r: JSONObject): Long? {
        val s = if (r.isNull("snooze")) 0L else r.optLong("snooze", 0L)
        if (s > 0) return s
        val d = if (r.isNull("due")) 0L else r.optLong("due", 0L)
        return if (d > 0) d else null
    }

    fun isDue(r: JSONObject, now: Long): Boolean {
        if (r.optLong("done") == 1L || r.optLong("deleted") == 1L) return false
        val eff = effectiveTime(r) ?: return false
        if (eff > now) return false
        val fired = if (r.isNull("fired_at")) null else r.optLong("fired_at")
        return fired == null || fired < eff
    }

    /** Next time an alarm must be armed for (null = nothing pending). */
    fun nextTrigger(rows: List<JSONObject>, now: Long): Long? = rows.asSequence()
        .filter { it.optLong("done") != 1L && it.optLong("deleted") != 1L }
        .mapNotNull { r ->
            val eff = effectiveTime(r) ?: return@mapNotNull null
            val fired = if (r.isNull("fired_at")) null else r.optLong("fired_at")
            if (fired != null && fired >= eff) null else maxOf(eff, now)
        }
        .minOrNull()

    data class Action(val id: String, val notify: Boolean, val missed: Boolean, val nextDue: Long?, val markFired: Boolean)

    /** What to do with a due reminder. */
    fun decide(r: JSONObject, now: Long, zone: ZoneId = ZoneId.systemDefault()): Action {
        val eff = effectiveTime(r)!!
        val stale = now - eff > STALE_MS
        val missed = now - eff > MISSED_GRACE_MS
        val repeat = parseRepeat(if (r.isNull("repeat")) null else r.opt("repeat"))
        val due = if (r.isNull("due")) null else r.optLong("due")
        val next = if (repeat != null && due != null) nextDue(due, repeat, now, zone) else null
        return Action(r.getString("id"), notify = !stale, missed = missed, nextDue = next, markFired = next == null)
    }
}
