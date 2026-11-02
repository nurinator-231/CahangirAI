package com.cahangir.assistant.tts

import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale

class TextToSpeechEngine(context: Context) : TextToSpeech.OnInitListener {

    private val mainHandler = Handler(Looper.getMainLooper())
    private var tts: TextToSpeech? = TextToSpeech(context.applicationContext, this)
    private var isInitialized = false
    private var pendingSpeech: (() -> Unit)? = null

    private var currentOnStart: (() -> Unit)? = null
    private var currentOnEnd: (() -> Unit)? = null

    init {
        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {
                mainHandler.post {
                    currentOnStart?.invoke()
                }
            }

            override fun onDone(utteranceId: String?) {
                mainHandler.post {
                    currentOnEnd?.invoke()
                    currentOnStart = null
                    currentOnEnd = null
                }
            }

            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
                mainHandler.post {
                    currentOnEnd?.invoke()
                    currentOnStart = null
                    currentOnEnd = null
                }
            }

            override fun onError(utteranceId: String?, errorCode: Int) {
                Log.w("CahangirTTS", "TTS error code: $errorCode")
                mainHandler.post {
                    currentOnEnd?.invoke()
                    currentOnStart = null
                    currentOnEnd = null
                }
            }
        })
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            isInitialized = true
            setupLanguage()
            pendingSpeech?.invoke()
            pendingSpeech = null
            Log.i("CahangirTTS", "TTS initialized successfully")
        } else {
            Log.e("CahangirTTS", "TTS initialization failed: $status")
        }
    }

    private fun setupLanguage() {
        val t = tts ?: return

        // 1. Try Azerbaijani (az-AZ)
        val azLocale = Locale.forLanguageTag("az-AZ")
        val azResult = t.isLanguageAvailable(azLocale)
        if (azResult >= TextToSpeech.LANG_AVAILABLE) {
            t.language = azLocale
            Log.i("CahangirTTS", "Using Azerbaijani locale for TTS")
            return
        }

        // 2. Try Turkish (tr-TR) which pronounces Azerbaijani text very accurately
        val trLocale = Locale.forLanguageTag("tr-TR")
        val trResult = t.isLanguageAvailable(trLocale)
        if (trResult >= TextToSpeech.LANG_AVAILABLE) {
            t.language = trLocale
            Log.i("CahangirTTS", "Using Turkish locale fallback for TTS")
            return
        }

        // 3. Fallback to default locale
        t.language = Locale.getDefault()
        Log.i("CahangirTTS", "Using default locale for TTS: ${Locale.getDefault()}")
    }

    fun speak(text: String, onStart: (() -> Unit)? = null, onEnd: (() -> Unit)? = null) {
        if (text.isBlank()) {
            onEnd?.invoke()
            return
        }

        if (!isInitialized) {
            pendingSpeech = {
                speak(text, onStart, onEnd)
            }
            return
        }

        currentOnStart = onStart
        currentOnEnd = onEnd

        val utteranceId = "cg_tts_${System.currentTimeMillis()}"
        val params = Bundle().apply {
            putString(TextToSpeech.Engine.KEY_PARAM_UTTERANCE_ID, utteranceId)
        }

        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, params, utteranceId)
    }

    fun stop() {
        tts?.stop()
        mainHandler.post {
            currentOnEnd?.invoke()
            currentOnStart = null
            currentOnEnd = null
        }
    }

    fun shutdown() {
        try {
            tts?.stop()
            tts?.shutdown()
            tts = null
            isInitialized = false
        } catch (e: Exception) {
            Log.e("CahangirTTS", "Error shutting down TTS", e)
        }
    }
}
