package com.cahangir.assistant.p2p

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.media.MediaScannerConnection
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.cahangir.assistant.clipboard.ClipboardHub
import com.cahangir.assistant.data.local.repository.CahangirRepository
import com.cahangir.assistant.security.SecurityManager
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.Inet4Address
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Authenticated receiver for files and clipboard text from paired devices. Runs while
 * the app is open. Every request must carry a valid HMAC signature made with the mesh
 * key from the Debian server (see P2pAuth); being on the same network grants nothing.
 */
class P2pServer(private val context: Context, private val port: Int = DEFAULT_PORT) {
    companion object {
        const val DEFAULT_PORT = 8767
        const val MAX_BODY = 8 * 1024 * 1024
        const val MAX_FILE = 50L * 1024 * 1024 * 1024
        private const val TAG = "CahangirP2pServer"
        private const val SESSION_IDLE_MS = 10 * 60 * 1000L

        fun getNetworkIps(): List<String> {
            val ts = mutableListOf<String>()
            val lan = mutableListOf<String>()
            try {
                for (intf in NetworkInterface.getNetworkInterfaces() ?: return emptyList()) {
                    if (!intf.isUp || intf.isLoopback) continue
                    for (addr in intf.inetAddresses) {
                        if (addr is Inet4Address && !addr.isLoopbackAddress && !addr.isLinkLocalAddress) {
                            val h = addr.hostAddress ?: continue
                            if (h.startsWith("100.")) ts.add(h) else if (addr.isSiteLocalAddress) lan.add(h)
                        }
                    }
                }
            } catch (_: Exception) {}
            return (ts.distinct() + lan.distinct())
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val pool = Executors.newCachedThreadPool()
    private val running = AtomicBoolean(false)
    private var serverSocket: ServerSocket? = null
    private val storage = P2pTransferStorage(context)
    private val security = SecurityManager(context)
    private val verifier = P2pAuth.Verifier()

    var onTransferStarted: ((id: String, name: String, size: Long, sender: String) -> Unit)? = null
    var onTransferProgress: ((id: String, received: Long, total: Long, percent: Double, speed: Double) -> Unit)? = null
    var onTransferComplete: ((id: String, name: String, size: Long, speed: Double, sha256: String, path: String) -> Unit)? = null
    var onTransferFailed: ((id: String, error: String) -> Unit)? = null
    var onClipboardReceived: ((text: String, origin: String, hash: String) -> Unit)? = null

    private class Session(
        val part: File, val target: File, val total: Long, val name: String, val sender: String, val expectedSha: String,
    ) {
        val digest: MessageDigest = MessageDigest.getInstance("SHA-256")
        var received = 0L
        val started = System.currentTimeMillis()
        var lastActivity = System.currentTimeMillis()
    }

    private val sessions = ConcurrentHashMap<String, Session>()

    fun start() {
        if (!running.compareAndSet(false, true)) return
        pool.execute {
            try {
                serverSocket = ServerSocket(port)
                Log.i(TAG, "P2P receiver listening on $port")
                while (running.get()) {
                    val client = serverSocket?.accept() ?: break
                    pool.execute { handle(client) }
                }
            } catch (e: Exception) {
                if (running.get()) Log.e(TAG, "Server socket error", e)
                running.set(false)
            }
        }
        pool.execute {
            while (running.get()) {
                Thread.sleep(60_000)
                val now = System.currentTimeMillis()
                sessions.entries.filter { now - it.value.lastActivity > SESSION_IDLE_MS }.forEach {
                    sessions.remove(it.key)?.part?.delete()
                }
            }
        }
    }

    fun stop() {
        running.set(false)
        try { serverSocket?.close() } catch (_: Exception) {}
        serverSocket = null
        sessions.values.forEach { it.part.delete() }
        sessions.clear()
    }

    fun isServerRunning(): Boolean = running.get()

    private fun handle(socket: Socket) {
        try {
            socket.soTimeout = 60_000
            val input = socket.getInputStream()
            val output = socket.getOutputStream()
            val head = String(readHeaders(input), Charsets.UTF_8)
            val lines = head.split("\r\n")
            val req = lines.firstOrNull()?.split(" ") ?: return
            if (req.size < 2) return
            val method = req[0].uppercase()
            val rawPath = req[1]
            val path = rawPath.substringBefore('?')
            val query = rawPath.substringAfter('?', "").split('&').mapNotNull { kv ->
                val i = kv.indexOf('='); if (i > 0) kv.substring(0, i) to kv.substring(i + 1) else null
            }.toMap()
            val headers = HashMap<String, String>()
            for (i in 1 until lines.size) {
                val c = lines[i].indexOf(':')
                if (c > 0) headers[lines[i].substring(0, c).trim().lowercase()] = lines[i].substring(c + 1).trim()
            }
            val len = headers["content-length"]?.toLongOrNull() ?: 0L
            if (len < 0 || len > MAX_BODY) return respond(output, 413, JSONObject().put("error", "body too large"))
            val body = readExact(input, len.toInt())
            when (verifier.verify(security.meshKey, method, path, headers["x-cahangir-ts"], headers["x-cahangir-nonce"], headers["x-cahangir-sig"], body, System.currentTimeMillis())) {
                P2pAuth.Result.OK -> {}
                P2pAuth.Result.NOT_PAIRED -> return respond(output, 503, JSONObject().put("error", "receiver is not paired with the Cahangir server yet"))
                P2pAuth.Result.EXPIRED -> return respond(output, 401, JSONObject().put("error", "request expired (check device clocks)"))
                else -> return respond(output, 401, JSONObject().put("error", "unauthenticated device"))
            }
            val res: Pair<Int, JSONObject> = when {
                method == "GET" && path == "/p2p/ping" -> 200 to JSONObject().put("device_id", security.deviceId)
                    .put("device_name", security.deviceName).put("status", "online").put("platform", "android")
                method == "POST" && path == "/p2p/file/prepare" -> prepare(JSONObject(String(body, Charsets.UTF_8)))
                method == "POST" && path.startsWith("/p2p/file/chunk/") -> chunk(path.removePrefix("/p2p/file/chunk/"), query["offset"]?.toLongOrNull(), body)
                method == "POST" && path.startsWith("/p2p/file/finish/") -> finish(path.removePrefix("/p2p/file/finish/"), body)
                method == "POST" && path.startsWith("/p2p/file/cancel/") -> cancel(path.removePrefix("/p2p/file/cancel/"))
                method == "POST" && path == "/p2p/clipboard" -> clipboard(JSONObject(String(body, Charsets.UTF_8)))
                else -> 404 to JSONObject().put("error", "not found")
            }
            respond(output, res.first, res.second)
        } catch (e: Exception) {
            Log.w(TAG, "Request failed: ${e.message}")
        } finally {
            try { socket.close() } catch (_: Exception) {}
        }
    }

    private fun downloadsDir(): File {
        val pub = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Cahangir")
        if (!pub.exists()) pub.mkdirs()
        return if (pub.exists() && pub.canWrite()) pub else (context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir)
    }

    private fun uniqueFile(dir: File, name: String): File {
        var f = File(dir, name)
        if (!f.exists()) return f
        val stem = name.substringBeforeLast('.', name)
        val ext = if (name.contains('.') && stem.isNotEmpty()) "." + name.substringAfterLast('.') else ""
        var i = 1
        while (f.exists() && i < 10000) { f = File(dir, "$stem ($i)$ext"); i++ }
        return f
    }

    private fun prepare(req: JSONObject): Pair<Int, JSONObject> {
        val size = req.optLong("file_size", -1)
        if (size < 0 || size > MAX_FILE) return 413 to JSONObject().put("error", "invalid size")
        val sha = req.optString("sha256", "").lowercase()
        if (sha.isNotEmpty() && (sha.length != 64 || P2pAuth.unhex(sha) == null)) return 400 to JSONObject().put("error", "invalid sha256")
        val dir = downloadsDir()
        val name = P2pAuth.sanitizeFilename(req.optString("filename", "file"))
        val id = UUID.randomUUID().toString()
        val part = File(dir, ".$id.cahangir-part")
        part.writeBytes(ByteArray(0))
        val sender = req.optString("sender_name", "?").take(100)
        sessions[id] = Session(part, uniqueFile(dir, name), size, name, sender, sha)
        mainHandler.post { onTransferStarted?.invoke(id, name, size, sender) }
        return 200 to JSONObject().put("transfer_id", id).put("accepted", true).put("filename", name)
    }

    private fun chunk(id: String, offset: Long?, data: ByteArray): Pair<Int, JSONObject> {
        val s = sessions[id] ?: return 404 to JSONObject().put("error", "transfer not found")
        synchronized(s) {
            val off = offset ?: s.received
            if (off + data.size <= s.received) return 200 to JSONObject().put("received", s.received).put("duplicate", true)
            if (off != s.received) return 409 to JSONObject().put("error", "unexpected offset").put("received", s.received)
            if (s.received + data.size > s.total) return 400 to JSONObject().put("error", "more data than announced")
            FileOutputStream(s.part, true).use { it.write(data) }
            s.digest.update(data)
            s.received += data.size
            s.lastActivity = System.currentTimeMillis()
            val el = (System.currentTimeMillis() - s.started) / 1000.0
            val speed = if (el > 0.05) s.received / 1048576.0 / el else 0.0
            val pct = if (s.total > 0) minOf(100.0, s.received * 100.0 / s.total) else 100.0
            mainHandler.post { onTransferProgress?.invoke(id, s.received, s.total, pct, speed) }
            return 200 to JSONObject().put("received", s.received)
        }
    }

    private fun record(id: String, s: Session, status: String, sha: String, speed: Double, name: String = s.name) =
        storage.addTransfer(P2pTransferRecord(id, name, s.received, "receive", s.sender, status, speed, sha, System.currentTimeMillis()))

    private fun finish(id: String, body: ByteArray): Pair<Int, JSONObject> {
        val s = sessions.remove(id) ?: return 404 to JSONObject().put("error", "transfer not found")
        val req = try { JSONObject(String(body, Charsets.UTF_8)) } catch (_: Exception) { JSONObject() }
        val actual = P2pAuth.hex(s.digest.digest())
        val expected = req.optString("sha256", "").lowercase().ifEmpty { s.expectedSha }
        if (s.received != s.total) {
            s.part.delete(); record(id, s, "failed", actual, 0.0)
            mainHandler.post { onTransferFailed?.invoke(id, "incomplete file") }
            return 409 to JSONObject().put("error", "incomplete file")
        }
        if (expected.isEmpty() || expected != actual) {
            s.part.delete(); record(id, s, "failed", actual, 0.0)
            mainHandler.post { onTransferFailed?.invoke(id, "SHA-256 mismatch") }
            return 409 to JSONObject().put("error", "sha256 mismatch").put("sha256", actual)
        }
        val target = if (s.target.exists()) uniqueFile(s.target.parentFile!!, s.name) else s.target
        if (!s.part.renameTo(target)) {
            s.part.delete()
            return 500 to JSONObject().put("error", "could not save file")
        }
        val el = (System.currentTimeMillis() - s.started) / 1000.0
        val speed = if (el > 0) s.received / 1048576.0 / el else 0.0
        record(id, s, "completed", actual, speed, target.name)
        try { MediaScannerConnection.scanFile(context, arrayOf(target.absolutePath), null, null) } catch (_: Exception) {}
        mainHandler.post { onTransferComplete?.invoke(id, target.name, s.received, speed, actual, target.absolutePath) }
        return 200 to JSONObject().put("success", true).put("received_size", s.received).put("sha256", actual).put("verified", true)
    }

    private fun cancel(id: String): Pair<Int, JSONObject> {
        sessions.remove(id)?.let { s ->
            s.part.delete(); record(id, s, "canceled", "", 0.0)
            mainHandler.post { onTransferFailed?.invoke(id, "canceled by sender") }
        }
        return 200 to JSONObject().put("success", true)
    }

    private fun clipboard(req: JSONObject): Pair<Int, JSONObject> {
        val text = req.optString("text", "")
        if (text.length > 100_000) return 413 to JSONObject().put("error", "too large")
        val hash = ClipboardHub.hash(text)
        if (req.optString("hash").isNotEmpty() && req.optString("hash") != hash) return 400 to JSONObject().put("error", "hash mismatch")
        if (!ClipboardHub.markSeen(hash)) return 200 to JSONObject().put("skipped", true)
        val origin = req.optString("origin_device", "?").take(100)
        val id = req.optString("id", "")
        if (id.isNotEmpty() && id.length <= 100) {
            val now = System.currentTimeMillis()
            CahangirRepository.get(context).store.applyRemote("clipboard_items", JSONObject().put("id", id).put("text", text).put("hash", hash)
                .put("origin_name", origin).put("created_at", now).put("updated_at", now).put("deleted", 0).put("server_rev", 0), false)
        }
        val accept = security.clipboardAccept
        mainHandler.post {
            if (accept) {
                try {
                    (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Cahangir", text))
                } catch (e: Exception) { Log.w(TAG, "Failed to set clipboard", e) }
            }
            onClipboardReceived?.invoke(text, origin, hash)
        }
        return 200 to JSONObject().put("success", true).put("applied", accept)
    }

    private fun readHeaders(input: InputStream): ByteArray {
        val baos = ByteArrayOutputStream()
        var matched = 0
        while (baos.size() < 16 * 1024) {
            val b = input.read()
            if (b == -1) break
            baos.write(b)
            matched = when {
                (matched == 0 || matched == 2) && b == '\r'.code -> matched + 1
                (matched == 1 || matched == 3) && b == '\n'.code -> matched + 1
                b == '\r'.code -> 1
                else -> 0
            }
            if (matched == 4) break
        }
        return baos.toByteArray()
    }

    private fun readExact(input: InputStream, n: Int): ByteArray {
        val data = ByteArray(n)
        var off = 0
        while (off < n) {
            val r = input.read(data, off, n - off)
            if (r < 0) break
            off += r
        }
        return if (off == n) data else data.copyOf(off)
    }

    private fun respond(out: OutputStream, code: Int, body: JSONObject) {
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        val status = when (code) { 200 -> "OK"; 400 -> "Bad Request"; 401 -> "Unauthorized"; 404 -> "Not Found"; 409 -> "Conflict"; 413 -> "Payload Too Large"; 503 -> "Service Unavailable"; else -> "Error" }
        out.write("HTTP/1.1 $code $status\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
        out.write(bytes)
        out.flush()
    }
}
