package com.cahangir.assistant.p2p

import android.content.Context
import android.net.Uri
import com.cahangir.assistant.security.SecurityManager
import org.json.JSONObject
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/** Authenticated sender for files and clipboard text (same protocol as the Windows app). */
class P2pClient(private val context: Context) {
    private val cancelFlag = AtomicBoolean(false)
    private val storage = P2pTransferStorage(context)
    private val security = SecurityManager(context)

    companion object {
        const val CHUNK = 1024 * 1024

        /** Pure helper used by tests and by the client. */
        fun signedRequest(meshKey: String, deviceId: String, base: String, method: String, pathAndQuery: String, body: ByteArray, contentType: String = "application/json", timeoutMs: Int = 15000): Pair<Int, String> {
            if (meshKey.isBlank()) throw IllegalStateException("P2P açarı yoxdur — əvvəlcə serverə qoşulub sinxron edin.")
            val path = pathAndQuery.substringBefore('?')
            val ts = System.currentTimeMillis()
            val nonce = P2pAuth.newNonce()
            val sig = P2pAuth.signature(meshKey, method, path, ts, nonce, body) ?: throw IllegalStateException("invalid mesh key")
            val conn = URL(base + pathAndQuery).openConnection() as HttpURLConnection
            try {
                conn.requestMethod = method
                conn.connectTimeout = 8000
                conn.readTimeout = timeoutMs
                conn.setRequestProperty("X-Cahangir-Device", deviceId)
                conn.setRequestProperty("X-Cahangir-Ts", ts.toString())
                conn.setRequestProperty("X-Cahangir-Nonce", nonce)
                conn.setRequestProperty("X-Cahangir-Sig", sig)
                if (method == "POST") {
                    conn.doOutput = true
                    conn.setRequestProperty("Content-Type", contentType)
                    conn.setFixedLengthStreamingMode(body.size)
                    conn.outputStream.use { it.write(body) }
                }
                val code = conn.responseCode
                val text = (if (code in 200..299) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
                return code to text
            } finally {
                conn.disconnect()
            }
        }

        fun base(host: String, port: Int) = if (host.contains(':') && !host.startsWith("[")) "http://[$host]:$port" else "http://${host.trim()}:$port"
    }

    fun cancelTransfer() = cancelFlag.set(true)

    private fun req(host: String, port: Int, method: String, path: String, body: ByteArray = ByteArray(0), ct: String = "application/json", timeout: Int = 15000) =
        signedRequest(security.meshKey, security.deviceId, base(host, port), method, path, body, ct, timeout)

    private fun errorOf(code: Int, text: String): String = when (code) {
        401 -> "Qarşı cihaz sorğunu təsdiqləmədi (açarlar fərqlidir — hər iki cihazı sinxron edin)."
        503 -> "Qarşı cihaz hələ serverlə cütləşdirilməyib."
        else -> "HTTP $code ${text.take(150)}"
    }

    fun ping(host: String, port: Int): Result<JSONObject> = try {
        val (c, t) = req(host, port, "GET", "/p2p/ping", timeout = 4000)
        if (c == 200) Result.success(JSONObject(t)) else Result.failure(Exception(errorOf(c, t)))
    } catch (e: Exception) { Result.failure(e) }

    fun sendClipboard(host: String, port: Int, id: String, text: String): Result<JSONObject> = try {
        val body = JSONObject().put("id", id).put("text", text).put("origin_device", security.deviceName)
            .put("hash", P2pAuth.sha256Hex(text.toByteArray(Charsets.UTF_8))).toString().toByteArray(Charsets.UTF_8)
        val (c, t) = req(host, port, "POST", "/p2p/clipboard", body, timeout = 6000)
        if (c == 200) Result.success(JSONObject(t)) else Result.failure(Exception(errorOf(c, t)))
    } catch (e: Exception) { Result.failure(e) }

    private fun hashUri(uri: Uri): String {
        val md = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(CHUNK)
        context.contentResolver.openInputStream(uri)?.use { s ->
            while (true) {
                if (cancelFlag.get()) throw InterruptedException("Ləğv edildi")
                val n = s.read(buf); if (n <= 0) break; md.update(buf, 0, n)
            }
        } ?: throw IllegalStateException("Fayl açıla bilmədi")
        return P2pAuth.hex(md.digest())
    }

    private fun readFully(s: InputStream, buf: ByteArray): Int {
        var off = 0
        while (off < buf.size) { val n = s.read(buf, off, buf.size - off); if (n <= 0) break; off += n }
        return off
    }

    fun sendFile(host: String, port: Int, peerName: String, uri: Uri, filename: String, fileSize: Long,
                 onProgress: (percent: Double, speedMbps: Double, sent: Long) -> Unit): Result<P2pTransferRecord> {
        cancelFlag.set(false)
        var transferId = ""
        val start = System.currentTimeMillis()
        try {
            val sha = hashUri(uri)
            val prep = JSONObject().put("filename", filename).put("file_size", fileSize).put("sha256", sha).put("sender_name", security.deviceName)
            val (pc, pt) = req(host, port, "POST", "/p2p/file/prepare", prep.toString().toByteArray())
            if (pc != 200) return fail(filename, fileSize, peerName, errorOf(pc, pt))
            transferId = JSONObject(pt).optString("transfer_id")
            if (transferId.isBlank()) return fail(filename, fileSize, peerName, "Transfer qəbul edilmədi")
            var sent = 0L
            val buf = ByteArray(CHUNK)
            val md = MessageDigest.getInstance("SHA-256")
            context.contentResolver.openInputStream(uri)?.use { stream ->
                while (true) {
                    if (cancelFlag.get()) {
                        try { req(host, port, "POST", "/p2p/file/cancel/$transferId") } catch (_: Exception) {}
                        return fail(filename, fileSize, peerName, "Ləğv edildi", "canceled", transferId)
                    }
                    val n = readFully(stream, buf)
                    if (n <= 0) break
                    val chunk = buf.copyOf(n)
                    md.update(chunk)
                    var attempt = 0
                    while (true) {
                        attempt++
                        val ok = try {
                            val (cc, ct) = req(host, port, "POST", "/p2p/file/chunk/$transferId?offset=$sent", chunk, "application/octet-stream", 60000)
                            if (cc == 401 || cc == 404) return fail(filename, fileSize, peerName, errorOf(cc, ct), id = transferId)
                            cc == 200
                        } catch (e: Exception) { false }
                        if (ok) break
                        if (attempt >= 3) return fail(filename, fileSize, peerName, "Hissə göndərilmədi", id = transferId)
                        Thread.sleep(500L * attempt)
                    }
                    sent += n
                    val el = (System.currentTimeMillis() - start) / 1000.0
                    onProgress(if (fileSize > 0) minOf(100.0, sent * 100.0 / fileSize) else 100.0, if (el > 0.05) sent / 1048576.0 / el else 0.0, sent)
                }
            } ?: return fail(filename, fileSize, peerName, "Fayl açıla bilmədi")
            if (P2pAuth.hex(md.digest()) != sha) return fail(filename, fileSize, peerName, "Fayl göndərilərkən dəyişdi", id = transferId)
            val (fc, ft) = req(host, port, "POST", "/p2p/file/finish/$transferId", JSONObject().put("sha256", sha).toString().toByteArray(), timeout = 60000)
            if (fc != 200) return fail(filename, fileSize, peerName, errorOf(fc, ft), id = transferId)
            if (JSONObject(ft).optString("sha256") != sha) return fail(filename, fileSize, peerName, "Qəbul edənin SHA-256 dəyəri uyğun gəlmir", id = transferId)
            val el = (System.currentTimeMillis() - start) / 1000.0
            val rec = P2pTransferRecord(transferId, filename, sent, "send", peerName, "completed", if (el > 0) sent / 1048576.0 / el else 0.0, sha, System.currentTimeMillis())
            storage.addTransfer(rec)
            return Result.success(rec)
        } catch (e: InterruptedException) {
            return fail(filename, fileSize, peerName, "Ləğv edildi", "canceled", transferId)
        } catch (e: Exception) {
            return fail(filename, fileSize, peerName, e.message ?: "Ötürmə xətası", id = transferId)
        }
    }

    private fun fail(name: String, size: Long, peer: String, msg: String, status: String = "failed", id: String = ""): Result<P2pTransferRecord> {
        storage.addTransfer(P2pTransferRecord(id.ifBlank { "fail_${System.currentTimeMillis()}" }, name, size, "send", peer, status, 0.0, "", System.currentTimeMillis()))
        return Result.failure(Exception(msg))
    }
}
