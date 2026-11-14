package com.cahangir.assistant.p2p

import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Device-to-device request authentication (same scheme as desktop p2p/auth.rs):
 * X-Cahangir-Sig = hex(HMAC-SHA256(mesh_key, METHOD\nPATH\nTS\nNONCE\nSHA256HEX(BODY))).
 * The mesh key is only handed out by the Debian server to paired, non-revoked devices.
 */
object P2pAuth {
    const val MAX_SKEW_MS = 5 * 60 * 1000L

    fun hex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }
    fun unhex(s: String): ByteArray? = try {
        if (s.length % 2 != 0) null else ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    } catch (_: NumberFormatException) { null }

    fun sha256Hex(data: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(data))

    fun signature(keyHex: String, method: String, path: String, ts: Long, nonce: String, body: ByteArray): String? {
        val key = unhex(keyHex) ?: return null
        if (key.isEmpty()) return null
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        val msg = "${method.uppercase()}\n$path\n$ts\n$nonce\n${sha256Hex(body)}"
        return hex(mac.doFinal(msg.toByteArray(Charsets.UTF_8)))
    }

    fun newNonce(): String = UUID.randomUUID().toString().replace("-", "")

    enum class Result { OK, NOT_PAIRED, MISSING, EXPIRED, REPLAY, BAD_SIGNATURE }

    class Verifier {
        private val seen = HashMap<String, Long>()

        @Synchronized
        fun verify(keyHex: String, method: String, path: String, ts: String?, nonce: String?, sig: String?, body: ByteArray, now: Long): Result {
            if (keyHex.isBlank()) return Result.NOT_PAIRED
            if (ts == null || nonce.isNullOrEmpty() || nonce.length > 64 || sig == null) return Result.MISSING
            val t = ts.toLongOrNull() ?: return Result.MISSING
            if (kotlin.math.abs(now - t) > MAX_SKEW_MS) return Result.EXPIRED
            val expected = signature(keyHex, method, path, t, nonce, body) ?: return Result.NOT_PAIRED
            // Constant-time comparison.
            if (!MessageDigest.isEqual(expected.toByteArray(), sig.lowercase().toByteArray())) return Result.BAD_SIGNATURE
            seen.entries.removeAll { now - it.value > 2 * MAX_SKEW_MS }
            if (seen.containsKey(nonce)) return Result.REPLAY
            seen[nonce] = now
            return Result.OK
        }
    }

    private val RESERVED = setOf("CON", "PRN", "AUX", "NUL") + (1..9).flatMap { listOf("COM$it", "LPT$it") }

    /** No directories, control/reserved characters or device names; bounded length. */
    fun sanitizeFilename(name: String): String {
        val base = name.split('/', '\\').last()
        var s = base.map { c -> if (c.isISOControl() || "<>:\"/\\|?*".indexOf(c) >= 0) '_' else c }.joinToString("")
        s = s.trim { it == '.' || it.isWhitespace() }
        if (s.isEmpty()) s = "file"
        if (s.substringBefore('.').uppercase() in RESERVED) s = "_$s"
        if (s.length > 180) {
            val ext = s.substringAfterLast('.', "").take(10)
            s = s.take(160) + if (ext.isNotEmpty()) ".$ext" else ""
        }
        return s
    }
}
