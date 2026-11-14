package com.cahangir.assistant.p2p

import org.junit.Assert.*
import org.junit.Test

class P2pAuthTest {
    private val key = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"

    @Test fun matchesWindowsImplementationVector() {
        // Same vector as desktop/src-tauri/src/p2p/auth.rs::known_vector_matches_android_implementation
        assertEquals("fe0391bae380cc3c1db2d628f191d3fb558b8e2291bcbbd563e7491881e0d125",
            P2pAuth.signature(key, "POST", "/p2p/clipboard", 1700000000000, "abc", "hello".toByteArray()))
    }

    @Test fun verifyRejectsTamperingReplayExpiryAndWrongKey() {
        val v = P2pAuth.Verifier(); val now = 1_000_000_000_000L
        val sig = P2pAuth.signature(key, "POST", "/p2p/clipboard", now, "n1", "{}".toByteArray())
        assertEquals(P2pAuth.Result.OK, v.verify(key, "POST", "/p2p/clipboard", now.toString(), "n1", sig, "{}".toByteArray(), now))
        assertEquals(P2pAuth.Result.REPLAY, v.verify(key, "POST", "/p2p/clipboard", now.toString(), "n1", sig, "{}".toByteArray(), now))
        val s2 = P2pAuth.signature(key, "POST", "/p2p/clipboard", now, "n2", "{}".toByteArray())
        assertEquals(P2pAuth.Result.BAD_SIGNATURE, v.verify(key, "POST", "/p2p/clipboard", now.toString(), "n2", s2, "{x}".toByteArray(), now))
        assertEquals(P2pAuth.Result.BAD_SIGNATURE, v.verify("ff".repeat(32), "POST", "/p2p/clipboard", now.toString(), "n2", s2, "{}".toByteArray(), now))
        val old = now - P2pAuth.MAX_SKEW_MS - 1
        val s3 = P2pAuth.signature(key, "GET", "/p2p/ping", old, "n3", ByteArray(0))
        assertEquals(P2pAuth.Result.EXPIRED, v.verify(key, "GET", "/p2p/ping", old.toString(), "n3", s3, ByteArray(0), now))
        assertEquals(P2pAuth.Result.MISSING, v.verify(key, "GET", "/p2p/ping", null, null, null, ByteArray(0), now))
        assertEquals(P2pAuth.Result.NOT_PAIRED, v.verify("", "GET", "/p2p/ping", null, null, null, ByteArray(0), now))
    }

    @Test fun sanitizesFilenamesLikeWindows() {
        assertEquals("passwd", P2pAuth.sanitizeFilename("../../etc/passwd"))
        assertEquals("evil.exe", P2pAuth.sanitizeFilename("C:\\Windows\\evil.exe"))
        assertEquals("_con.txt", P2pAuth.sanitizeFilename("con.txt"))
        assertEquals("a_b_c_.pdf", P2pAuth.sanitizeFilename("a<b>c?.pdf"))
        assertEquals("file", P2pAuth.sanitizeFilename("..."))
        assertTrue(P2pAuth.sanitizeFilename("x".repeat(500)).length <= 180)
    }
}
