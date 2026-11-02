package com.cahangir.assistant.alarm

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import com.cahangir.assistant.MainActivity
import com.cahangir.assistant.tts.TextToSpeechEngine

class AlarmActivity : ComponentActivity() {

    private var ttsEngine: TextToSpeechEngine? = null
    private var vibrator: Vibrator? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Wake screen and show over lock screen
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
            val km = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
            km?.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD
            )
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val reminderId = intent.getLongExtra("reminder_id", 0L)
        val reminderText = intent.getStringExtra("reminder_text") ?: "Xatırlatma vaxtıdır"
        val isTimer = intent.getBooleanExtra("reminder_is_timer", false)
        val userName = intent.getStringExtra("user_name") ?: ""

        val displayText = if (isTimer) "Taymer bitdi!" else reminderText

        // Start native TTS announcement
        ttsEngine = TextToSpeechEngine(this)
        val speechText = if (userName.isNotBlank()) {
            "$userName, ${if (isTimer) "taymer bitdi" else "xatırladıram: $reminderText"}"
        } else {
            if (isTimer) "Taymer bitdi" else "Xatırladıram: $reminderText"
        }
        ttsEngine?.speak(speechText)

        // Start vibration
        startVibration()

        // Play alarm ringtone
        playRingtone()

        // Build UI programmatically for lightweight instant rendering
        val rootLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#030814"))
            setPadding(48, 64, 48, 64)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.MATCH_PARENT
            )
        }

        val iconView = TextView(this).apply {
            text = "🔔"
            textSize = 56f
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, 24)
        }
        rootLayout.addView(iconView)

        val titleView = TextView(this).apply {
            text = "Cahangir Xatırladır"
            textSize = 26f
            setTextColor(Color.parseColor("#7fd0ff"))
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, 16)
        }
        rootLayout.addView(titleView)

        val reminderTextView = TextView(this).apply {
            text = displayText
            textSize = 22f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setPadding(24, 16, 24, 48)
        }
        rootLayout.addView(reminderTextView)

        val buttonsLayout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }

        // Button: ✓ Oldu
        val ackButton = Button(this).apply {
            text = "✓ Oldu"
            textSize = 18f
            setTextColor(Color.parseColor("#030814"))
            val bg = GradientDrawable().apply {
                setColor(Color.parseColor("#3aa0ff"))
                cornerRadius = 24f
            }
            background = bg
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(0, 16, 0, 16)
            }
            setOnClickListener {
                stopVibration()
                ttsEngine?.stop()
                ReminderScheduler.acknowledgeReminder(this@AlarmActivity, reminderId)
                finish()
            }
        }
        buttonsLayout.addView(ackButton)

        // Button: 💤 10 dəq. sonra
        val snoozeButton = Button(this).apply {
            text = "💤 10 dəq. sonra"
            textSize = 16f
            setTextColor(Color.parseColor("#7fd0ff"))
            val bg = GradientDrawable().apply {
                setColor(Color.parseColor("#0d204d"))
                setStroke(2, Color.parseColor("#3aa0ff"))
                cornerRadius = 24f
            }
            background = bg
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(0, 8, 0, 16)
            }
            setOnClickListener {
                stopVibration()
                ttsEngine?.stop()
                ReminderScheduler.snoozeReminder(this@AlarmActivity, reminderId, 10 * 60 * 1000L)
                finish()
            }
        }
        buttonsLayout.addView(snoozeButton)

        // Button: Cahangiri Aç
        val openAppButton = Button(this).apply {
            text = "Cahangiri Aç"
            textSize = 15f
            setTextColor(Color.parseColor("#8899bb"))
            setBackgroundColor(Color.TRANSPARENT)
            setOnClickListener {
                stopVibration()
                ttsEngine?.stop()
                val intent = Intent(this@AlarmActivity, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                }
                startActivity(intent)
                finish()
            }
        }
        buttonsLayout.addView(openAppButton)

        rootLayout.addView(buttonsLayout)
        setContentView(rootLayout)
    }

    private fun startVibration() {
        vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vm = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
            vm?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }

        val pattern = longArrayOf(0, 400, 200, 400, 200, 400)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            vibrator?.vibrate(VibrationEffect.createWaveform(pattern, 0))
        } else {
            @Suppress("DEPRECATION")
            vibrator?.vibrate(pattern, 0)
        }
    }

    private fun stopVibration() {
        try {
            vibrator?.cancel()
        } catch (e: Exception) {}
    }

    private fun playRingtone() {
        try {
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            val ringtone = RingtoneManager.getRingtone(applicationContext, uri)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                ringtone?.audioAttributes = AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            }
            ringtone?.play()
        } catch (e: Exception) {}
    }

    override fun onDestroy() {
        super.onDestroy()
        stopVibration()
        ttsEngine?.shutdown()
        ttsEngine = null
    }
}
