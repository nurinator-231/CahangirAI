package com.cahangir.assistant.p2p

import android.content.Context
import android.net.Uri
import android.util.Log
import com.cahangir.assistant.security.SecurityManager
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

class P2pClient(private val context: Context) {
    private val TAG = "CahangirP2pClient"
    private val cancelFlag = AtomicBoolean(false)
    private val storage = P2pTransferStorage(context)
    private val securityManager = SecurityManager(context)

    fun cancelTransfer() {
        cancelFlag.set(true)
    }

    fun pingPeer(peerIp: String, peerPort: Int): Result<JSONObject> {
        return try {
            val cleanIp = peerIp.trim()
            val url = URL("http://$cleanIp:$peerPort/p2p/ping")
            val conn = url.openConnection() as HttpURLConnection
            conn.connectTimeout = 3000
            conn.readTimeout = 3000
            conn.requestMethod = "GET"

            val code = conn.responseCode
            if (code == 200) {
                val body = conn.inputStream.bufferedReader().readText()
                Result.success(JSONObject(body))
            } else {
                Result.failure(Exception("HTTP $code"))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun sendClipboard(peerIp: String, peerPort: Int, text: String): Result<String> {
        return try {
            val cleanIp = peerIp.trim()
            val url = URL("http://$cleanIp:$peerPort/p2p/clipboard")
            val hash = hashText(text)

            val body = JSONObject().apply {
                put("text", text)
                put("origin_device", securityManager.deviceName)
                put("hash", hash)
            }.toString()

            val conn = url.openConnection() as HttpURLConnection
            conn.connectTimeout = 4000
            conn.readTimeout = 4000
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            conn.doOutput = true

            conn.outputStream.use { os ->
                os.write(body.toByteArray(Charsets.UTF_8))
                os.flush()
            }

            val code = conn.responseCode
            if (code in 200..299) {
                Result.success("Pano uğurla göndərildi!")
            } else {
                val err = conn.errorStream?.bufferedReader()?.readText() ?: "HTTP $code"
                Result.failure(Exception(err))
            }
        } catch (e: Exception) {
            Result.failure(e)
        }
    }

    fun sendFile(
        peerIp: String,
        peerPort: Int,
        uri: Uri,
        filename: String,
        fileSize: Long,
        onProgress: (percent: Double, speedMbps: Double, sent: Long) -> Unit
    ): Result<P2pTransferRecord> {
        cancelFlag.set(false)
        val cleanIp = peerIp.trim()
        val baseUrl = "http://$cleanIp:$peerPort"
        val startTime = System.currentTimeMillis()

        try {
            // 1. Prepare handshake
            val prepUrl = URL("$baseUrl/p2p/file/prepare")
            val prepConn = prepUrl.openConnection() as HttpURLConnection
            prepConn.connectTimeout = 10000
            prepConn.readTimeout = 10000
            prepConn.requestMethod = "POST"
            prepConn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            prepConn.doOutput = true

            val prepBody = JSONObject().apply {
                put("filename", filename)
                put("file_size", fileSize)
                put("sha256", "")
                put("sender_name", securityManager.deviceName)
            }.toString()

            prepConn.outputStream.use { os ->
                os.write(prepBody.toByteArray(Charsets.UTF_8))
                os.flush()
            }

            if (prepConn.responseCode !in 200..299) {
                return Result.failure(Exception("Qarşı tərəf qoşulmanı qəbul etmədi: HTTP ${prepConn.responseCode}"))
            }

            val prepResStr = prepConn.inputStream.bufferedReader().readText()
            val prepRes = JSONObject(prepResStr)
            val transferId = prepRes.optString("transfer_id", "")
            if (transferId.isBlank()) {
                return Result.failure(Exception("Transfer ID alına bilmədi"))
            }

            // 2. Stream chunks
            val inputStream: InputStream = context.contentResolver.openInputStream(uri)
                ?: return Result.failure(Exception("Fayl açıla bilmədi"))

            val chunkSize = 256 * 1024 // 256 KB chunk
            val buffer = ByteArray(chunkSize)
            var totalSent = 0L
            val digest = MessageDigest.getInstance("SHA-256")

            inputStream.use { stream ->
                while (true) {
                    if (cancelFlag.get()) {
                        return Result.failure(Exception("Transfer istifadəçi tərəfindən dayandırıldı"))
                    }

                    val read = stream.read(buffer)
                    if (read <= 0) break

                    digest.update(buffer, 0, read)

                    val chunkUrl = URL("$baseUrl/p2p/file/chunk/$transferId")
                    val chunkConn = chunkUrl.openConnection() as HttpURLConnection
                    chunkConn.connectTimeout = 15000
                    chunkConn.readTimeout = 15000
                    chunkConn.requestMethod = "POST"
                    chunkConn.setRequestProperty("Content-Type", "application/octet-stream")
                    chunkConn.setRequestProperty("Content-Length", read.toString())
                    chunkConn.doOutput = true

                    chunkConn.outputStream.use { os ->
                        os.write(buffer, 0, read)
                        os.flush()
                    }

                    if (chunkConn.responseCode !in 200..299) {
                        return Result.failure(Exception("Çank göndərilməsi uğursuz oldu: HTTP ${chunkConn.responseCode}"))
                    }

                    totalSent += read
                    val elapsedSec = (System.currentTimeMillis() - startTime) / 1000.0
                    val speedMbps = if (elapsedSec > 0.05) (totalSent / (1024.0 * 1024.0)) / elapsedSec else 0.0
                    val percent = if (fileSize > 0) Math.min(100.0, (totalSent.toDouble() / fileSize) * 100.0) else 100.0

                    onProgress(percent, speedMbps, totalSent)
                }
            }

            // 3. Finish handshake
            val shaHex = bytesToHex(digest.digest())
            val finishUrl = URL("$baseUrl/p2p/file/finish/$transferId")
            val finishConn = finishUrl.openConnection() as HttpURLConnection
            finishConn.connectTimeout = 10000
            finishConn.readTimeout = 10000
            finishConn.requestMethod = "POST"

            if (finishConn.responseCode !in 200..299) {
                return Result.failure(Exception("Fayl təsdiqi uğursuz oldu: HTTP ${finishConn.responseCode}"))
            }

            val elapsedSec = (System.currentTimeMillis() - startTime) / 1000.0
            val speedMbps = if (elapsedSec > 0.0) (totalSent / (1024.0 * 1024.0)) / elapsedSec else 0.0

            val record = P2pTransferRecord(
                id = transferId,
                filename = filename,
                fileSize = totalSent,
                direction = "send",
                peerDevice = cleanIp,
                status = "completed",
                speedMbps = speedMbps,
                sha256 = shaHex,
                timestamp = System.currentTimeMillis()
            )
            storage.addTransfer(record)

            return Result.success(record)
        } catch (e: Exception) {
            Log.e(TAG, "File send error", e)
            val record = P2pTransferRecord(
                id = "fail_${System.currentTimeMillis()}",
                filename = filename,
                fileSize = fileSize,
                direction = "send",
                peerDevice = cleanIp,
                status = "failed",
                speedMbps = 0.0,
                sha256 = "",
                timestamp = System.currentTimeMillis()
            )
            storage.addTransfer(record)
            return Result.failure(e)
        }
    }

    private fun hashText(text: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val bytes = digest.digest(text.toByteArray(Charsets.UTF_8))
        return bytesToHex(bytes)
    }

    private fun bytesToHex(bytes: ByteArray): String {
        val sb = StringBuilder()
        for (b in bytes) {
            sb.append(String.format("%02x", b))
        }
        return sb.toString()
    }
}
