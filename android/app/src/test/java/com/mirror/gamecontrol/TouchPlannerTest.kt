package com.mirror.gamecontrol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.random.Random

/**
 * Testes do planejador de toques. [FakeAndroid] imita as regras do MotionEventInjector do Android que importam aqui:
 * um gesture em voo por vez; um gesture que continua strokes tem de continuar TODOS os abertos, começando no ponto
 * exato em que pararam; strokes novos num gesture de continuação não podem estar no 1º passo (t=0); um ponteiro só
 * levanta quando um segmento com willContinue=false termina.
 */
class TouchPlannerTest {

    /** Android falso: valida cada gesture e registra quanto tempo cada toque ficou pressionado. */
    class FakeAndroid {
        val open = HashMap<Int, Pair<Int, Int>>() // strokes abertos após o último gesture completado
        val violations = ArrayList<String>()
        val pressStart = HashMap<Int, Long>()
        /** (ponteiro, duração pressionado em ms) de cada toque que levantou. */
        val taps = ArrayList<Pair<Int, Long>>()
        var dispatched = 0
        private var pending: TouchPlanner.Gesture? = null
        private var at = 0L

        fun dispatch(g: TouchPlanner.Gesture, now: Long) {
            dispatched++
            pending = g
            at = now
            val cont = g.segments.filter { it.continues }
            if (open.isNotEmpty() || cont.isNotEmpty()) {
                if (cont.map { it.pointer }.toSet() != open.keys) violations += "t=$now continua ${cont.map { it.pointer }} mas abertos ${open.keys}: $g"
                for (s in cont) {
                    val o = open[s.pointer]
                    if (o == null || o.first != s.fromX || o.second != s.fromY) violations += "t=$now ponto não bate p=${s.pointer} $o vs (${s.fromX},${s.fromY})"
                    if (s.startMs != 0L) violations += "t=$now continuação deve começar em 0: $s"
                }
                for (s in g.segments.filter { !it.continues }) if (s.startMs < 1) violations += "t=$now stroke novo no 1º passo de uma continuação: $s"
            }
            if (g.segments.map { it.pointer }.toSet().size != g.segments.size) violations += "t=$now ponteiro repetido: $g"
            for (s in g.segments) {
                if (s.durationMs <= 0 || s.startMs < 0) violations += "t=$now duração/início inválido: $s"
                if (minOf(s.fromX, s.fromY, s.toX, s.toY) < 0) violations += "t=$now coordenada negativa: $s"
                if (!s.continues) pressStart[s.pointer] = now + s.startMs
            }
        }

        fun complete() {
            val g = pending ?: return
            pending = null
            for (s in g.segments) {
                if (s.willContinue) open[s.pointer] = s.toX to s.toY
                else {
                    open.remove(s.pointer)
                    taps += s.pointer to (at + s.startMs + s.durationMs - (pressStart.remove(s.pointer) ?: 0))
                }
            }
        }

        fun cancel() {
            pending = null
            open.clear()
            pressStart.clear()
        }

        /** Ponteiros que o Android considera pressionados. */
        val down: Set<Int> get() = open.keys + (pending?.segments?.map { it.pointer } ?: emptyList())
    }

    /** Relógio + laço do injetor (pump depois de cada evento/conclusão, acordar no wakeAt). */
    class Sim(val p: TouchPlanner = TouchPlanner(maxStrokes = 20)) {
        var now = 0L
        val android = FakeAndroid()
        var flightEnd = -1L
        var cancelNext = false

        init { p.setBounds(1079, 2399) }

        fun pump() {
            if (p.inFlight) return
            val g = p.plan(now) ?: return
            android.dispatch(g, now)
            flightEnd = now + g.durationMs
        }

        fun advance(ms: Long) {
            repeat(ms.toInt()) {
                now++
                if (p.inFlight && now >= flightEnd) {
                    if (cancelNext) {
                        cancelNext = false
                        android.cancel()
                        p.cancelled(now)
                    } else {
                        android.complete()
                        p.completed(now)
                    }
                    pump() // como o injetor: depois de cada conclusão
                }
                if (!p.inFlight && p.wakeAt(now) <= now) pump()
            }
        }

        fun down(id: Int, x: Float = 100f, y: Float = 200f, gen: Int = 0) { p.down(id, x, y, now, gen); pump() }
        fun move(id: Int, x: Float, y: Float) { p.move(id, x, y, now); pump() }
        fun up(id: Int, gen: Int = 0) { p.up(id, now, gen); pump() }
        fun releaseAll() { p.releaseAll(); pump() }

        fun drain(ms: Long = 2000) = advance(ms)
    }

    private fun Sim.assertClean() {
        assertEquals("violações: ${android.violations}", emptyList<String>(), android.violations)
    }

    // ------------------------------------------------------------------ o bug "clique vira segurar"

    @Test fun upDuringInFlightGestureStillSendsFinalSegment() {
        val s = Sim()
        s.down(1)
        assertTrue("1º segmento em voo", s.p.inFlight)
        s.advance(5)
        s.up(1) // chega com o gesture em voo
        assertTrue(s.p.isActive(1))
        s.advance(20) // o 1º segmento completou: o dedo NÃO pode sair sem o final
        s.drain()
        assertTrue("dedo levantou no Android", 1 !in s.android.down)
        assertFalse(s.p.isActive(1))
        assertEquals(1, s.android.taps.size)
        s.assertClean()
    }

    /** Réplica fiel da lógica antiga do TouchInjector (0.3.0): prova o bug e mede o laço contínuo. */
    class LegacyModel {
        class F(var releasing: Boolean = false, var hasStroke: Boolean = false)
        val fingers = HashMap<Int, F>()
        var inFlight = false
        val lastCont = HashMap<Int, Boolean>() // último willContinue despachado por dedo
        var gestures = 0
        fun down(id: Int) { val e = fingers[id]; if (e != null && !e.releasing) return; fingers[id] = F(); pump() }
        fun up(id: Int) { fingers[id]?.releasing = true; pump() }
        fun pump() {
            if (inFlight || fingers.isEmpty()) return
            for ((id, f) in fingers) { lastCont[id] = !f.releasing; f.hasStroke = true }
            inFlight = true
            gestures++
        }
        fun completed() {
            inFlight = false
            fingers.entries.removeIf { it.value.releasing } // remove SEM ter mandado willContinue=false
            pump()
        }
    }

    @Test fun legacyLogicLeftThePointerDown() {
        val m = LegacyModel()
        m.down(1)           // segmento 1: willContinue=true, em voo
        m.up(1)             // UP com o gesture em voo
        m.completed()       // dedo removido
        assertTrue("o último segmento despachado continuava (dedo preso no Android)", m.lastCont[1] == true)
        assertTrue(m.fingers.isEmpty())
    }

    @Test fun shortClickLastsAtLeastMinTapAndNeverSticks() {
        for (gap in listOf(0L, 1L, 5L, 15L, 16L, 17L, 30L, 49L, 50L, 80L)) {
            val s = Sim()
            s.down(2)
            s.advance(gap)
            s.up(2)
            s.drain()
            assertEquals("gap=$gap", 1, s.android.taps.size)
            val held = s.android.taps[0].second
            assertTrue("gap=$gap: toque de $held ms < mínimo", held >= s.p.cfg.minTapMs)
            assertTrue("gap=$gap: toque de $held ms longo demais", held <= maxOf(gap, s.p.cfg.minTapMs) + 2 * s.p.cfg.segmentMs)
            assertTrue(s.android.down.isEmpty())
            s.assertClean()
        }
    }

    @Test fun downAndUpBeforeFirstDispatchBecomeOneStroke() {
        val p = TouchPlanner()
        p.setBounds(1000, 1000)
        p.down(3, 10f, 10f, 0)
        p.up(3, 0)
        val g = p.plan(0)!!
        assertEquals(1, g.segments.size)
        val seg = g.segments[0]
        assertFalse(seg.willContinue)
        assertFalse(seg.continues)
        assertEquals(p.cfg.minTapMs, seg.durationMs)
    }

    @Test fun fastDownUpDownIsNotSwallowedNorInheritsOldStroke() {
        val s = Sim()
        s.down(1, 100f, 100f)
        s.advance(3)
        s.up(1)
        s.advance(2)
        s.down(1, 300f, 300f) // novo toque enquanto o anterior ainda termina
        assertEquals(2, s.p.queued(1))
        s.advance(4)
        s.up(1)
        s.advance(3)
        s.down(1, 500f, 500f)
        s.drain(400)
        assertEquals("dois toques completos", 2, s.android.taps.size)
        assertTrue("o 3º DOWN continua segurado", s.p.isHeld(1))
        assertTrue(1 in s.android.down)
        s.up(1)
        s.drain()
        assertEquals(3, s.android.taps.size)
        assertTrue(s.android.down.isEmpty())
        s.assertClean()
    }

    @Test fun holdingKeepsPointerDownWithoutGestureStorm() {
        val s = Sim()
        s.down(0)
        s.drain(5000)
        assertTrue(0 in s.android.down)
        // parado: 1 gesture inicial + renovação a cada 250 ms (o laço antigo fazia ~60/s)
        assertTrue("gestures=${s.android.dispatched}", s.android.dispatched in 15..25)
        s.up(0)
        s.drain()
        assertTrue(s.android.down.isEmpty())
        s.assertClean()
    }

    @Test fun moveIsDispatchedImmediatelyWhenIdle() {
        val s = Sim()
        s.down(0, 100f, 100f)
        s.drain(100)
        val before = s.android.dispatched
        s.move(0, 150f, 100f)
        assertEquals("MOVE com nada em voo sai na hora", before + 1, s.android.dispatched)
        // MOVEs durante o voo coalescem: só o último ponto vai no próximo segmento
        s.move(0, 160f, 100f)
        s.move(0, 170f, 100f)
        s.move(0, 180f, 100f)
        s.advance(40)
        assertEquals("um segmento só para os 3 MOVEs", before + 2, s.android.dispatched)
        assertEquals(180 to 100, s.android.open[0])
        s.releaseAll(); s.drain(); s.assertClean()
    }

    // ------------------------------------------------------------------ cancelamento

    @Test fun cancelWhileHeldRestartsAsNewTouch() {
        val s = Sim()
        s.down(0)
        s.drain(100)
        s.p.move(0, 300f, 300f, s.now)
        s.cancelNext = true
        s.pump()
        s.advance(20)
        s.drain(300)
        assertTrue("recomeçou", 0 in s.android.down)
        s.up(0); s.drain()
        assertTrue(s.android.down.isEmpty())
        s.assertClean()
    }

    @Test fun cancelWithPendingUpEndsTheTouch() {
        val s = Sim()
        s.down(4)
        s.advance(2)
        s.up(4)
        s.cancelNext = true // o 1º segmento é cancelado pelo sistema
        s.drain()
        assertFalse(s.p.isActive(4))
        assertTrue(s.android.down.isEmpty())
        assertNull(s.p.plan(s.now))
        s.assertClean()
    }

    @Test fun cancelDuringFinalSegmentEndsTheTouch() {
        val s = Sim()
        s.down(4)
        s.advance(20)
        s.up(4) // final em voo
        assertTrue(s.p.inFlight)
        s.cancelNext = true
        s.drain()
        assertFalse(s.p.isActive(4))
        assertTrue(s.android.down.isEmpty())
        s.assertClean()
    }

    @Test fun repeatedCancelsBackOff() {
        val p = TouchPlanner()
        p.setBounds(100, 100)
        p.down(0, 1f, 1f, 0)
        var t = 0L
        var n = 0
        repeat(6) {
            val g = p.plan(t)
            if (g != null) { n++; p.cancelled(t) }
            t += 10
        }
        assertTrue("recuo depois de cancelamentos seguidos: $n", n < 6)
        assertTrue(p.wakeAt(t) >= t)
    }

    // ------------------------------------------------------------------ RELEASE_ALL e muitos dedos

    @Test fun releaseAllSendsFinalSegmentsForEveryFinger() {
        val s = Sim()
        for (id in 0..7) { s.down(id, 50f * id + 10, 500f); s.advance(3) }
        s.drain(200)
        assertEquals((0..7).toSet(), s.android.down)
        s.releaseAll()
        s.drain()
        assertTrue(s.android.down.isEmpty())
        assertEquals(8, s.android.taps.size)
        assertEquals(0, s.p.activeCount)
        s.assertClean()
    }

    @Test fun releaseAllDropsTouchesThatNeverStarted() {
        val p = TouchPlanner()
        p.setBounds(100, 100)
        p.down(1, 1f, 1f, 0)
        p.releaseAll()
        assertNull(p.plan(0))
        assertEquals(0, p.activeCount)
    }

    @Test fun tenFingersAndNewOnesJoinOneMsLater() {
        val s = Sim()
        s.down(0)
        s.drain(50)
        for (id in 1..9) { s.down(id, 30f * id, 30f * id); s.advance(5) }
        s.drain(300)
        assertEquals((0..9).toSet(), s.android.down)
        for (id in 0..9) { s.up(id); s.advance(2) }
        s.drain()
        assertTrue(s.android.down.isEmpty())
        s.assertClean()
    }

    @Test fun strokeLimitNeverDropsAnOpenStroke() {
        val s = Sim(TouchPlanner(maxStrokes = 3))
        for (id in 0..5) s.down(id, 10f * id, 10f)
        s.drain(500)
        assertEquals("só 3 cabem", 3, s.android.down.size)
        for (id in 0..5) s.up(id)
        s.drain(2000)
        assertTrue(s.android.down.isEmpty())
        assertEquals(6, s.android.taps.size)
        s.assertClean()
    }

    // ------------------------------------------------------------------ câmera

    @Test fun lookRestartsAtAnchorAfterLeavingZoneAndClampsToScreen() {
        val s = Sim()
        val zone = 200f
        s.p.look(9, 10f, 10f, -50f, -50f, zone, s.now) // vai para fora da tela: preso em 0
        s.pump()
        repeat(30) { s.p.look(9, 10f, 10f, 15f, 15f, zone, s.now); s.pump(); s.advance(16) }
        s.drain(200)
        assertTrue("levantou e recomeçou pelo menos uma vez", s.android.taps.any { it.first == 9 })
        s.up(9); s.drain()
        assertTrue(s.android.down.isEmpty())
        s.assertClean()
    }

    // ------------------------------------------------------------------ gerações, redundância e deadman

    @Test fun duplicateAndLateEdgesAreIgnored() {
        val s = Sim()
        s.down(1, gen = 5)
        s.down(1, gen = 5) // duplicata
        s.advance(30)
        s.up(1, gen = 5)
        s.up(1, gen = 5)   // duplicata
        s.down(1, gen = 5) // duplicata atrasada do DOWN (canal não ordenado)
        s.drain()
        assertEquals(1, s.android.taps.size)
        assertFalse(s.p.isActive(1))
        s.down(1, gen = 3) // DOWN velho
        assertFalse(s.p.isActive(1))
        s.down(1, gen = 6)
        s.up(1, gen = 4)   // UP velho não solta o toque novo
        assertTrue(s.p.isHeld(1))
        s.up(1, gen = 6); s.drain()
        assertEquals(2, s.android.taps.size)
        s.assertClean()
    }

    @Test fun lostUpIsFixedByNextDownWithNewGeneration() {
        val s = Sim()
        s.down(2, gen = 1)
        s.drain(100)
        // UP(1) perdido; o usuário aperta de novo
        s.down(2, gen = 2)
        s.drain(100)
        assertEquals("o toque anterior levantou antes do novo", 1, s.android.taps.size)
        assertTrue(s.p.isHeld(2))
        s.up(2, gen = 2); s.drain()
        assertTrue(s.android.down.isEmpty())
        s.assertClean()
    }

    @Test fun deadmanReleasesUnrefreshedTouchButKeepaliveKeepsItHeld() {
        val s = Sim()
        s.p.setDeadman(500)
        s.down(0, gen = 1)
        s.down(3, gen = 2)
        // ponteiro 0 recebe keepalive a cada 100 ms; o UP do ponteiro 3 "se perdeu"
        repeat(30) { s.down(0, gen = 1); s.advance(100) }
        assertTrue("segurado 3 s com keepalive", s.p.isHeld(0) && 0 in s.android.down)
        assertFalse("sem keepalive, soltou sozinho", s.p.isActive(3))
        assertFalse(3 in s.android.down)
        // keepalive depois do deadman (rede engasgou) volta a pressionar
        s.advance(700)
        assertFalse(s.p.isActive(0))
        s.down(0, gen = 1)
        s.drain(50)
        assertTrue(s.p.isHeld(0))
        s.up(0, gen = 1); s.drain()
        assertTrue(s.android.down.isEmpty())
        s.assertClean()
    }

    @Test fun moveRefreshesDeadmanAndLegacyTouchesIgnoreIt() {
        val s = Sim()
        s.p.setDeadman(300)
        s.down(0, gen = 1)
        repeat(10) { s.move(0, 100f + it, 200f); s.advance(100) }
        assertTrue(s.p.isHeld(0))
        s.down(5) // site antigo (gen 0): sem deadman
        s.advance(2000)
        assertTrue(s.p.isHeld(5))
        assertFalse(s.p.isHeld(0))
        s.releaseAll(); s.drain(); s.assertClean()
    }

    @Test fun afterReleaseAllADuplicateDownDoesNotPressAgain() {
        val s = Sim()
        s.down(1, gen = 9)
        s.drain(50)
        s.releaseAll()
        s.down(1, gen = 9) // cópia redundante atrasada
        s.drain()
        assertFalse(s.p.isActive(1))
        s.down(1, gen = 10)
        assertTrue(s.p.isHeld(1))
        s.releaseAll(); s.drain(); s.assertClean()
    }

    @Test fun resetSessionForgetsGenerations() {
        val p = TouchPlanner()
        p.down(1, 1f, 1f, 0, gen = 50)
        p.up(1, 0, gen = 50)
        p.resetSession()
        p.down(1, 1f, 1f, 0, gen = 1) // site recarregado recomeça em 1
        assertTrue(p.isHeld(1))
    }

    // ------------------------------------------------------------------ fuzz

    @Test fun randomSequencesNeverViolateAndNeverLeaveAPointerDown() {
        val rnd = Random(1234)
        repeat(300) { round ->
            val s = Sim()
            if (rnd.nextBoolean()) s.p.setDeadman(400)
            val gens = IntArray(10)
            var gen = 0
            repeat(rnd.nextInt(20, 120)) {
                val id = rnd.nextInt(0, 10)
                val useGen = round % 2 == 0
                when (rnd.nextInt(10)) {
                    0, 1, 2 -> { if (useGen) gens[id] = ++gen; s.down(id, rnd.nextInt(0, 1080).toFloat(), rnd.nextInt(0, 2400).toFloat(), if (useGen) gens[id] else 0) }
                    3, 4 -> s.move(id, rnd.nextInt(-50, 1200).toFloat(), rnd.nextInt(-50, 2500).toFloat())
                    5, 6 -> s.up(id, if (useGen) gens[id] else 0)
                    7 -> { s.p.look(9, 500f, 500f, rnd.nextInt(-80, 80).toFloat(), rnd.nextInt(-80, 80).toFloat(), 250f, s.now); s.pump() }
                    8 -> if (rnd.nextInt(8) == 0) s.releaseAll() else s.cancelNext = rnd.nextInt(6) == 0
                    else -> {}
                }
                s.advance(rnd.nextLong(0, 40))
            }
            s.releaseAll()
            s.drain(3000)
            assertEquals("rodada $round: violações", emptyList<String>(), s.android.violations)
            assertTrue("rodada $round: ponteiros presos ${s.android.down}", s.android.down.isEmpty())
            assertEquals("rodada $round", 0, s.p.activeCount)
            for ((_, held) in s.android.taps) assertTrue(held > 0)
        }
    }

    // ------------------------------------------------------------------ medição (gestures/s)

    @Test fun measureGesturesPerSecond() {
        val secs = 10L
        fun run(name: String, setup: Sim.() -> Unit, tick: Sim.(Int) -> Unit = {}): String {
            val s = Sim()
            s.setup()
            var frame = 0
            for (ms in 0 until secs * 1000) {
                if (ms % 16 == 0L) s.tick(frame++)
                s.advance(1)
            }
            val gps = s.android.dispatched.toDouble() / secs
            s.releaseAll(); s.drain(); s.assertClean()
            return "%-48s %6.1f gestures/s (antes: ~%.0f/s)".format(name, gps, 1000.0 / 17)
        }
        val lines = listOf(
            run("1 dedo parado (W segurado)", { down(0) }),
            run("3 dedos parados", { down(0); down(1); down(3) }),
            run("joystick parado + câmera a 60 Hz", { down(0) }) { f ->
                p.look(9, 500f, 500f, if (f % 2 == 0) 3f else -3f, 1f, 300f, now); pump()
            },
            run("joystick mudando de direção a cada 300 ms", { down(0) }) { f ->
                if (f % 19 == 0) { p.move(0, 100f + (f % 3) * 40f, 300f, now); pump() }
            },
        )
        val text = "TouchPlanner — gestures despachados por segundo (simulação de ${secs}s):\n" + lines.joinToString("\n") +
            "\n(antes = laço antigo: um gesture de 16 ms atrás do outro enquanto houver dedo segurado)\n"
        println(text)
        File("build").mkdirs()
        File("build/touchplanner-bench.txt").writeText(text)
        assertNotNull(text)
    }
}
