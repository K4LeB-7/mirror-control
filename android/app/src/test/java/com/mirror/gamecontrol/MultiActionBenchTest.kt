package com.mirror.gamecontrol

import org.junit.Test
import java.io.File

class MultiActionBenchTest {
    @Test fun baselineTable() {
        val lines = ArrayList<String>()
        lines += MultiActionBench.HEADER
        lines += MultiActionBench.SEP
        for (ipc in listOf(1L, 3L)) for (hz in listOf(60, 90, 120)) {
            val r = MultiActionBench({ TouchPlanner(maxStrokes = 10) }, hz = hz, ipcMs = ipc).run()
            lines += MultiActionBench.row("0.3.2 ${hz} Hz ipc=$ipc", r)
        }
        val text = lines.joinToString("\n") + "\n"
        println(text)
        File("build").mkdirs()
        File("build/multiaction-baseline.txt").writeText(text)
    }
}
