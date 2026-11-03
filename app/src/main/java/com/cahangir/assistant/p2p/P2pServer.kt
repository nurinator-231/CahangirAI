package com.cahangir.assistant.p2p

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.media.MediaScannerConnection
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.util.Log
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

class P2pServer(
    private val context: Context,
    private val port: Int = 8767
) {
    private val TAG = "CahangirP2pServer"
    private val mainHandler = Handler(Looper.getMainLooper())
    private val threadPool = Executors.newCachedThreadPool()
    private val isRunning = AtomicBoolean(false)
    private var serverSocket: ServerSocket? = null
    private val storage = P2pTransferStorage(context)
    private val securityManager = SecurityManager(context)

    var lastClipboardHash: String = ""

    // Listeners for UI callbacks
    var onTransferStarted: ((id: String, name: String, size: Long, sender: String) -> Unit)? = null
    var onTransferProgress: ((id: String, received: Long, total: Long, percent: Double, speed: Double) -> Unit)? = null
    var onTransferComplete: ((id: String, name: String, size: Long, speed: Double, sha256: String, path: String) -> Unit)? = null
    var onClipboardReceived: ((text: String, origin: String, hash: String) -> Unit)? = null

    private class IncomingSession(
        val transferId: String,
        val file: File,
        val fos: FileOutputStream,
        val totalSize: Long,
        val filename: String,
        val senderName: String,
        val digest: MessageDigest,
        val startTime: Long
    ) {
        var receivedSize: Long = 0L
    }

    private val incomingTransfers = ConcurrentHashMap<String, IncomingSession>()

    fun start() {
        if (isRunning.get()) return
        isRunning.set(true)

        threadPool.execute {
            try {
                serverSocket = ServerSocket(port)
                Log.i(TAG, "P2P Server listening on port $port")

                while (isRunning.get() && serverSocket?.isClosed == false) {
                    val clientSocket = serverSocket?.accept() ?: break
                    threadPool.execute {
                        handleClient(clientSocket)
                    }
                }
            } catch (e: Exception) {
                if (isRunning.get()) {
                    Log.e(TAG, "Server socket error", e)
                }
            }
        }
    }

    fun stop() {
        isRunning.set(false)
        try {
            serverSocket?.close()
        } catch (_: Exception) {}
        serverSocket = null
    }

    fun isServerRunning(): Boolean = isRunning.get()

    private fun handleClient(socket: Socket) {
        try {
            socket.soTimeout = 30000
            val input = socket.getInputStream()
            val output = socket.getOutputStream()

            // 1. Parse HTTP Request Line & Headers
            val headerBytes = readHeaders(input)
            if (headerBytes.isEmpty()) {
                socket.close()
                return
            }

            val headerStr = String(headerBytes, Charsets.UTF_8)
            val lines = headerStr.split("\r\n")
            if (lines.isEmpty()) {
                socket.close()
                return
            }

            val reqLine = lines[0].split(" ")
            if (reqLine.size < 2) {
                socket.close()
                return
            }

            val method = reqLine[0].uppercase()
            val rawPath = reqLine[1]
            val path = rawPath.split("?")[0]

            // Parse headers
            val headers = mutableMapOf<String, String>()
            for (i in 1 until lines.size) {
                val colon = lines[i].indexOf(":")
                if (colon > 0) {
                    val k = lines[i].substring(0, colon).trim().lowercase()
                    val v = lines[i].substring(colon + 1).trim()
                    headers[k] = v
                }
            }

            val contentLength = headers["content-length"]?.toLongOrNull() ?: 0L

            // Handle CORS preflight
            if (method == "OPTIONS") {
                sendResponse(output, 200, "OK", "text/plain", "")
                socket.close()
                return
            }

            // Route handling
            when {
                method == "GET" && path == "/p2p/ping" -> {
                    val res = JSONObject().apply {
                        put("device_id", securityManager.deviceId)
                        put("device_name", securityManager.deviceName)
                        put("status", "online")
                    }
                    sendResponse(output, 200, "OK", "application/json", res.toString())
                }

                method == "POST" && path == "/p2p/file/prepare" -> {
                    val bodyBytes = readExactBytes(input, contentLength.toInt())
                    val bodyJson = JSONObject(String(bodyBytes, Charsets.UTF_8))
                    val filename = bodyJson.optString("filename", "received_file")
                    val fileSize = bodyJson.optLong("file_size", 0L)
                    val senderName = bodyJson.optString("sender_name", "Naməlum cihaz")

                    val transferId = UUID.randomUUID().toString()
                    val targetDir = getDownloadsDir()
                    val safeName = filename.replace(Regex("[\\\\/:*?\"<>|]"), "_")
                    var destFile = File(targetDir, safeName)
                    if (destFile.exists()) {
                        val dot = safeName.lastIndexOf(".")
                        val base = if (dot > 0) safeName.substring(0, dot) else safeName
                        val ext = if (dot > 0) safeName.substring(dot) else ""
                        destFile = File(targetDir, "${base}_${System.currentTimeMillis()}$ext")
                    }

                    val fos = FileOutputStream(destFile)
                    val digest = MessageDigest.getInstance("SHA-256")
                    val session = IncomingSession(
                        transferId = transferId,
                        file = destFile,
                        fos = fos,
                        totalSize = fileSize,
                        filename = filename,
                        senderName = senderName,
                        digest = digest,
                        startTime = System.currentTimeMillis()
                    )
                    incomingTransfers[transferId] = session

                    mainHandler.post {
                        onTransferStarted?.invoke(transferId, filename, fileSize, senderName)
                    }

                    val res = JSONObject().apply {
                        put("transfer_id", transferId)
                        put("accepted", true)
                        put("message", "Ready to receive chunks")
                    }
                    sendResponse(output, 200, "OK", "application/json", res.toString())
                }

                method == "POST" && path.startsWith("/p2p/file/chunk/") -> {
                    val transferId = path.removePrefix("/p2p/file/chunk/").trim()
                    val session = incomingTransfers[transferId]
                    if (session == null) {
                        sendResponse(output, 404, "Not Found", "application/json", "{\"error\":\"Transfer not found\"}")
                    } else {
                        // Stream chunk directly to file
                        val buffer = ByteArray(64 * 1024)
                        var remaining = contentLength
                        while (remaining > 0) {
                            val toRead = Math.min(buffer.size.toLong(), remaining).toInt()
                            val n = input.read(buffer, 0, toRead)
                            if (n <= 0) break
                            session.fos.write(buffer, 0, n)
                            session.digest.update(buffer, 0, n)
                            session.receivedSize += n
                            remaining -= n
                        }

                        val elapsedSec = (System.currentTimeMillis() - session.startTime) / 1000.0
                        val speedMbps = if (elapsedSec > 0.05) (session.receivedSize / (1024.0 * 1024.0)) / elapsedSec else 0.0
                        val percent = if (session.totalSize > 0) Math.min(100.0, (session.receivedSize.toDouble() / session.totalSize) * 100.0) else 100.0

                        mainHandler.post {
                            onTransferProgress?.invoke(transferId, session.receivedSize, session.totalSize, percent, speedMbps)
                        }

                        val res = JSONObject().apply {
                            put("received_size", session.receivedSize)
                        }
                        sendResponse(output, 200, "OK", "application/json", res.toString())
                    }
                }

                method == "POST" && path.startsWith("/p2p/file/finish/") -> {
                    val transferId = path.removePrefix("/p2p/file/finish/").trim()
                    val session = incomingTransfers.remove(transferId)
                    if (session == null) {
                        sendResponse(output, 404, "Not Found", "application/json", "{\"error\":\"Transfer not found\"}")
                    } else {
                        try {
                            session.fos.flush()
                            session.fos.close()
                        } catch (_: Exception) {}

                        val shaHex = bytesToHex(session.digest.digest())
                        val elapsedSec = (System.currentTimeMillis() - session.startTime) / 1000.0
                        val speedMbps = if (elapsedSec > 0.0) (session.receivedSize / (1024.0 * 1024.0)) / elapsedSec else 0.0

                        // Notify MediaScanner so file appears in Android Files/Downloads immediately
                        try {
                            MediaScannerConnection.scanFile(context, arrayOf(session.file.absolutePath), null, null)
                        } catch (_: Exception) {}

                        // Record in transfer history
                        val record = P2pTransferRecord(
                            id = transferId,
                            filename = session.filename,
                            fileSize = session.receivedSize,
                            direction = "receive",
                            peerDevice = session.senderName,
                            status = "completed",
                            speedMbps = speedMbps,
                            sha256 = shaHex,
                            timestamp = System.currentTimeMillis()
                        )
                        storage.addTransfer(record)

                        mainHandler.post {
                            onTransferComplete?.invoke(transferId, session.filename, session.receivedSize, speedMbps, shaHex, session.file.absolutePath)
                        }

                        val res = JSONObject().apply {
                            put("success", true)
                            put("received_size", session.receivedSize)
                            put("sha256", shaHex)
                        }
                        sendResponse(output, 200, "OK", "application/json", res.toString())
                    }
                }

                method == "POST" && path == "/p2p/clipboard" -> {
                    val bodyBytes = readExactBytes(input, contentLength.toInt())
                    val bodyJson = JSONObject(String(bodyBytes, Charsets.UTF_8))
                    val clipText = bodyJson.optString("text", "")
                    val origin = bodyJson.optString("origin_device", "Digər Cihaz")
                    val hash = bodyJson.optString("hash", "")

                    if (hash.isNotBlank() && hash == lastClipboardHash) {
                        sendResponse(output, 200, "OK", "application/json", "{\"skipped\":true}")
                    } else {
                        lastClipboardHash = hash
                        // Set Android system clipboard on main thread
                        mainHandler.post {
                            try {
                                val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                                val clip = ClipData.newPlainText("Cahangir", clipText)
                                cm.setPrimaryClip(clip)
                            } catch (e: Exception) {
                                Log.w(TAG, "Failed to set clipboard", e)
                            }
                            onClipboardReceived?.invoke(clipText, origin, hash)
                        }

                        sendResponse(output, 200, "OK", "application/json", "{\"success\":true,\"message\":\"Clipboard updated\"}")
                    }
                }

                else -> {
                    sendResponse(output, 404, "Not Found", "application/json", "{\"error\":\"Route not found\"}")
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Client handling exception: ${e.message}")
        } finally {
            try { socket.close() } catch (_: Exception) {}
        }
    }

    private fun readHeaders(input: InputStream): ByteArray {
        val baos = ByteArrayOutputStream()
        var matched = 0
        while (true) {
            val b = input.read()
            if (b == -1) break
            baos.write(b)
            if ((matched == 0 || matched == 2) && b == '\r'.code) {
                matched++
            } else if ((matched == 1 || matched == 3) && b == '\n'.code) {
                matched++
                if (matched == 4) break
            } else {
                matched = if (b == '\r'.code) 1 else 0
            }
        }
        return baos.toByteArray()
    }

    private fun readExactBytes(input: InputStream, length: Int): ByteArray {
        if (length <= 0) return ByteArray(0)
        val data = ByteArray(length)
        var total = 0
        while (total < length) {
            val read = input.read(data, total, length - total)
            if (read == -1) break
            total += read
        }
        return if (total == length) data else data.copyOf(total)
    }

    private fun sendResponse(output: OutputStream, statusCode: Int, statusText: String, contentType: String, body: String) {
        val bodyBytes = body.toByteArray(Charsets.UTF_8)
        val header = "HTTP/1.1 $statusCode $statusText\r\n" +
                "Content-Type: $contentType; charset=utf-8\r\n" +
                "Content-Length: ${bodyBytes.size}\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
                "Access-Control-Allow-Headers: Content-Type, Authorization\r\n" +
                "Connection: close\r\n\r\n"
        output.write(header.toByteArray(Charsets.UTF_8))
        if (bodyBytes.isNotEmpty()) {
            output.write(bodyBytes)
        }
        output.flush()
    }

    private fun getDownloadsDir(): File {
        val publicDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val cahangirDir = File(publicDir, "Cahangir")
        if (!cahangirDir.exists()) {
            cahangirDir.mkdirs()
        }
        return if (cahangirDir.exists() && cahangirDir.canWrite()) cahangirDir else (context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir)
    }

    private fun bytesToHex(bytes: ByteArray): String {
        val sb = StringBuilder()
        for (b in bytes) {
            sb.append(String.format("%02x", b))
        }
        return sb.toString()
    }

    companion object {
        fun getNetworkIps(): List<String> {
            val ips = mutableListOf<String>()
            try {
                val interfaces = NetworkInterface.getNetworkInterfaces() ?: return ips
                for (intf in interfaces) {
                    if (!intf.isUp || intf.isLoopback) continue
                    for (addr in intf.inetAddresses) {
                        if (addr is Inet4Address && !addr.isLoopbackAddress) {
                            val host = addr.hostAddress ?: continue
                            // Put Tailscale (100.x.y.z) first if available
                            if (host.startsWith("100.")) {
                                ips.add(0, host)
                            } else {
                                ips.add(host)
                            }
                        }
                    }
                }
            } catch (_: Exception) {}
            return ips
        }
    }
}
