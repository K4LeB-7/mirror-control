package com.mirror.gamecontrol

import kotlin.math.hypot
import kotlin.math.roundToInt
import kotlin.random.Random

/**
 * Carga de "multiação" realista para o modelo do AOSP ([AospSim]) e as métricas de fluidez/latência.
 *
 * Carga (determinística por semente): joystick (WASD) mudando de direção a cada 100–300 ms, às vezes solto
 * 100–400 ms; rajadas de 2–6 botões (pool de ponteiros 1..7 como o site, toques de 30–250 ms, 25% das rajadas com
 * teclas "juntas" a 0–1 ms); câmera (mouse travado) a 60 Hz em trechos de 0,3–1,5 s. Rede = USB (ordenado, 2 ms).
 *
 * Métricas (do instante em que o pacote é aplicado no celular até o MotionEvent entregue ao "jogo"):
 * - DOWN: até o DOWN/POINTER_DOWN do dedo novo;
 * - UP: até o UP/POINTER_UP, descontando o toque mínimo (só a espera do planejador);
 * - MOVE (joystick): até o 1º evento com o dedo do joystick exatamente no destino novo;
 * - LOOK (câmera): até o 1º evento que move o dedo da câmera depois do pacote;
 * - maior lacuna entre eventos de um dedo segurado (joystick);
 * - reciclagens (piscadas do joystick: UP+DOWN que o usuário não pediu) e ms com o joystick fora da posição
 *   (sem dedo no jogo ou lido no centro enquanto o usuário segura uma direção, depois do 1º DOWN entregue);
 * - CANCEL, eventos descartados, inconsistências, gesture recusados; gestures/s; bytes alocados por gesture
 *   dentro do planejador (plan + completed).
 */
class MultiActionBench(
    val makePlanner: () -> TouchPlanner,
    val hz: Int = 120,
    val ipcMs: Long = 1,
    val batchInput: Boolean = false,
    val seconds: Int = 20,
    val seed: Int = 1,
    val pipelineLeadMs: Long = 0,
    val floating: Boolean = false,
    val camera: Boolean = true,
    val buttons: Boolean = true,
) {
    class Stat {
        private val v = ArrayList<Long>()
        fun add(x: Long) { v += x }
        val n get() = v.size
        fun pct(p: Double): Long {
            if (v.isEmpty()) return -1
            val s = v.sorted()
            return s[((s.size - 1) * p).roundToInt()]
        }
        val max get() = v.maxOrNull() ?: -1
        val mean get() = if (v.isEmpty()) -1.0 else v.average()
        fun fmt() = if (v.isEmpty()) "—" else "%d/%d/%d/%d".format(pct(0.5), pct(0.95), pct(0.99), max)
    }

    class Result(
        val down: Stat, val downAlone: Stat, val downWithOthers: Stat, val pairSecond: Stat, val up: Stat, val move: Stat, val look: Stat,
        val maxGap: Long, val blinks: Int, val outOfPositionMs: Long, val heldMs: Long,
        val cancels: Int, val dropped: Int, val inconsistencies: Int, val rejected: Int,
        val gesturesPerSec: Double, val segmentsPerGesture: Double, val allocPerGesture: Double, val recycles: Long,
        val stuck: Int, val tapsSeenAt30fps: Double, val minTapGap: Long,
    )

    fun run(): Result {
        val planner = makePlanner()
        val sim = AospSim(planner, sampleMs = 1000 / hz, ipcMs = ipcMs, batchInput = batchInput, pipelineLeadMs = pipelineLeadMs, floating = floating)
        val site = FakeSite(sim, latencyMs = 2)
        val rnd = Random(seed)

        val down = Stat(); val downAlone = Stat(); val downWithOthers = Stat(); val pairSecond = Stat(); val up = Stat(); val move = Stat(); val look = Stat()
        val lastGen = IntArray(16)
        val pendingDown = LongArray(16) { -1 }
        val pendingDownOthers = BooleanArray(16)
        val pendingDownPair = BooleanArray(16)
        val pendingUp = Array(16) { ArrayDeque<Long>() }
        val downDeliveredAt = LongArray(16) { -1 }
        var joyTarget: Pair<Int, Int>? = null
        var joyTargetAt = 0L
        var lookPendingAt = -1L
        var blinks = 0
        val minTap = planner.cfg.minTapMs
        val pairNext = BooleanArray(16) // próximo DOWN deste ponteiro é a 2ª+ tecla de uma rajada "junta"

        sim.onPacket = { a, p, gen, t ->
            when (a) {
                InputProtocol.DOWN -> if (gen > lastGen[p]) {
                    lastGen[p] = gen
                    pendingDown[p] = t
                    pendingDownOthers[p] = planner.activeCount > 0
                    pendingDownPair[p] = pairNext[p]
                    pairNext[p] = false
                }
                InputProtocol.UP -> if (gen >= lastGen[p] && gen > 0 && (pendingUp[p].isEmpty()) && planner.isHeld(p)) {
                    lastGen[p] = gen
                    pendingUp[p].addLast(t)
                }
                InputProtocol.LOOK -> if (lookPendingAt < 0) lookPendingAt = t
            }
        }
        // posição do dedo do joystick no jogo (px) para MOVE
        val prevGameEvent = sim.model.onEvent
        var lastJoyEventAt = -1L
        var maxGap = 0L
        var joyDown = false
        var lastLookPos: Pair<Int, Int>? = null
        sim.model.onEvent = { e ->
            prevGameEvent(e)
            val t = e.time
            val subjectStroke = when (e.action) {
                AospTouchModel.DOWN, AospTouchModel.PDOWN -> e.strokes.lastOrNull()
                AospTouchModel.UP, AospTouchModel.PUP -> e.strokes.getOrNull(e.index)
                else -> null
            }
            val subject = subjectStroke?.let { sim.strokePointer[it] }
            if (subject != null && (e.action == AospTouchModel.DOWN || e.action == AospTouchModel.PDOWN)) {
                if (pendingDown[subject] >= 0) {
                    val l = t - pendingDown[subject]
                    down.add(l)
                    (if (pendingDownOthers[subject]) downWithOthers else downAlone).add(l)
                    if (pendingDownPair[subject]) pairSecond.add(l)
                    pendingDown[subject] = -1
                    downDeliveredAt[subject] = t
                }
                if (subject == 0) {
                    if (joyDown) maxGap = maxOf(maxGap, 0)
                    joyDown = true
                }
            }
            if (subject != null && (e.action == AospTouchModel.UP || e.action == AospTouchModel.PUP)) {
                val q = pendingUp[subject]
                if (q.isNotEmpty()) {
                    val arrived = q.removeFirst()
                    up.add(t - maxOf(arrived, downDeliveredAt[subject] + minTap))
                    if (subject == 0) { joyDown = false; lastJoyEventAt = -1 }
                } else if (subject == 0) {
                    blinks++ // UP do joystick que o usuário não pediu (reciclagem)
                }
            }
            // MOVE do joystick e lacuna
            for (i in e.strokes.indices) {
                val p = sim.strokePointer[e.strokes[i]] ?: continue
                if (p == 0) {
                    if (joyDown && lastJoyEventAt >= 0) maxGap = maxOf(maxGap, t - lastJoyEventAt)
                    if (joyDown) lastJoyEventAt = t
                    val tg = joyTarget
                    if (tg != null && e.xs[i] == tg.first && e.ys[i] == tg.second) {
                        move.add(t - joyTargetAt)
                        joyTarget = null
                    }
                }
                if (p == 9) {
                    val pos = e.xs[i] to e.ys[i]
                    if (lookPendingAt >= 0 && lastLookPos != null && pos != lastLookPos && e.action == AospTouchModel.MOVE) {
                        look.add(t - lookPendingAt)
                        lookPendingAt = -1
                    }
                    lastLookPos = pos
                    if (e.action == AospTouchModel.DOWN || e.action == AospTouchModel.PDOWN) lookPendingAt = -1
                }
            }
        }

        // ------------------------------------------------------------ carga
        val dirs = listOf(-1 to 0, 1 to 0, 0 to -1, 0 to 1, -1 to -1, 1 to -1, -1 to 1, 1 to 1)
        var joy: Pair<Int, Int>? = null
        var nextJoy = 50L
        val freedAt = LongArray(8) { -1000 }
        val used = BooleanArray(8)
        val releaseAt = LongArray(8) { Long.MAX_VALUE }
        val burst = ArrayDeque<Pair<Long, Boolean>>() // instante, 2ª+ tecla de uma rajada "junta"
        var nextBurst = 300L
        var camOn = false
        var nextCamToggle = 200L
        var nextLook = 0L
        var lookFrame = 0
        var heldMs = 0L
        var outMs = 0L
        val end = seconds * 1000L

        fun acquire(t: Long): Int? {
            var fb: Int? = null
            for (p in 1..7) {
                if (used[p]) continue
                if (t - freedAt[p] >= 80) { used[p] = true; return p }
                if (fb == null) fb = p
            }
            fb?.let { used[it] = true }
            return fb
        }

        fun joyTargetPx(vx: Int, vy: Int): Pair<Int, Int> {
            val len = hypot(vx.toFloat(), vy.toFloat())
            val aspect = sim.w.toFloat() / sim.h
            val x = site.joyX + vx / len * site.joyR / aspect
            val y = site.joyY + vy / len * site.joyR
            return (x * (sim.w - 1)).roundToInt().coerceIn(0, sim.w - 1) to (y * (sim.h - 1)).roundToInt().coerceIn(0, sim.h - 1)
        }

        while (sim.now < end) {
            val t = sim.now
            if (t >= nextJoy) {
                if (joy != null && rnd.nextInt(100) < 15) {
                    joy = null
                    site.joystick(0, 0)
                    nextJoy = t + rnd.nextLong(100, 400)
                } else {
                    var d: Pair<Int, Int>
                    do d = dirs[rnd.nextInt(dirs.size)] while (d == joy)
                    joy = d
                    site.joystick(d.first, d.second)
                    joyTarget = joyTargetPx(d.first, d.second)
                    joyTargetAt = t + 2 // chega ao celular 2 ms depois
                    nextJoy = t + rnd.nextLong(100, 300)
                }
            }
            if (buttons && t >= nextBurst) {
                val n = rnd.nextInt(2, 7)
                val together = rnd.nextInt(4) == 0
                var at = t
                for (i in 0 until n) {
                    burst.addLast(at to (together && i > 0))
                    at += if (together) rnd.nextLong(0, 2) else rnd.nextLong(0, 41)
                }
                nextBurst = at + rnd.nextLong(200, 800)
            }
            while (burst.isNotEmpty() && burst.first().first <= t) {
                val pair = burst.removeFirst().second
                val p = acquire(t) ?: continue
                pairNext[p] = pair
                site.press(p, 0.55f + p * 0.05f, 0.3f + (p % 3) * 0.15f)
                releaseAt[p] = t + rnd.nextLong(30, 251)
            }
            for (p in 1..7) if (t >= releaseAt[p]) {
                site.lift(p)
                releaseAt[p] = Long.MAX_VALUE
                used[p] = false
                freedAt[p] = t
            }
            if (camera && t >= nextCamToggle) {
                camOn = !camOn
                nextCamToggle = t + rnd.nextLong(300, 1500)
            }
            if (camOn && t >= nextLook) {
                site.look(rnd.nextInt(-25, 26) / 1000f, rnd.nextInt(-12, 13) / 1000f)
                lookFrame++
                nextLook = t + if (lookFrame % 3 == 0) 16 else 17
            }
            sim.run(1) { s ->
                if (joy != null && planner.isHeld(0) && downDeliveredAt[0] >= 0 && pendingDown[0] < 0) {
                    heldMs++
                    val r = s.game.joystick(s.game.strict)
                    if (r == null || hypot(r.first, r.second) < 0.5) outMs++
                }
            }
        }
        // solta tudo e confere dedo preso
        site.joystick(0, 0)
        for (p in 1..7) if (releaseAt[p] != Long.MAX_VALUE) site.lift(p)
        sim.run(1500)
        val stuck = sim.game.strict.fingers.size

        // toques vistos por um jogo a 30 fps (fase aleatória): fração de toques de botão cujo intervalo DOWN..UP
        // contém pelo menos uma amostra de quadro.
        val taps = ArrayList<Pair<Long, Long>>()
        val open = HashMap<Int, Long>()
        for (e in sim.game.events) {
            val st = when (e.action) {
                AospTouchModel.DOWN, AospTouchModel.PDOWN -> e.strokes.lastOrNull()
                AospTouchModel.UP, AospTouchModel.PUP -> e.strokes.getOrNull(e.index)
                else -> null
            } ?: continue
            val p = sim.strokePointer[st] ?: continue
            if (p !in 1..7) continue
            if (e.action == AospTouchModel.DOWN || e.action == AospTouchModel.PDOWN) open[p] = e.time
            else open.remove(p)?.let { taps += it to e.time }
        }
        val frame = 1000.0 / 30
        val phase = Random(seed + 99).nextDouble() * frame
        var seen = 0
        var minDur = Long.MAX_VALUE
        for ((a, b) in taps) {
            minDur = minOf(minDur, b - a)
            val k = kotlin.math.ceil((a - phase) / frame)
            if (phase + k * frame < b) seen++
        }

        val secs = sim.now / 1000.0
        return Result(
            down, downAlone, downWithOthers, pairSecond, up, move, look,
            maxGap, blinks, outMs, heldMs,
            sim.game.cancels, sim.game.dropped.size, sim.game.inconsistencies.size, sim.model.rejectedEmpty + sim.model.rejectedContinue,
            sim.dispatched / secs, sim.segmentsDispatched.toDouble() / maxOf(1, sim.dispatched), sim.allocBytes.toDouble() / maxOf(1, sim.dispatched),
            planner.recycles, stuck, if (taps.isEmpty()) 1.0 else seen.toDouble() / taps.size, if (taps.isEmpty()) -1 else minDur,
        )
    }

    companion object {
        const val HEADER = "| cenário | DOWN p50/p95/p99/máx | DOWN c/ outros dedos | 2ª tecla \"junta\" | UP (espera) | MOVE joystick | LOOK câmera | lacuna máx | piscadas | joystick fora (ms/%) | CANCEL/descart./recus. | gestures/s | B/gesture |"
        const val SEP = "|---|---|---|---|---|---|---|---|---|---|---|---|---|"
        fun row(name: String, r: Result) = "| %s | %s | %s | %s | %s | %s | %s | %d | %d | %d (%.1f%%) | %d/%d/%d | %.1f | %.0f |".format(
            name, r.down.fmt(), r.downWithOthers.fmt(), r.pairSecond.fmt(), r.up.fmt(), r.move.fmt(), r.look.fmt(), r.maxGap, r.blinks,
            r.outOfPositionMs, if (r.heldMs > 0) r.outOfPositionMs * 100.0 / r.heldMs else 0.0,
            r.cancels, r.dropped, r.rejected, r.gesturesPerSec, r.allocPerGesture,
        )
    }
}
