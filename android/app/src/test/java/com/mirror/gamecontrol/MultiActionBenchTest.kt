package com.mirror.gamecontrol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Tabelas ANTES (0.3.2) x DEPOIS (perfis 0.3.3) no modelo do AOSP. Gravadas em build/multiaction-*.txt. */
class MultiActionBenchTest {
    private fun legacy() = TouchPlanner(maxStrokes = 10, cfg = TouchPlanner.Config())
    private fun prof(p: FluidityProfile, hz: Int) = TouchPlanner(maxStrokes = 10, cfg = p.config(1000 / hz))

    private fun write(name: String, lines: List<String>) {
        val text = lines.joinToString("\n") + "\n"
        println(text)
        File("build").mkdirs()
        File("build/$name").writeText(text)
    }

    @Test fun beforeAfterTable() {
        val lines = arrayListOf(MultiActionBench.HEADER, MultiActionBench.SEP)
        for (ipc in listOf(1L, 3L)) for (hz in listOf(60, 90, 120)) {
            lines += MultiActionBench.row("ANTES 0.3.2 · $hz Hz · ipc $ipc", MultiActionBench({ legacy() }, hz = hz, ipcMs = ipc).run())
            for (p in FluidityProfile.values()) {
                lines += MultiActionBench.row("${p.label} · $hz Hz · ipc $ipc", MultiActionBench({ prof(p, hz) }, hz = hz, ipcMs = ipc, batchInput = true).run())
            }
        }
        write("multiaction-before-after.txt", lines)
    }

    /**
     * Metas dos perfis (3 perfis x 60/90/120 Hz x 3 sementes, ipc 1 e 3): fluxo limpo (sem CANCEL, descarte,
     * inconsistência, recusa, dedo preso), todo toque de botão visto por um jogo a 30 fps, e latência menor que a
     * 0.3.2 na MESMA carga (DOWN p95, MOVE p95, UP p95) — "Economia" inclusive.
     */
    @Test fun profilesMeetGoals() {
        for (ipc in listOf(1L, 3L)) for (hz in listOf(60, 90, 120)) for (seed in 1..3) {
            val before = MultiActionBench({ legacy() }, hz = hz, ipcMs = ipc, seed = seed, seconds = 10).run()
            for (p in FluidityProfile.values()) for (floating in listOf(false, true)) {
                val r = MultiActionBench({ prof(p, hz) }, hz = hz, ipcMs = ipc, batchInput = true, seed = seed, seconds = 10, floating = floating).run()
                val tag = "${p.label} $hz Hz ipc=$ipc semente=$seed flutuante=$floating"
                assertEquals("$tag CANCEL", 0, r.cancels)
                assertEquals("$tag descartados", 0, r.dropped)
                assertEquals("$tag inconsistências", 0, r.inconsistencies)
                assertEquals("$tag recusados", 0, r.rejected)
                assertEquals("$tag dedos presos", 0, r.stuck)
                assertEquals("$tag toques vistos a 30 fps", 1.0, r.tapsSeenAt30fps, 0.0)
                // (um toque cortado por uma reciclagem de ids e cujo UP chega no meio dela não é re-pressionado se
                // já durou um quadro de 30 fps: evita um "toque duplo" que o usuário não fez)
                assertTrue("$tag toque mais curto ${r.minTapGap} ms", r.minTapGap >= minOf(p.config(1000 / hz).minTapMs, TouchPlanner.VISIBLE_TAP_MS) - 2 * ipc)
                assertTrue("$tag DOWN p95 ${r.down.pct(0.95)} vs ${before.down.pct(0.95)}", r.down.pct(0.95) < before.down.pct(0.95))
                assertTrue("$tag MOVE p95 ${r.move.pct(0.95)} vs ${before.move.pct(0.95)}", r.move.pct(0.95) < before.move.pct(0.95))
                assertTrue("$tag UP p95 ${r.up.pct(0.95)} vs ${before.up.pct(0.95)}", r.up.pct(0.95) < before.up.pct(0.95))
                if (p != FluidityProfile.ECO) assertTrue("$tag lacuna ${r.maxGap} vs ${before.maxGap}", r.maxGap <= before.maxGap)
            }
        }
    }

    /** O que cada mudança contribui (120 Hz, ipc 1), uma de cada vez a partir da 0.3.2, e o experimento de pipelining. */
    @Test fun ablationTable() {
        val base = TouchPlanner.Config()
        val bal = FluidityProfile.BALANCED.config(8)
        val steps = listOf(
            "0.3.2" to (base to false),
            "+ fila/drain dos pacotes" to (base to true),
            "+ 1º segmento curto de botão (2 ms)" to (base.copy(pressSegmentMs = 2) to true),
            "+ segmento de movimento 4 ms" to (base.copy(pressSegmentMs = 2, moveSegmentMs = 4) to true),
            "+ renovação parada curta (2 ms)" to (base.copy(pressSegmentMs = 2, moveSegmentMs = 4, holdSegmentMs = 2) to true),
            "+ final curto (2 ms)" to (base.copy(pressSegmentMs = 2, moveSegmentMs = 4, holdSegmentMs = 2, finalMs = 2) to true),
            "+ toque mínimo sem gesture em voo" to (base.copy(pressSegmentMs = 2, moveSegmentMs = 4, holdSegmentMs = 2, finalMs = 2, idleWait = true) to true),
            "+ 1º arrasto = 1 quadro (8 ms) (= Equilibrado)" to (bal to true),
        )
        val lines = arrayListOf(MultiActionBench.HEADER, MultiActionBench.SEP)
        for ((name, v) in steps) {
            val (cfg, batch) = v
            lines += MultiActionBench.row(name, MultiActionBench({ TouchPlanner(maxStrokes = 10, cfg = cfg) }, hz = 120, batchInput = batch).run())
        }
        for (lead in listOf(1L, 2L, 4L)) {
            lines += MultiActionBench.row("0.3.2 + pipelining ${lead} ms", MultiActionBench({ legacy() }, hz = 120, pipelineLeadMs = lead).run())
            lines += MultiActionBench.row("Equilibrado + pipelining ${lead} ms", MultiActionBench({ prof(FluidityProfile.BALANCED, 120) }, hz = 120, batchInput = true, pipelineLeadMs = lead).run())
        }
        // DOWN de um dedo novo SEM outros dedos (só botões, sem joystick/câmera) e com eles
        for (hz in listOf(60, 90, 120)) {
            lines += MultiActionBench.row("só botões · ANTES · $hz Hz", MultiActionBench({ legacy() }, hz = hz, camera = false, joystick = false).run())
            lines += MultiActionBench.row("só botões · Equilibrado · $hz Hz", MultiActionBench({ prof(FluidityProfile.BALANCED, hz) }, hz = hz, batchInput = true, camera = false, joystick = false).run())
            lines += MultiActionBench.row("só botões · Máx. fluidez · $hz Hz", MultiActionBench({ prof(FluidityProfile.SMOOTH, hz) }, hz = hz, batchInput = true, camera = false, joystick = false).run())
        }
        write("multiaction-ablation.txt", lines)
    }
}
