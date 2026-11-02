package com.cahangir.assistant.stt

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log

class SpeechRecognitionManager(private val context: Context) {

    private val mainHandler = Handler(Looper.getMainLooper())
    private var speechRecognizer: SpeechRecognizer? = null
    private var isListening = false

    private var onReadyCallback: (() -> Unit)? = null
    private var onResultCallback: ((String) -> Unit)? = null
    private var onErrorCallback: ((Int) -> Unit)? = null

    fun isAvailable(): Boolean {
        return SpeechRecognizer.isRecognitionAvailable(context)
    }

    fun startListening(
        onReady: (() -> Unit)? = null,
        onResult: ((String) -> Unit)? = null,
        onError: ((Int) -> Unit)? = null
    ) {
        mainHandler.post {
            if (!isAvailable()) {
                Log.w("CahangirSTT", "Speech recognition is not available on this device")
                onError?.invoke(SpeechRecognizer.ERROR_CLIENT)
                return@post
            }

            stopListening()

            onReadyCallback = onReady
            onResultCallback = onResult
            onErrorCallback = onError

            try {
                speechRecognizer = SpeechRecognizer.createSpeechRecognizer(context).apply {
                    setRecognitionListener(createListener())
                }

                val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE, "az-AZ")
                    putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "az-AZ")
                    putExtra(RecognizerIntent.EXTRA_ONLY_RETURN_LANGUAGE_PREFERENCE, false)
                    putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
                    putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
                    putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false)
                }

                speechRecognizer?.startListening(intent)
                isListening = true
                Log.i("CahangirSTT", "Speech recognition started")
            } catch (e: Exception) {
                Log.e("CahangirSTT", "Error starting speech recognition", e)
                onErrorCallback?.invoke(SpeechRecognizer.ERROR_CLIENT)
                cleanup()
            }
        }
    }

    fun stopListening() {
        mainHandler.post {
            if (isListening) {
                try {
                    speechRecognizer?.stopListening()
                } catch (e: Exception) {
                    Log.w("CahangirSTT", "Error stopping speech recognition", e)
                }
                cleanup()
            }
        }
    }

    private fun cleanup() {
        isListening = false
        try {
            speechRecognizer?.destroy()
        } catch (e: Exception) {
            Log.w("CahangirSTT", "Error destroying speech recognizer", e)
        }
        speechRecognizer = null
    }

    fun destroy() {
        stopListening()
        onReadyCallback = null
        onResultCallback = null
        onErrorCallback = null
    }

    private fun createListener(): RecognitionListener {
        return object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {
                Log.i("CahangirSTT", "onReadyForSpeech")
                mainHandler.post { onReadyCallback?.invoke() }
            }

            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}

            override fun onError(error: Int) {
                Log.w("CahangirSTT", "Speech recognition error: $error")
                mainHandler.post {
                    onErrorCallback?.invoke(error)
                    cleanup()
                }
            }

            override fun onResults(results: Bundle?) {
                val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                val recognizedText = matches?.firstOrNull()?.trim() ?: ""
                Log.i("CahangirSTT", "Speech recognition result: $recognizedText")
                mainHandler.post {
                    if (recognizedText.isNotBlank()) {
                        onResultCallback?.invoke(recognizedText)
                    } else {
                        onErrorCallback?.invoke(SpeechRecognizer.ERROR_NO_MATCH)
                    }
                    cleanup()
                }
            }

            override fun onPartialResults(partialResults: Bundle?) {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        }
    }
}
