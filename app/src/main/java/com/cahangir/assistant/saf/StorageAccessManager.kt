package com.cahangir.assistant.saf

import android.content.Context
import android.net.Uri
import android.util.Log
import java.io.BufferedReader
import java.io.InputStreamReader

object StorageAccessManager {

    fun exportBackupToUri(context: Context, destinationUri: Uri, jsonContent: String): Boolean {
        return try {
            context.contentResolver.openOutputStream(destinationUri)?.use { outputStream ->
                outputStream.write(jsonContent.toByteArray(Charsets.UTF_8))
                outputStream.flush()
            }
            Log.i("StorageAccess", "Backup exported successfully to SAF URI")
            true
        } catch (e: Exception) {
            Log.e("StorageAccess", "Failed to write backup to SAF URI", e)
            false
        }
    }

    fun importBackupFromUri(context: Context, sourceUri: Uri): String? {
        return try {
            context.contentResolver.openInputStream(sourceUri)?.use { inputStream ->
                BufferedReader(InputStreamReader(inputStream, Charsets.UTF_8)).use { reader ->
                    reader.readText()
                }
            }
        } catch (e: Exception) {
            Log.e("StorageAccess", "Failed to read backup from SAF URI", e)
            null
        }
    }
}
