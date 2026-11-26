package com.mirror.gamecontrol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Perfil de vídeo, relógio do PTS, agregação do vstat, plano do flash e política do FrameQueue (app 0.3.4). */
class VideoProfileTest {
    // ------------------------------------------------------------------ modos e constantes
    @Test fun modeParsing() {
        assertEquals(VideoMode.LOWLAT, VideoMode.fromWire("lowlat"))
        assertEquals(VideoMode.LEGACY, VideoMode.fromWire("legacy"))
        assertNull(VideoMode.fromWire("turbo"))
        assertNull(VideoMode.fromWire(""))
        assertNull(VideoMode.fromWire(null))
    }

    @Test fun legacyKeepsTheExact033Behavior() {
        // O modo "Padrão (0.3.3)" = A/B do aparelho: GOP 1 s, bitrate de sempre, fila 8 quadros / 4 MiB.
        assertEquals(1, VideoTuning.gopSeconds(VideoMode.LEGACY))
        assertEquals(8_000_000, VideoTuning.bitrate(VideoMode.LEGACY, 720, 60))
        assertEquals(16_000_000, VideoTuning.bitrate(VideoMode.LEGACY, 1080, 60))
        assertEquals(8, VideoTuning.queueFrames(VideoMode.LEGACY))
        assertEquals(4 * 1024 * 1024, VideoTuning.queueBytes(VideoMode.LEGACY))
        assertEquals(ScreenEncoder.bitrateFor(1080, 30), VideoTuning.bitrate(VideoMode.LEGACY, 1080, 30))
    }

    @Test fun lowLatencyIsLeaner() {
        assertEquals(4, VideoTuning.gopSeconds(VideoMode.LOWLAT))
        assertEquals(6_000_000, VideoTuning.bitrate(VideoMode.LOWLAT, 720, 60)) // 75 % de 8 Mbps
        assertEquals(12_000_000, VideoTuning.bitrate(VideoMode.LOWLAT, 1080, 60))
        assertEquals(3_000_000, VideoTuning.bitrate(VideoMode.LOWLAT, 720, 30))
        assertTrue(VideoTuning.queueFrames(VideoMode.LOWLAT) < VideoTuning.queueFrames(VideoMode.LEGACY))
        assertTrue(VideoTuning.queueBytes(VideoMode.LOWLAT) < VideoTuning.queueBytes(VideoMode.LEGACY))
        // A seleção do usuário (720/1080, 30/60) continua valendo: o bitrate acompanha, só a resolução/fps não mudam aqui.
        assertEquals(ScreenEncoder.Params(1280, 576, 60, 1, VideoMode.LEGACY).copy(mode = VideoMode.LOWLAT).mode, VideoMode.LOWLAT)
    }

    // ------------------------------------------------------------------ relógio do PTS
    private class Clk(var mono: Long, var boot: Long) {
        val c = PtsClock({ mono }, { boot })
    }

    @Test fun clockAdoptsMonotonicWhenPtsIsMonotonic() {
        val k = Clk(mono = 10_000_000, boot = 90_000_000) // o aparelho dormiu: boot > mono
        k.c.observe(9_990_000) // pts 10 ms atrás na base MONOTONIC
        assertEquals(PtsClock.Base.MONO, k.c.base)
        assertTrue(k.c.trusted)
        assertEquals(10_000_000, k.c.nowUs())
        assertEquals(1234, k.c.fromMono(1234))
        k.c.observe(1) // depois de confirmada, não reavalia
        assertEquals(PtsClock.Base.MONO, k.c.base)
    }

    @Test fun clockAdoptsBoottimeWhenPtsIsBoottime() {
        val k = Clk(mono = 10_000_000, boot = 900_000_000)
        k.c.observe(899_980_000) // 20 ms atrás na BOOTTIME; 890 s "no futuro" na MONOTONIC
        assertEquals(PtsClock.Base.BOOT, k.c.base)
        assertEquals(900_000_000, k.c.nowUs())
        assertEquals(1_000_000 + 890_000_000, k.c.fromMono(1_000_000)) // Choreographer (mono) → base do PTS
    }

    @Test fun clockStaysUntrustedWhenPtsIsRelative() {
        val k = Clk(mono = 50_000_000_000, boot = 60_000_000_000)
        k.c.observe(0) // encoder normalizou o PTS para começar em 0
        assertEquals(PtsClock.Base.UNKNOWN, k.c.base)
        assertFalse(k.c.trusted)
        assertEquals(50_000_000_000, k.c.nowUs()) // pm continua na MONOTONIC
        k.c.observe(49_999_990_000) // um quadro plausível depois resolve
        assertEquals(PtsClock.Base.MONO, k.c.base)
        k.c.reset()
        assertFalse(k.c.trusted)
    }

    @Test fun plausibleWindow() {
        assertTrue(PtsClock.plausible(0))
        assertTrue(PtsClock.plausible(-49_000))
        assertFalse(PtsClock.plausible(-51_000))
        assertTrue(PtsClock.plausible(4_999_000))
        assertFalse(PtsClock.plausible(5_100_000))
    }

    // ------------------------------------------------------------------ vstat
    @Test fun percentilesMatchTheSiteDefinition() {
        // mesma definição do web (videoStats.ts): p50 = s[(n-1)/2], p95 = s[(n-1)*95/100]
        val v = LongArray(20) { (it + 1) * 1000L } // 1..20 ms
        val p = VideoStats.pct(v, 20)!!
        assertEquals(10.0, p.p50, 1e-9)
        assertEquals(19.0, p.p95, 1e-9)
        assertEquals(20.0, p.max, 1e-9)
        assertNull(VideoStats.pct(v, 0))
        val one = VideoStats.pct(longArrayOf(7_500), 1)!!
        assertEquals(7.5, one.p50, 1e-9)
        assertEquals(7.5, one.max, 1e-9)
    }

    @Test fun aggregationFpsKbpsKeyMax() {
        val st = VideoStats()
        st.snapshot(1_000) // abre o primeiro intervalo
        for (i in 0 until 60) st.onFrame(8_000L + i * 100, if (i == 0) 150_000 else 15_000, i == 0)
        for (i in 0 until 60) st.onQueueWaitUs(200L)
        st.onWriteUs(900)
        val s = st.snapshot(2_000)
        assertEquals(60, s.frames)
        assertEquals(1, s.keys)
        assertEquals(60.0, s.fps, 1e-9)
        assertEquals((150_000.0 + 59 * 15_000) * 8 / 1000.0, s.kbps, 1e-6) // 8,1 Mbps → kbit/s
        assertEquals(150_000 / 1024.0, s.keyMaxKB, 1e-9)
        assertEquals(8.0 + 29 * 0.1, s.enc!!.p50, 1e-9)
        assertEquals(0.2, s.q!!.p50, 1e-9)
        assertEquals(0.9, s.w!!.max, 1e-9)
        // intervalo seguinte: acumuladores zerados, keyMax continua
        val t = st.snapshot(3_000)
        assertEquals(0, t.frames)
        assertNull(t.enc)
        assertEquals(0.0, t.fps, 1e-9)
        assertEquals(150_000 / 1024.0, t.keyMaxKB, 1e-9)
        st.reset()
        assertEquals(0.0, st.snapshot(4_000).keyMaxKB, 1e-9)
    }

    @Test fun unknownEncIsSkipped() {
        val st = VideoStats()
        st.snapshot(0)
        st.onFrame(-1, 1000, false)
        st.onFrame(5_000, 1000, false)
        val s = st.snapshot(1_000)
        assertEquals(2, s.frames)
        assertEquals(5.0, s.enc!!.p50, 1e-9)
    }

    @Test fun vstatJsonShape() {
        val st = VideoStats()
        st.snapshot(0)
        st.onFrame(12_345, 20_000, true)
        val s = st.snapshot(1_000)
        val m = VideoStats.Companion.Meta(7, VideoMode.LOWLAT, 3, "mono", 1280, 576, 60, 6_000_000, 4, 3, 1, 2, "tier3 \"IllegalArg\\x\": bad\nkey", "0.3.4")
        val j = VideoStats.vstatJson(s, m, true)
        assertTrue(j, j.startsWith("{\"type\":\"vstat\",\"seq\":7,\"enc\":{\"p50\":12.3,\"p95\":12.3,\"max\":12.3},"))
        assertTrue(j.contains("\"fps\":1.0"))
        assertTrue(j.contains("\"queueDrops\":3,\"queueOverflows\":1,\"queuePeak\":2"))
        assertTrue(j.contains("\"clk\":\"mono\",\"mode\":\"lowlat\",\"tier\":3"))
        assertTrue(j.contains("\"vw\":1280,\"vh\":576,\"capFps\":60,\"targetKbps\":6000,\"gop\":4"))
        assertFalse("aspas/barras/quebras do motivo não podem quebrar o JSON", j.contains("\\x") || j.contains("\n"))
        assertTrue(j, j.endsWith("\"n\":1,\"ver\":\"0.3.4\"}"))
        assertEquals(0, j.count { it == '\n' })
        assertEquals(j.count { it == '{' }, j.count { it == '}' })
        // relógio do PTS não confirmado: "enc" nulo (o site mostra "—")
        val u = VideoStats.vstatJson(s, m, false)
        assertTrue(u.contains("\"enc\":null"))
        assertTrue(u.contains("\"q\":null"))
    }

    // ------------------------------------------------------------------ flash
    @Test fun flashPlanTimeline() {
        val p = FlashPlan()
        val steps = p.steps()
        assertEquals(1 + 2 * 5, steps.size)
        assertEquals(0L, steps[0].atMs); assertFalse(steps[0].white); assertEquals(0, steps[0].n)
        assertEquals(300L, steps[1].atMs); assertTrue(steps[1].white); assertEquals(1, steps[1].n)
        assertEquals(600L, steps[2].atMs); assertFalse(steps[2].white); assertEquals(1, steps[2].n)
        assertEquals(900L, steps[3].atMs); assertTrue(steps[3].white); assertEquals(2, steps[3].n)
        assertEquals(5, steps.count { it.white })
        assertEquals((1..5).toList(), steps.filter { it.white }.map { it.n })
        assertEquals(steps.last().atMs, p.totalMs)
        assertEquals(3000L, p.totalMs) // 300 (antes) + 4 × 600 + 300 (último branco)
        // sempre alterna: nunca dois brancos seguidos
        assertTrue(steps.zipWithNext().all { (a, b) -> a.white != b.white })
        assertTrue(steps.zipWithNext().all { (a, b) -> b.atMs > a.atMs })
    }

    @Test fun flashSquareSize() {
        assertEquals(108, FlashPlan.squareSidePx(1080))
        assertEquals(72, FlashPlan.squareSidePx(720))
        assertEquals(48, FlashPlan.squareSidePx(200)) // mínimo
    }

    @Test fun flashJson() {
        assertEquals("{\"type\":\"flashAck\",\"n\":3,\"pm\":123456,\"pm0\":115000,\"vs\":8333}", FlashPlan.ackJson(3, 123456, 115000, 8333))
        assertEquals("{\"type\":\"flashAck\",\"n\":0,\"end\":1,\"pulses\":5}", FlashPlan.endJson(5))
        val f = FlashPlan.failJson("sem \"acessibilidade\"\n e \\ barra")
        assertEquals("{\"type\":\"status\",\"scope\":\"flash\",\"ok\":false,\"text\":\"sem acessibilidade e  barra\"}", f)
    }

    // ------------------------------------------------------------------ pong com pm
    @Test fun pongCarriesPhoneClock() {
        val withPm = InputCtrl.pong(1234.567, 42, 2.5, FluidityProfile.SMOOTH, 987_654_321L)
        assertEquals("{\"type\":\"pong\",\"t\":1234.567,\"p\":42,\"d\":2.5,\"profile\":\"smooth\",\"pm\":987654321}", withPm)
        // sem relógio: idêntico ao pong da 0.3.3 (sem "pm")
        assertEquals("{\"type\":\"pong\",\"t\":1234.567,\"p\":42,\"d\":2.5,\"profile\":\"smooth\"}",
            InputCtrl.pong(1234.567, 42, 2.5, FluidityProfile.SMOOTH))
    }

    // ------------------------------------------------------------------ política do FrameQueue
    private fun key(size: Int = 10) = FrameQueue.Item(UsbWire.VIDEO_KEY, ByteArray(size))
    private fun delta(size: Int = 10) = FrameQueue.Item(UsbWire.VIDEO_DELTA, ByteArray(size))

    @Test fun lowLatencyQueueDropsEarlierAndRequestsKey() {
        val q = FrameQueue(VideoTuning.queueFrames(VideoMode.LOWLAT), VideoTuning.queueBytes(VideoMode.LOWLAT))
        assertFalse(q.offer(key()))
        repeat(3) { assertFalse(q.offer(delta())) } // 4 quadros esperando: no limite
        assertEquals(0L, q.overflows)
        assertTrue("5º quadro: a fila curta descarta em vez de acumular atraso", q.offer(delta()))
        assertEquals(1L, q.overflows)
        assertTrue(q.waitingKey)
        assertEquals(listOf(UsbWire.VIDEO_KEY), q.types())
        // o mesmo cenário no legado ainda cabe (8 quadros)
        val old = FrameQueue(VideoTuning.queueFrames(VideoMode.LEGACY), VideoTuning.queueBytes(VideoMode.LEGACY))
        old.offer(key())
        repeat(4) { assertFalse(old.offer(delta())) }
        assertEquals(0L, old.overflows)
    }

    @Test fun limitsCanChangeAtRuntimeAndSupersededFramesAreNotOverflows() {
        val q = FrameQueue(8, 4 * 1024 * 1024)
        q.offer(key()); repeat(3) { q.offer(delta()) }
        q.maxFrames = 3 // troca para baixa latência com a fila em uso
        assertTrue(q.offer(delta()))
        assertEquals(1L, q.overflows)
        val dropsBefore = q.dropped
        assertFalse(q.offer(key())) // IDR novo substitui o que estava: conta em `dropped`, não em `overflows`
        assertEquals(1L, q.overflows)
        assertTrue(q.dropped >= dropsBefore)
    }

    @Test fun peakAndTimestamp() {
        val q = FrameQueue()
        q.offer(key()); q.offer(delta()); q.offer(delta())
        assertEquals(3, q.takePeak())
        q.take(0); q.take(0); q.take(0)
        assertEquals(0, q.takePeak())
        val it = FrameQueue.Item(UsbWire.VIDEO_DELTA, ByteArray(1), 12345L)
        assertEquals(12345L, it.tNs)
        assertEquals(0L, FrameQueue.Item(UsbWire.CTRL, ByteArray(1)).tNs)
        assertNotNull(q)
    }

    // ------------------------------------------------------------------ revisão 0.3.4
    @Test fun clockObserveReturnsAgeAndIsNotForgottenByEncoderRestarts() {
        val k = Clk(mono = 10_000_000, boot = 90_000_000)
        assertEquals(-1L, k.c.trustedNowUs()) // sem base confirmada: pong/flashAck sem pm
        assertEquals(12_000L, k.c.observe(9_988_000))
        assertEquals(10_000_000L, k.c.trustedNowUs())
        // o encoder reinicia (girar/perfil): o servidor NÃO zera mais o relógio; quadros do encoder novo continuam na base
        k.mono += 500_000; k.boot += 500_000
        assertEquals(8_000L, k.c.observe(10_492_000))
        assertEquals(PtsClock.Base.MONO, k.c.base)
    }

    @Test fun clockPrefersMonotonicWhenBothBasesArePlausible() {
        // aparelho que quase não dormiu desde o boot: boot − mono = 2 s → as duas bases "plausíveis"; vale a do AOSP
        val k = Clk(mono = 100_000_000, boot = 102_000_000)
        assertEquals(10_000L, k.c.observe(99_990_000))
        assertEquals(PtsClock.Base.MONO, k.c.base)
    }

    @Test fun clockDropsTheBaseAfterManyConsecutiveImplausibleFrames() {
        val k = Clk(mono = 10_000_000, boot = 90_000_000)
        k.c.observe(9_990_000)
        repeat(PtsClock.MAX_VIOLATIONS - 1) { assertEquals(-1L, k.c.observe(0)) }
        assertTrue("um punhado de quadros estranhos não derruba a base", k.c.trusted)
        assertEquals(10_000L, k.c.observe(9_990_000)) // um quadro bom zera a contagem
        repeat(PtsClock.MAX_VIOLATIONS) { k.c.observe(0) } // encoder passou a normalizar o PTS
        assertFalse(k.c.trusted)
        assertEquals(-1L, k.c.trustedNowUs())
    }

    @Test fun pongCarriesQueueHoldTimeOnlyWithClock() {
        assertEquals("{\"type\":\"pong\",\"t\":1.000,\"p\":40,\"d\":-1.0,\"profile\":\"balanced\",\"pm\":5000,\"pq\":2500}",
            InputCtrl.pong(1.0, 40, -1.0, FluidityProfile.BALANCED, 5000, 2500))
        // sem relógio confirmado: nem pm nem pq (idêntico à 0.3.3)
        assertEquals("{\"type\":\"pong\",\"t\":1.000,\"p\":40,\"d\":-1.0,\"profile\":\"balanced\"}",
            InputCtrl.pong(1.0, 40, -1.0, FluidityProfile.BALANCED, -1, 2500))
    }

    @Test fun rateGateLimitsSpam() {
        var now = 1_000L
        val g = RateGate(100) { now }
        assertTrue(g.tryAcquire())
        assertFalse(g.tryAcquire())
        now += 99; assertFalse(g.tryAcquire())
        now += 1; assertTrue(g.tryAcquire())
        var accepted = 0
        repeat(1000) { now += 1; if (g.tryAcquire()) accepted++ } // 1000 pedidos em 1 s → 10 aceitos
        assertEquals(10, accepted)
        g.reset(); assertTrue(g.tryAcquire())
        // flash: um teste por vez (o plano dura ~3,5 s)
        assertTrue(FlashPlan().totalMs + 700 >= 3_500)
    }

    @Test fun lateCtrlIsBuiltByTheWriterAndNeverDropped() {
        val q = FrameQueue(VideoTuning.queueFrames(VideoMode.LOWLAT), VideoTuning.queueBytes(VideoMode.LOWLAT))
        var built = 0
        q.offer(key())
        repeat(3) { q.offer(delta()) }
        q.offer(FrameQueue.Item(UsbWire.CTRL, ByteArray(0), 0L) { built++; byteArrayOf(1, 2, 3) })
        assertTrue(q.offer(delta())) // estouro: descarta deltas, nunca o CTRL
        assertEquals(listOf(UsbWire.VIDEO_KEY, UsbWire.CTRL), q.types())
        assertEquals(0, built) // só monta quando a thread de escrita o pegar
        q.take(0)
        val late = q.take(0)!!
        assertEquals(listOf<Byte>(1, 2, 3), late.late!!().toList())
        assertEquals(1, built)
    }
}
