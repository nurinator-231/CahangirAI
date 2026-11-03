package com.cahangir.assistant.sysinfo

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Environment
import android.os.StatFs
import com.cahangir.assistant.p2p.P2pServer
import com.cahangir.assistant.security.SecurityManager
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class SystemMetricsManager(private val context: Context) {
    private val securityManager = SecurityManager(context)

    fun collectMetrics(): JSONObject {
        val root = JSONObject()

        // 1. Battery info
        try {
            val ifilter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
            val batteryStatus = context.registerReceiver(null, ifilter)
            val level = batteryStatus?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
            val scale = batteryStatus?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
            val batteryPct = if (level >= 0 && scale > 0) (level * 100 / scale) else 0

            val status = batteryStatus?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
            val isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
                    status == BatteryManager.BATTERY_STATUS_FULL
            val temp = (batteryStatus?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0) / 10.0

            root.put("battery_percent", batteryPct)
            root.put("battery_charging", isCharging)
            root.put("battery_temp", temp)
        } catch (_: Exception) {
            root.put("battery_percent", 0)
            root.put("battery_charging", false)
            root.put("battery_temp", 0.0)
        }

        // 2. RAM info
        try {
            val actManager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val memInfo = ActivityManager.MemoryInfo()
            actManager.getMemoryInfo(memInfo)

            val totalMb = memInfo.totalMem / (1024 * 1024)
            val availMb = memInfo.availMem / (1024 * 1024)
            val usedMb = totalMb - availMb
            val ramPercent = if (totalMb > 0) (usedMb.toDouble() / totalMb) * 100.0 else 0.0

            root.put("ram_used_mb", usedMb)
            root.put("ram_total_mb", totalMb)
            root.put("ram_percent", Math.round(ramPercent * 10.0) / 10.0)
        } catch (_: Exception) {
            root.put("ram_used_mb", 0)
            root.put("ram_total_mb", 0)
            root.put("ram_percent", 0.0)
        }

        // 3. Storage info
        try {
            val path = Environment.getDataDirectory()
            val stat = StatFs(path.path)
            val blockSize = stat.blockSizeLong
            val totalBlocks = stat.blockCountLong
            val availableBlocks = stat.availableBlocksLong

            val totalGb = (totalBlocks * blockSize) / (1024.0 * 1024.0 * 1024.0)
            val availGb = (availableBlocks * blockSize) / (1024.0 * 1024.0 * 1024.0)
            val usedGb = totalGb - availGb
            val diskPercent = if (totalGb > 0) (usedGb / totalGb) * 100.0 else 0.0

            root.put("disk_used_gb", Math.round(usedGb * 10.0) / 10.0)
            root.put("disk_total_gb", Math.round(totalGb * 10.0) / 10.0)
            root.put("disk_percent", Math.round(diskPercent * 10.0) / 10.0)
        } catch (_: Exception) {
            root.put("disk_used_gb", 0.0)
            root.put("disk_total_gb", 0.0)
            root.put("disk_percent", 0.0)
        }

        // 4. Network IPs
        val ips = P2pServer.getNetworkIps()
        val tailscaleIp = ips.firstOrNull { it.startsWith("100.") } ?: ""
        val localIp = ips.firstOrNull { !it.startsWith("100.") } ?: ""
        root.put("tailscale_ip", tailscaleIp)
        root.put("local_ip", localIp)
        root.put("device_name", securityManager.deviceName)
        root.put("device_id", securityManager.deviceId)

        // 5. Backend Server Health & Latency
        val serverUrl = securityManager.serverUrl
        if (serverUrl.isNotBlank()) {
            try {
                val start = System.currentTimeMillis()
                val url = URL("$serverUrl/api/health")
                val conn = url.openConnection() as HttpURLConnection
                conn.connectTimeout = 3000
                conn.readTimeout = 3000
                conn.requestMethod = "GET"
                val code = conn.responseCode
                val latency = System.currentTimeMillis() - start

                root.put("server_online", code in 200..299)
                root.put("server_latency_ms", latency)
                root.put("server_url", serverUrl)
            } catch (_: Exception) {
                root.put("server_online", false)
                root.put("server_latency_ms", -1)
                root.put("server_url", serverUrl)
            }
        } else {
            root.put("server_online", false)
            root.put("server_latency_ms", -1)
            root.put("server_url", "")
        }

        return root
    }
}
