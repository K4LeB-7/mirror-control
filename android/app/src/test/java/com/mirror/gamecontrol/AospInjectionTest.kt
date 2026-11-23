package com.mirror.gamecontrol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.random.Random

/**
 * Bugs A ("A + Espaço anda para a direita") e B ("anda, para, anda…") reproduzidos contra o modelo do AOSP
 * ([AospTouchModel]): o planejador real + o laço do TouchInjector + MotionEventInjector/GestureDescription
 * transcritos do código do Android 14/15 + um "jogo" com joystick virtual (fixo e flutuante).
 */
class AospInjectionTest {

    private class Report(val sim: AospSim) {
        var rightReadings = 0          // joystick lido à DIREITA do centro enquanto só A está pressionado
        var neutralReadings = 0        // joystick sem dedo / no centro enquanto A está pressionado
        var samples = 0
        var maxGap = 0L                // maior intervalo sem evento para o dedo do joystick (ms)
        var neutralRun = 0             // ms seguidos parado/solto
        var maxNeutralRun = 0
        val firstRight = ArrayList<String>()

        fun sample(view: FakeGame.View, holdingLeft: Boolean, warmup: Boolean) {
            if (!holdingLeft || warmup) return
            samples++
            val r = sim.game.joystick(view)
            if (r == null || r.first > -0.5) {
                neutralReadings++
                neutralRun++
                maxNeutralRun = maxOf(maxNeutralRun, neutralRun)
            } else neutralRun = 0
            if (r != null && r.first > 0.2) {
                rightReadings++
                if (firstRight.size < 3) firstRight += "t=${sim.now} ${view.name} leitura=$r eventos=${sim.game.events.takeLast(4)}"
            }
            val id = view.joyId
            if (view === sim.game.strict && id != null) sim.game.lastEventAt[id]?.let { maxGap = maxOf(maxGap, sim.now - it) }
        }
    }

    private fun AospSim.assertStreamClean() {
        assertEquals("eventos descartados (ids duplicados): ${game.dropped.take(3)}", 0, game.dropped.size)
        assertEquals("fluxo inconsistente: ${game.inconsistencies.take(3)}", 0, game.inconsistencies.size)
        assertEquals("gesture inválido: $buildErrors", 0, buildErrors.size)
    }

    // ------------------------------------------------------------------ bug B

    private fun holdLeft(floating: Boolean, sampleMs: Int): Pair<AospSim, Report> {
        val sim = AospSim(sampleMs = sampleMs, floating = floating)
        sim.planner.setDeadman(500)
        val site = FakeSite(sim)
        val rep = Report(sim)
        sim.run(10)
        site.joystick(-1, 0)
        val start = sim.now
        sim.run(10_000) { s -> rep.sample(s.game.strict, true, s.now - start < 100) }
        return sim to rep
    }

    @Test fun bugB_joystickHeld10sNeverCancelsNorStopsNorGoesSilent() {
        for (floating in listOf(false, true)) for (sampleMs in listOf(8, 16)) {
            val (sim, rep) = holdLeft(floating, sampleMs)
            val tag = "flutuante=$floating amostra=${sampleMs}ms"
            assertEquals("$tag: CANCEL enviados ao jogo", 0, sim.game.cancels)
            assertEquals("$tag: gestures recusados por não gerar evento", 0, sim.model.rejectedEmpty)
            assertEquals("$tag: o joystick foi solto no jogo", 0, sim.game.strict.joyReleases)
            assertEquals("$tag: amostras paradas/no centro de ${rep.samples}", 0, rep.neutralReadings)
            assertTrue("$tag: maior lacuna sem evento ${rep.maxGap} ms", rep.maxGap <= MAX_GAP_MS)
            sim.assertStreamClean()
        }
    }

    // ------------------------------------------------------------------ bug A

    /**
     * A segurado + Espaço (pular) repetido, opcionalmente com a câmera (mouse) mexendo em rajadas, que é o uso real
     * num jogo de tiro. [spaceFirst]: o Espaço é pressionado um pouco ANTES do A em cada ciclo.
     */
    private fun leftAndJumps(floating: Boolean, camera: Boolean, spaceFirst: Boolean, seconds: Int = 10): Pair<AospSim, Pair<Report, Report>> {
        val sim = AospSim(floating = floating)
        sim.planner.setDeadman(500)
        val site = FakeSite(sim)
        val strict = Report(sim)
        val engine = Report(sim)
        var holdingLeft = false
        var since = 0L
        val rnd = Random(7)
        sim.run(10)
        val end = sim.now + seconds * 1000L
        var nextJump = sim.now + 300
        var jumpUpAt = Long.MAX_VALUE
        var cycleAt = sim.now + 2500
        if (spaceFirst) { site.press(3, 0.93f, 0.8f); sim.run(40) }
        site.joystick(-1, 0); holdingLeft = true; since = sim.now
        if (spaceFirst) { sim.run(80); site.lift(3) }
        while (sim.now < end) {
            sim.run(1) { s ->
                val warm = s.now - since < 100
                strict.sample(s.game.strict, holdingLeft, warm)
                engine.sample(s.game.engine, holdingLeft, warm)
            }
            if (camera && (sim.now / 400) % 2 == 0L && sim.now % 16 == 0L) site.look(rnd.nextInt(-30, 60) / 1000f, rnd.nextInt(-20, 20) / 1000f)
            if (sim.now >= nextJump) { site.press(3, 0.93f, 0.8f); jumpUpAt = sim.now + rnd.nextLong(30, 160); nextJump = sim.now + rnd.nextLong(250, 600) }
            if (sim.now >= jumpUpAt) { site.lift(3); jumpUpAt = Long.MAX_VALUE }
            if (sim.now >= cycleAt) {
                // solta o A um instante e volta (troca de tecla), às vezes com o Espaço já apertado
                holdingLeft = false
                site.joystick(0, 0)
                sim.run(rnd.nextLong(40, 200))
                if (spaceFirst && jumpUpAt == Long.MAX_VALUE) { site.press(3, 0.93f, 0.8f); jumpUpAt = sim.now + 120; sim.run(30) }
                site.joystick(-1, 0); holdingLeft = true; since = sim.now
                cycleAt = sim.now + rnd.nextLong(1500, 3000)
            }
        }
        return sim to (strict to engine)
    }

    @Test fun bugA_leftPlusJumpNeverReadsRightNorCancels() {
        for (floating in listOf(false, true)) for (camera in listOf(false, true)) for (spaceFirst in listOf(false, true)) {
            val (sim, reps) = leftAndJumps(floating, camera, spaceFirst)
            val (strict, engine) = reps
            val tag = "flutuante=$floating câmera=$camera espaçoAntes=$spaceFirst"
            assertEquals("$tag: CANCEL enviados ao jogo", 0, sim.game.cancels)
            assertEquals("$tag: leituras à DIREITA (android) ${strict.firstRight}", 0, strict.rightReadings)
            assertEquals("$tag: leituras à DIREITA (motor por ponteiro) ${engine.firstRight}", 0, engine.rightReadings)
            // Só a reciclagem de ids (dedos novos demais com o joystick segurado) levanta e re-encosta o joystick:
            // um "piscar" curto (DOWN no centro + arrasto), nunca um CANCEL nem a direção errada.
            assertTrue("$tag: joystick parado/solto (android) em ${strict.neutralReadings} de ${strict.samples} ms", strict.neutralReadings * 100 <= strict.samples)
            assertTrue("$tag: maior trecho parado ${strict.maxNeutralRun} ms", strict.maxNeutralRun <= MAX_BLIP_MS)
            if (!camera) assertEquals("$tag: sem câmera não há reciclagem", 0, strict.neutralReadings)
            assertTrue("$tag: maior lacuna ${strict.maxGap} ms", strict.maxGap <= MAX_GAP_MS)
            sim.assertStreamClean()
        }
    }

    // ------------------------------------------------------------------ ids de ponteiro do sistema

    /**
     * O AOSP só libera os ids de ponteiro quando TODOS os dedos levantam e, esgotados 0..9, dá o id 10 a qualquer
     * dedo novo: dois dedos novos ao mesmo tempo ficam com o mesmo id (evento descartado / dedos trocados).
     */
    @Test fun manyTapsWhileHoldingNeverDuplicatePointerIds() {
        val sim = AospSim()
        sim.planner.setDeadman(500)
        val site = FakeSite(sim)
        val rnd = Random(11)
        sim.run(10)
        site.joystick(-1, 0)
        val rep = Report(sim)
        val start = sim.now
        val down = BooleanArray(8)
        repeat(20_000 / 20) {
            sim.run(20) { s -> rep.sample(s.game.strict, true, s.now - start < 100) }
            val b = rnd.nextInt(1, 8)
            if (rnd.nextInt(3) == 0) {
                if (down[b]) site.lift(b) else site.press(b, 0.5f + b * 0.06f, 0.3f)
                down[b] = !down[b]
            }
            if (rnd.nextInt(4) == 0) site.look(rnd.nextInt(-200, 200) / 1000f, 0.01f)
        }
        assertEquals("leituras à direita ${rep.firstRight}", 0, rep.rightReadings)
        assertTrue("joystick parado/solto em ${rep.neutralReadings} de ${rep.samples} ms", rep.neutralReadings * 100 <= rep.samples * 3)
        assertTrue("maior trecho parado ${rep.maxNeutralRun} ms", rep.maxNeutralRun <= MAX_BLIP_MS)
        assertEquals("CANCEL", 0, sim.game.cancels)
        assertTrue("o teto de ids foi atingido (o teste exercita a reciclagem)", sim.planner.recycles > 0)
        sim.assertStreamClean()
        for (b in 1..7) if (down[b]) site.lift(b)
        site.joystick(0, 0)
        sim.run(1500)
        assertTrue("dedos presos no jogo: ${sim.game.strict.fingers}", sim.game.strict.fingers.isEmpty())
    }

    // ------------------------------------------------------------------ cancelamento real, keepalive, deadman

    @Test fun realTouchCancelRecoversJoystickFromCenter() {
        for (floating in listOf(false, true)) {
            val sim = AospSim(floating = floating)
            sim.planner.setDeadman(500)
            val site = FakeSite(sim)
            sim.run(10)
            site.joystick(-1, 0)
            site.press(3, 0.93f, 0.8f)
            sim.run(300)
            sim.model.realTouch(sim.now) // o usuário encostou na tela: o sistema cancela o gesture injetado
            val engine = Report(sim)
            sim.run(150)
            sim.run(3000) { s -> engine.sample(s.game.engine, true, false) }
            assertEquals("flutuante=$floating: um CANCEL (o do toque real)", 1, sim.game.cancels)
            val r = sim.game.joystick(sim.game.strict)
            assertTrue("flutuante=$floating: voltou a andar para a esquerda: $r", r != null && r.first < -0.9)
            assertEquals("flutuante=$floating: direita depois do cancelamento ${engine.firstRight}", 0, engine.rightReadings)
            sim.assertStreamClean()
        }
    }

    @Test fun deadmanReleasesWithoutKeepaliveAndKeepaliveRePressesFromCenter() {
        val sim = AospSim(floating = true)
        sim.planner.setDeadman(500)
        sim.run(10)
        // site "mudo": DOWN + MOVE e nenhum keepalive (rede caiu)
        sim.packet(InputProtocol.DOWN, 0, 0.14f, 0.68f, gen = 1)
        sim.packet(InputProtocol.MOVE, 0, 0.07f, 0.68f)
        sim.run(400)
        assertTrue(sim.game.joystick(sim.game.strict)!!.first < -0.9)
        sim.run(400)
        assertTrue("deadman soltou", sim.game.strict.fingers.isEmpty())
        // a rede volta: keepalive (DOWN gen 1 no CENTRO + MOVE) re-pressiona do centro e arrasta
        sim.packet(InputProtocol.DOWN, 0, 0.14f, 0.68f, gen = 1)
        sim.packet(InputProtocol.MOVE, 0, 0.07f, 0.68f)
        sim.run(100)
        val r = sim.game.joystick(sim.game.strict)
        assertTrue("joystick flutuante voltou a ler esquerda: $r", r != null && r.first < -0.9)
        sim.assertStreamClean()
    }

    // ------------------------------------------------------------------ fuzz

    @Test fun fuzzAgainstAospModel() {
        val rnd = Random(2024)
        repeat(60) { round ->
            val sim = AospSim(sampleMs = if (round % 2 == 0) 8 else 16, floating = round % 3 == 0)
            sim.planner.setDeadman(500)
            val site = FakeSite(sim)
            var real = 0
            val pressed = BooleanArray(10)
            repeat(rnd.nextInt(50, 300)) {
                when (rnd.nextInt(12)) {
                    0, 1 -> site.joystick(rnd.nextInt(-1, 2), rnd.nextInt(-1, 2))
                    2, 3, 4 -> { val b = rnd.nextInt(1, 9); if (pressed[b]) site.lift(b) else site.press(b, rnd.nextFloat(), rnd.nextFloat()); pressed[b] = !pressed[b] }
                    5 -> { val b = 8; if (pressed[b]) site.moveTo(b, rnd.nextFloat(), rnd.nextFloat()) }
                    6, 7 -> site.look(rnd.nextInt(-150, 150) / 1000f, rnd.nextInt(-150, 150) / 1000f)
                    8 -> if (rnd.nextInt(10) == 0) { sim.model.realTouch(sim.now); real++ }
                    else -> {}
                }
                sim.run(rnd.nextLong(0, 60))
            }
            assertEquals("rodada $round: recusados vazios", 0, sim.model.rejectedEmpty)
            assertTrue("rodada $round: recusas de continuação ${sim.model.rejectedContinue} > toques reais $real", sim.model.rejectedContinue <= real)
            assertTrue("rodada $round: CANCEL ${sim.game.cancels} > toques reais $real", sim.game.cancels <= real)
            sim.assertStreamClean()
            site.joystick(0, 0)
            for (b in 1..9) if (pressed[b]) site.lift(b)
            sim.run(2000)
            assertTrue("rodada $round: dedos presos ${sim.game.strict.fingers}", sim.game.strict.fingers.isEmpty())
            assertEquals("rodada $round", 0, sim.planner.activeCount)
        }
    }

    // ------------------------------------------------------------------ medição

    @Test fun measureAgainstAospModel() {
        val lines = ArrayList<String>()
        for (floating in listOf(false, true)) {
            val (sim, rep) = holdLeft(floating, 8)
            val gaps = sim.game.events.filter { e -> e.ids.isNotEmpty() }.map { it.time }.zipWithNext { a, b -> b - a }
            lines += "A segurado 10 s (joystick ${if (floating) "flutuante" else "fixo"}): %.1f gestures/s, CANCEL=%d, recusados=%d, eventos=%d, intervalo entre eventos min=%d máx=%d ms, maior lacuna do dedo=%d ms, amostras paradas=%d".format(
                sim.dispatched / 10.0, sim.game.cancels, sim.model.rejectedEmpty, sim.game.events.size,
                gaps.minOrNull() ?: -1, gaps.maxOrNull() ?: -1, rep.maxGap, rep.neutralReadings)
        }
        for (floating in listOf(false, true)) for (camera in listOf(false, true)) for (spaceFirst in listOf(false, true)) {
            val (sim, reps) = leftAndJumps(floating, camera, spaceFirst)
            lines += "A + pulos (flutuante=%s câmera=%s espaçoAntes=%s) 10 s: %.1f gestures/s, CANCEL=%d, recusados=%d, ms à direita android=%d motor=%d, ms parado android=%d/%d (maior trecho %d), descartados=%d, maior id=%d, reciclagens=%d, maior lacuna=%d ms".format(
                floating, camera, spaceFirst, sim.dispatched / 10.0, sim.game.cancels, sim.model.rejectedEmpty,
                reps.first.rightReadings, reps.second.rightReadings, reps.first.neutralReadings, reps.first.samples, reps.first.maxNeutralRun,
                sim.game.dropped.size, sim.model.maxPointerIdSeen, recyclesOf(sim), reps.first.maxGap)
            if (reps.second.firstRight.isNotEmpty()) lines += "   1ª leitura à direita: ${reps.second.firstRight[0]}"
        }
        val text = "Modelo AOSP (MotionEventInjector android14/15):\n" + lines.joinToString("\n") + "\n"
        println(text)
        File("build").mkdirs()
        File("build/aosp-model-bench.txt").writeText(text)
    }

    /** Reciclagens (o planejador antigo não tem o contador). */
    private fun recyclesOf(sim: AospSim): Long = try { sim.planner.recycles } catch (_: Throwable) { -1 }

    companion object {
        /** Maior intervalo aceitável sem nenhum MotionEvent para um dedo segurado. */
        const val MAX_GAP_MS = 50L
        /** Maior "piscar" do joystick numa reciclagem de ids (UP + DOWN no centro + arrasto). */
        const val MAX_BLIP_MS = 30
    }
}
