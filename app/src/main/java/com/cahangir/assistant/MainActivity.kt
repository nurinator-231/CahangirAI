package com.cahangir.assistant

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import com.cahangir.assistant.alarm.ReminderScheduler
import com.cahangir.assistant.bridge.CahangirBridge
import com.cahangir.assistant.calendar.CalendarIntegrationManager
import com.cahangir.assistant.data.local.repository.CahangirRepository
import com.cahangir.assistant.saf.StorageAccessManager
import com.cahangir.assistant.stt.SpeechRecognitionManager
import com.cahangir.assistant.sync.SyncManager
import com.cahangir.assistant.tts.TextToSpeechEngine
import org.json.JSONObject

class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private lateinit var ttsEngine: TextToSpeechEngine
    private lateinit var sttManager: SpeechRecognitionManager
    private lateinit var bridge: CahangirBridge
    private lateinit var repository: CahangirRepository

    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    // Pending backup export string waiting for SAF file creation
    private var pendingBackupJson: String? = null

    // Pending calendar export data waiting for user permission
    private var pendingCalendarTitle: String? = null
    private var pendingCalendarTime: Long? = null

    // File Chooser for <input type="file">
    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            val data = result.data
            val uri = data?.data
            val uris = if (uri != null) arrayOf(uri) else null
            filePathCallback?.onReceiveValue(uris)
        } else {
            filePathCallback?.onReceiveValue(null)
        }
        filePathCallback = null
    }

    // SAF Create Document launcher for backup export
    private val createDocumentLauncher = registerForActivityResult(
        ActivityResultContracts.CreateDocument("application/json")
    ) { uri: Uri? ->
        val json = pendingBackupJson
        pendingBackupJson = null
        if (uri != null && json != null) {
            val ok = StorageAccessManager.exportBackupToUri(this, uri, json)
            if (ok) {
                Toast.makeText(this, "✓ Ehtiyat nüsxə yadda saxlanıldı", Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(this, "Xəta: Fayl yazıla bilmədi", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // SAF Open Document launcher for backup import
    private val openDocumentLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        if (uri != null) {
            val jsonContent = StorageAccessManager.importBackupFromUri(this, uri)
            if (!jsonContent.isNullOrBlank()) {
                val quoted = JSONObject.quote(jsonContent)
                webView.evaluateJavascript("if (window.cahangirImportBackup) window.cahangirImportBackup($quoted);", null)
                Toast.makeText(this, "✓ Ehtiyat nüsxə bərpa edildi", Toast.LENGTH_SHORT).show()
            }
        }
    }

    // Calendar Permission launcher
    private val calendarPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        if (isGranted) {
            val title = pendingCalendarTitle
            val time = pendingCalendarTime
            if (title != null && time != null) {
                val ok = CalendarIntegrationManager.addReminderToCalendar(this, title, time)
                if (ok) Toast.makeText(this, "✓ Təqvimə əlavə edildi", Toast.LENGTH_SHORT).show()
            }
        } else {
            Toast.makeText(this, "Təqvim icazəsi verilmədi", Toast.LENGTH_SHORT).show()
        }
        pendingCalendarTitle = null
        pendingCalendarTime = null
    }

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val recordAudioGranted = permissions[Manifest.permission.RECORD_AUDIO] == true
        val postNotifGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions[Manifest.permission.POST_NOTIFICATIONS] == true
        } else true

        Log.i("CahangirMain", "Permissions: RecordAudio=$recordAudioGranted, PostNotif=$postNotifGranted")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        window.decorView.setBackgroundColor(Color.parseColor("#030814"))

        ttsEngine = TextToSpeechEngine(this)
        sttManager = SpeechRecognitionManager(this)
        repository = CahangirRepository(this)

        setupWebView()
        requestAppPermissions()
        setupBackHandler()

        // Schedule periodic sync via WorkManager
        SyncManager.schedulePeriodicSync(this)

        // Listen for repository updates (e.g. from background sync) to refresh WebView
        repository.addListener {
            runOnUiThread {
                webView.evaluateJavascript("if (typeof window.onServerSyncComplete === 'function') window.onServerSyncComplete();", null)
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(Color.parseColor("#030814"))
        }

        ViewCompat.setOnApplyWindowInsetsListener(webView) { view, windowInsets ->
            val insets = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(insets.left, insets.top, insets.right, insets.bottom)
            WindowInsetsCompat.CONSUMED
        }

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        bridge = CahangirBridge(
            activity = this,
            webView = webView,
            ttsEngine = ttsEngine,
            sttManager = sttManager,
            onRequestAudioPermission = { requestAudioPermissionIfNeeded() },
            onRequestCalendarPermission = { title, time ->
                pendingCalendarTitle = title
                pendingCalendarTime = time
                calendarPermissionLauncher.launch(Manifest.permission.WRITE_CALENDAR)
            },
            onExportBackup = { json ->
                pendingBackupJson = json
                val filename = "cahangir-backup-${System.currentTimeMillis()}.json"
                createDocumentLauncher.launch(filename)
            },
            onImportBackup = {
                openDocumentLauncher.launch(arrayOf("application/json", "*/*"))
            }
        )

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            useWideViewPort = true
            loadWithOverviewMode = true
        }

        webView.addJavascriptInterface(bridge, "CahangirBridge")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest
            ): WebResourceResponse? {
                return assetLoader.shouldInterceptRequest(request.url)
            }

            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                Log.e("CahangirMain", "Render process gone. Did crash: ${detail.didCrash()}")
                view.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")
                return true
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                Log.i("CahangirMain", "WebView page loaded: $url")
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                this@MainActivity.filePathCallback?.onReceiveValue(null)
                this@MainActivity.filePathCallback = filePathCallback

                val intent = fileChooserParams?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                    type = "*/*"
                }

                try {
                    fileChooserLauncher.launch(intent)
                    return true
                } catch (e: Exception) {
                    Log.e("CahangirMain", "Failed to open file chooser", e)
                    this@MainActivity.filePathCallback = null
                    return false
                }
            }

            override fun onPermissionRequest(request: PermissionRequest?) {
                request?.grant(request.resources)
            }

            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                Log.d("CahangirWeb", "${consoleMessage?.sourceId()}:${consoleMessage?.lineNumber()} - ${consoleMessage?.message()}")
                return true
            }
        }

        setContentView(webView)
        webView.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")
    }

    private fun setupBackHandler() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript(
                    "(function() { " +
                    "  var dlg = document.getElementById('dlg'); " +
                    "  if (dlg && dlg.open) { dlg.close(); return true; } " +
                    "  var alm = document.getElementById('alarm'); " +
                    "  if (alm && !alm.classList.contains('hide')) { alm.classList.add('hide'); return true; } " +
                    "  if (window.__cg && window.__cg.go) { " +
                    "    var chatView = document.getElementById('v-chat'); " +
                    "    if (chatView && chatView.classList.contains('hide')) { " +
                    "      window.__cg.go('chat'); " +
                    "      return true; " +
                    "    } " +
                    "  } " +
                    "  return false; " +
                    "})();"
                ) { result ->
                    if (result != "true") {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            }
        })
    }

    private fun requestAppPermissions() {
        val permissionsToRequest = mutableListOf<String>()

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            permissionsToRequest.add(Manifest.permission.RECORD_AUDIO)
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                permissionsToRequest.add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }

        if (permissionsToRequest.isNotEmpty()) {
            permissionLauncher.launch(permissionsToRequest.toTypedArray())
        }
    }

    private fun requestAudioPermissionIfNeeded() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            permissionLauncher.launch(arrayOf(Manifest.permission.RECORD_AUDIO))
        }
    }

    override fun onResume() {
        super.onResume()
        ReminderScheduler.scheduleNextAlarm(this)
        SyncManager.enqueueImmediateSync(this)
    }

    override fun onDestroy() {
        super.onDestroy()
        ttsEngine.shutdown()
        sttManager.destroy()
        webView.destroy()
    }
}
