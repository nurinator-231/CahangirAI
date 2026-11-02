package com.cahangir.assistant.alarm

import org.json.JSONArray
import org.json.JSONObject

data class ReminderItem(
    val id: Long,
    val text: String,
    val due: Long?,
    val snooze: Long?,
    val done: Boolean,
    val firedAt: Long?,
    val timer: Boolean,
    val repeat: String?
) {
    val effectiveTime: Long?
        get() = when {
            snooze != null && snooze > 0 -> snooze
            due != null && due > 0 -> due
            else -> null
        }

    fun toJsonObject(): JSONObject {
        return JSONObject().apply {
            put("id", id)
            put("text", text)
            put("due", due ?: JSONObject.NULL)
            put("snooze", snooze ?: JSONObject.NULL)
            put("done", done)
            put("firedAt", firedAt ?: JSONObject.NULL)
            put("timer", timer)
            put("repeat", repeat ?: JSONObject.NULL)
        }
    }

    companion object {
        fun fromJsonObject(obj: JSONObject): ReminderItem {
            return ReminderItem(
                id = obj.optLong("id", 0),
                text = obj.optString("text", ""),
                due = if (obj.has("due") && !obj.isNull("due")) obj.optLong("due") else null,
                snooze = if (obj.has("snooze") && !obj.isNull("snooze")) obj.optLong("snooze") else null,
                done = obj.optBoolean("done", false),
                firedAt = if (obj.has("firedAt") && !obj.isNull("firedAt")) obj.optLong("firedAt") else null,
                timer = obj.optBoolean("timer", false),
                repeat = if (obj.has("repeat") && !obj.isNull("repeat")) obj.optString("repeat") else null
            )
        }
    }
}

data class ReminderSyncData(
    val userName: String,
    val reminders: List<ReminderItem>
) {
    fun toJsonString(): String {
        val root = JSONObject()
        root.put("name", userName)
        val arr = JSONArray()
        reminders.forEach { arr.put(it.toJsonObject()) }
        root.put("reminders", arr)
        return root.toString()
    }

    companion object {
        fun fromJsonString(jsonStr: String): ReminderSyncData {
            val root = JSONObject(jsonStr)
            val name = root.optString("name", "")
            val remindersList = mutableListOf<ReminderItem>()
            val arr = root.optJSONArray("reminders")
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    val itemObj = arr.optJSONObject(i)
                    if (itemObj != null) {
                        remindersList.add(ReminderItem.fromJsonObject(itemObj))
                    }
                }
            }
            return ReminderSyncData(userName = name, reminders = remindersList)
        }
    }
}
