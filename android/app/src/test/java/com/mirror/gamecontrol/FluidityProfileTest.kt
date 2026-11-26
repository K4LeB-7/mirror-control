package com.mirror.gamecontrol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/** Perfis de fluidez (0.3.3): configuração, troca em tempo de execução, regressões dos bugs antigos e fuzz por perfil. */
class FluidityProfileTest {

    @Test fun wireNamesFramesAndConfigs() {
        assertEquals(FluidityProfile.BALANCED, FluidityProfile.fromWire("balanced"))
        assertEquals(FluidityProfile.SMOOTH, FluidityProfile.fromWire("smooth"))
        assertEquals(FluidityProfile.ECO, FluidityProfile.fromWire("eco"))
        assertNull(FluidityProfile.fromWire("turbo"))
        assertNull(FluidityProfile.fromWire(null))
        assertEquals(8, FluidityProfile.frameMs(120f))
        assertEquals(11, FluidityProfile.frameMs(90f))
        assertEquals(16, FluidityProfile.frameMs(60f))
        assertEquals(16, FluidityProfile.frameMs(0f))
        for (p in FluidityProfile.values()) for (f in listOf(4, 8, 11, 16, 33)) {
            val c = p.config(f)
            for (d in listOf(c.segmentMs, c.pressSegmentMs, c.moveSegmentMs, c.finalMs, c.holdSegmentMs)) assertTrue("$p $f $d", d > 0)
            assertTrue(c.idleWait)
            assertTrue("toque mínimo cobre 1 quadro de 30 fps", c.minTapMs >= TouchPlanner.VISIBLE_TAP_MS)
            assertEquals(10, c.systemPointerIdCap)
        }
        // Máxima fluidez renova a cada quadro; Economia gasta menos que o Equilibrado
        assertEquals(8L, FluidityProfile.SMOOTH.config(8).holdPeriodMs)
        assertTrue(FluidityProfile.ECO.config(8).holdPeriodMs > FluidityProfile.BALANCED.config(8).holdPeriodMs)
    }

    @Test fun capsPongAndStatusJson() {
        assertEquals("{\"type\":\"caps\",\"input\":2,\"profile\":1,\"ping\":1}", InputCtrl.CAPS_JSON)
        assertEquals(InputCtrl.CAPS_JSON, InputProtocol.CAPS_JSON)
        assertEquals("{\"type\":\"pong\",\"t\":1234.567,\"p\":42,\"d\":2.5,\"profile\":\"smooth\"}",
            InputCtrl.pong(1234.567, 42, 2.5, FluidityProfile.SMOOTH))
        assertEquals("{\"type\":\"pong\",\"t\":0.000,\"p\":0,\"d\":-1.0,\"profile\":\"eco\"}",
            InputCtrl.pong(Double.NaN, -5, -1.0, FluidityProfile.ECO))
        val st = InputCtrl.profileStatus(FluidityProfile.BALANCED, 8)
        assertTrue(st, st.startsWith("{\"type\":\"status\",\"scope\":\"profile\",\"ok\":true,\"profile\":\"balanced\",\"frameMs\":8,"))
        assertTrue(st.contains("Equilibrado"))
    }

    private fun AospSim.assertClean(tag: String) {
        assertEquals("$tag descartados ${game.dropped.take(2)}", 0, game.dropped.size)
        assertEquals("$tag inconsistências ${game.inconsistencies.take(2)}", 0, game.inconsistencies.size)
        assertEquals("$tag build $buildErrors", 0, buildErrors.size)
    }

    /** Trocar de perfil com dedos segurados (o site manda o CTRL a qualquer momento) não cancela nem solta nada. */
    @Test fun switchingProfilesWhileHoldingIsSeamless() {
        for (hz in listOf(60, 90, 120)) {
            val sim = AospSim(sampleMs = 1000 / hz, batchInput = true)
            val site = FakeSite(sim, v2 = false)
            sim.run(10)
            site.joystick(-1, 0)
            site.press(3, 0.9f, 0.8f)
            var i = 0
            repeat(30) {
                sim.run(97)
                sim.planner.setConfig(FluidityProfile.values()[i++ % 3].config(1000 / hz))
                site.look(0.01f, 0f)
            }
            assertEquals("$hz Hz CANCEL", 0, sim.game.cancels)
            assertEquals("$hz Hz recusados", 0, sim.model.rejectedEmpty + sim.model.rejectedContinue)
            assertEquals("$hz Hz joystick solto", 0, sim.game.strict.joyReleases)
            val r = sim.game.joystick(sim.game.strict)
            assertTrue("$hz Hz anda à esquerda: $r", r != null && r.first < -0.9)
            sim.assertClean("$hz Hz")
            site.joystick(0, 0); site.lift(3)
            sim.run(1000)
            assertTrue("$hz Hz dedos presos ${sim.game.strict.fingers}", sim.game.strict.fingers.isEmpty())
        }
    }

    /** Toque esperando o mínimo sem gesture em voo não fica acordando a cada ms (wakeAt no futuro). */
    @Test fun idleWaitDoesNotBusyLoop() {
        val p = TouchPlanner(cfg = FluidityProfile.BALANCED.config(8))
        p.setBounds(1000, 1000)
        p.down(2, 10f, 10f, 0)
        p.up(2, 0)
        val g = p.plan(0)!!
        assertTrue(g.segments[0].willContinue)
        p.completed(3)
        assertNull("nada a fazer antes do fim do mínimo", p.plan(3))
        val wake = p.wakeAt(3)
        assertTrue("acorda perto do fim do mínimo, não já: $wake", wake in 40..50)
        assertFalse(p.inFlight)
        val fin = p.plan(wake)!!
        assertFalse("o final", fin.segments[0].willContinue)
    }

    /** Regressões dos bugs antigos (A + pulos, joystick parado, deadman, cancelamento real) em cada perfil e taxa. */
    @Test fun oldBugsStayFixedInEveryProfile() {
        for (p in FluidityProfile.values()) for (hz in listOf(60, 90, 120)) for (floating in listOf(false, true)) {
            val tag = "${p.label} $hz Hz flutuante=$floating"
            val sim = AospSim(TouchPlanner(maxStrokes = 10, cfg = p.config(1000 / hz)), sampleMs = 1000 / hz, floating = floating, batchInput = true)
            sim.planner.setDeadman(500)
            val site = FakeSite(sim)
            val rnd = Random(hz + p.ordinal)
            sim.run(10)
            site.joystick(-1, 0)
            var right = 0
            var neutral = 0
            var samples = 0
            var nextJump = sim.now + 200
            var jumpUp = Long.MAX_VALUE
            val end = sim.now + 6000
            while (sim.now < end) {
                sim.run(1) { s ->
                    if (s.now > 200) {
                        samples++
                        val r = s.game.joystick(s.game.engine)
                        if (r != null && r.first > 0.2) right++
                        if (r == null || r.first > -0.5) neutral++
                    }
                }
                if (sim.now % 16 == 0L && (sim.now / 500) % 2 == 0L) site.look(rnd.nextInt(-30, 60) / 1000f, 0.005f)
                if (sim.now >= nextJump) { site.press(3, 0.93f, 0.8f); jumpUp = sim.now + rnd.nextLong(20, 160); nextJump = sim.now + rnd.nextLong(150, 500) }
                if (sim.now >= jumpUp) { site.lift(3); jumpUp = Long.MAX_VALUE }
            }
            assertEquals("$tag CANCEL", 0, sim.game.cancels)
            assertEquals("$tag leituras à direita", 0, right)
            assertTrue("$tag joystick parado em $neutral de $samples ms", neutral * 100 <= samples * 2)
            sim.assertClean(tag)
            // dedo segurado sem keepalive: deadman solta
            site.joystick(0, 0)
            site.lift(3)
            sim.run(200)
            sim.packet(InputProtocol.DOWN, 6, 0.5f, 0.2f, gen = 9999) // ponteiro que o FakeSite não usa
            sim.run(300)
            assertTrue("$tag segurado", sim.game.strict.fingers.isNotEmpty())
            sim.run(500)
            assertTrue("$tag deadman soltou ${sim.game.strict.fingers}", sim.game.strict.fingers.isEmpty())
            // cancelamento real com dedos segurados: recomeça, sem dedo preso
            site.joystick(1, 0)
            site.press(4, 0.8f, 0.3f)
            sim.run(200)
            sim.model.realTouch(sim.now)
            sim.run(300)
            val r = sim.game.joystick(sim.game.strict)
            assertTrue("$tag voltou a andar à direita depois do cancelamento: $r", r != null && r.first > 0.9)
            site.joystick(0, 0); site.lift(4)
            sim.run(1500)
            assertTrue("$tag dedos presos ${sim.game.strict.fingers}", sim.game.strict.fingers.isEmpty())
            assertEquals("$tag", 0, sim.planner.activeCount)
        }
    }

    @Test fun fuzzEveryProfile() {
        val rnd = Random(77)
        repeat(90) { round ->
            val p = FluidityProfile.values()[round % 3]
            val hz = listOf(60, 90, 120)[(round / 3) % 3]
            val sim = AospSim(TouchPlanner(maxStrokes = 10, cfg = p.config(1000 / hz)), sampleMs = 1000 / hz, floating = round % 2 == 0, batchInput = round % 4 != 1, ipcMs = 1L + round % 3)
            sim.planner.setDeadman(500)
            val site = FakeSite(sim, v2 = round % 5 != 0)
            var real = 0
            val pressed = BooleanArray(10)
            repeat(rnd.nextInt(80, 300)) {
                when (rnd.nextInt(13)) {
                    0, 1 -> site.joystick(rnd.nextInt(-1, 2), rnd.nextInt(-1, 2))
                    2, 3, 4 -> { val b = rnd.nextInt(1, 9); if (pressed[b]) site.lift(b) else site.press(b, rnd.nextFloat(), rnd.nextFloat()); pressed[b] = !pressed[b] }
                    5 -> if (pressed[8]) site.moveTo(8, rnd.nextFloat(), rnd.nextFloat())
                    6, 7 -> site.look(rnd.nextInt(-150, 150) / 1000f, rnd.nextInt(-150, 150) / 1000f)
                    8 -> if (rnd.nextInt(10) == 0) { sim.model.realTouch(sim.now); real++ }
                    9 -> sim.planner.setConfig(FluidityProfile.values()[rnd.nextInt(3)].config(1000 / hz))
                    else -> {}
                }
                sim.run(rnd.nextLong(0, 60))
            }
            val tag = "rodada $round ${p.label} $hz Hz"
            assertEquals("$tag recusados vazios", 0, sim.model.rejectedEmpty)
            assertTrue("$tag recusas ${sim.model.rejectedContinue} > reais $real", sim.model.rejectedContinue <= real)
            assertTrue("$tag CANCEL ${sim.game.cancels} > reais $real", sim.game.cancels <= real)
            sim.assertClean(tag)
            site.joystick(0, 0)
            for (b in 1..9) if (pressed[b]) site.lift(b)
            sim.run(2000)
            assertTrue("$tag dedos presos ${sim.game.strict.fingers}", sim.game.strict.fingers.isEmpty())
            assertEquals(tag, 0, sim.planner.activeCount)
        }
    }

    @Test fun usbScratchReaderReusesInputBuffer() {
        val bytes = java.io.ByteArrayOutputStream()
        val pkt = ByteArray(18) { it.toByte() }
        bytes.write(UsbWire.encode(UsbWire.INPUT, pkt))
        bytes.write(UsbWire.encodeText(UsbWire.CTRL, "{\"type\":\"ping\",\"t\":1}"))
        bytes.write(UsbWire.encode(UsbWire.INPUT, ByteArray(18) { 7 }))
        val input = java.io.ByteArrayInputStream(bytes.toByteArray())
        val sc = UsbWire.Scratch()
        val a = UsbWire.read(input, sc)!!
        assertEquals(UsbWire.INPUT, a.type)
        assertTrue(pkt.contentEquals(a.payload))
        val first = a.payload
        val c = UsbWire.read(input, sc)!!
        assertEquals("{\"type\":\"ping\",\"t\":1}", String(c.payload, 0, c.length, Charsets.UTF_8))
        val b = UsbWire.read(input, sc)!!
        assertTrue("mesmo buffer reaproveitado", b.payload === first)
        assertEquals(7.toByte(), b.payload[17])
        assertNull(UsbWire.read(input, sc))
    }
}
