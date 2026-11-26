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

    @Test fun latencyWindowsPercentilesAndText() {
        val s = TouchStats()
        s.reset(0)
        assertEquals(-1.0, s.downDispatchP50Ms(), 0.0)
        assertTrue(s.text(1000).contains("DOWN→dispatch —"))
        for (i in 1..100) s.downToDispatch.add(i * 100L) // 0,1..10 ms
        s.inputToDispatch.add(500); s.inputToCompleted.add(9000)
        assertEquals(5.0, s.downDispatchP50Ms(), 0.01)
        val w = s.downToDispatch.summary()!!
        assertEquals(5000L, w[0]); assertEquals(9500L, w[1]); assertEquals(10000L, w[2])
        repeat(TouchStats.Window.CAP) { s.downToDispatch.add(1000) } // janela das últimas 512
        assertEquals(1000L, s.downToDispatch.summary()!![2])
        s.profile = "Máxima fluidez"; s.frameMs = 8
        val t = s.text(1000)
        assertTrue(t, t.contains("perfil: Máxima fluidez (quadro 8 ms)"))
        assertTrue(t, t.contains("pacote→fim do gesture 9.0/9.0/9.0 ms (n=1)"))
        s.reset(2000)
        assertEquals(-1.0, s.downDispatchP50Ms(), 0.0)
    }
}
