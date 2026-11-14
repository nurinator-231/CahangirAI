package com.cahangir.assistant.clipboard

import java.security.MessageDigest

/** Loop prevention shared by the P2P receiver, sync and the share action. */
object ClipboardHub {
    @Volatile
    private var lastHash: String = ""

    fun hash(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    /** Returns true if this content was not the last one seen (and records it). */
    @Synchronized
    fun markSeen(hash: String): Boolean {
        if (hash == lastHash) return false
        lastHash = hash
        return true
    }
}
