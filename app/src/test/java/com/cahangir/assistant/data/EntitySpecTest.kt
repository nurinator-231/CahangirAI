package com.cahangir.assistant.data

import com.cahangir.assistant.data.local.Entities
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** Guards against schema drift between the Android app and the Debian backend. */
class EntitySpecTest {
    @Test fun androidColumnsMatchBackendSpec() {
        val src = listOf("../backend/app/entities.py", "backend/app/entities.py").map { File(it) }.first { it.exists() }.readText()
        val backend = Regex("\"(\\w+)\": EntitySpec\\((.*?)\\n    \\),", RegexOption.DOT_MATCHES_ALL).findAll(src).associate { m ->
            m.groupValues[1] to Regex("\"(\\w+)\": F\\(").findAll(m.groupValues[2]).map { it.groupValues[1] }.toList()
        }
        assertEquals(backend.keys, Entities.NAMES.toSet())
        for (spec in Entities.ALL) assertEquals("columns of ${spec.name}", backend[spec.name], spec.cols.map { it.name })
    }
}
