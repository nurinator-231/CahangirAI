package com.cahangir.assistant.sync

/** Saf (Android-dan asılı olmayan) sinxronizasiya qaydaları. JVM testləri ilə yoxlanılır. */
object SyncRules {
    /**
     * Serverdən gələn qeyd yerli bazaya yazılmalıdırmı? (Last-Write-Wins)
     * - Yerli qeyd yoxdursa: bəli.
     * - Yerli qeyd daha yenidirsə: xeyr (yerli dəyişiklik itməsin).
     * - Yerli qeyd göndərilməyib (pending) və vaxtı bərabər/yenidirsə: xeyr.
     */
    fun shouldApplyServerItem(localUpdatedAt: Long?, localPending: Boolean, incomingUpdatedAt: Long): Boolean {
        if (localUpdatedAt == null) return true
        if (localUpdatedAt > incomingUpdatedAt) return false
        if (localPending && localUpdatedAt >= incomingUpdatedAt) return false
        return true
    }
}
