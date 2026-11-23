package com.mirror.gamecontrol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TouchStatsTest {
    @Test fun countsGapsRejectionsAndPeaks() {
        val s = TouchStats()
        s.reset(0)
        var t = 0L
        repeat(100) { s.onDispatch(t, 1, false); t += 16 }   // 1 dedo segurado, um gesture a cada 16 ms
        s.onDispatch(t + 300, 2, true)                       // lacuna de 316 ms com dedo segurado + reciclagem
        s.onCancelled(t + 302, t + 300)                      // recusado (2 ms depois do despacho)
        s.onCancelled(t + 400, t + 300)                      // cancelado de verdade (toque na tela)
        s.onIdle(t + 500, 0)                                 // soltou tudo
        s.onDispatch(t + 5000, 1, false)                     // lacuna sem dedo segurado não conta
        assertEquals(102, s.gestures)
        assertEquals(316, s.maxGapMs)
        assertEquals(2, s.cancelled)
        assertEquals(1, s.rejected)
        assertEquals(1, s.recycles)
        assertEquals(2, s.activePeak)
        assertTrue(s.peakPerSecond in 60..64)
        assertTrue(s.text(t + 5000).contains("recusados 1"))
        s.reset(10_000)
        assertEquals(0, s.gestures)
        assertEquals(0, s.maxGapMs)
    }
}
