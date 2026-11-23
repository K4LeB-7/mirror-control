package com.mirror.gamecontrol

import java.util.PriorityQueue
import kotlin.math.hypot
import kotlin.math.roundToInt

/**
 * Modelo JVM do caminho de um `dispatchGesture` no Android, transcrito do código-fonte do AOSP
 * (frameworks/base, branches android14-release e android15-release, idênticos nestes arquivos):
 *
 * - `GestureDescription.MotionEventGenerator.getGestureStepsFromGestureDescription` (passos de amostragem;
 *   `sampleTimeMs = 1000 / taxa da tela`, 8 ms num painel de 120 Hz como o do Poco X7 Pro);
 * - `StrokeDescription` (ids globais crescentes, `continueStroke`, caminho de comprimento zero = "tap");
 * - `com.android.server.accessibility.MotionEventInjector` (continuação, `prepareToContinueOldGesture`,
 *   gesture sem nenhum MotionEvent = falha, CANCEL com UM ponteiro, mapa strokeId→pointerId que só é limpo quando
 *   todos os dedos levantam, `getUnusedPointerId` com teto 10, índice do POINTER_DOWN = posição no passo).
 *
 * Do lado do app ("jogo") há duas leituras do fluxo de eventos:
 * - [strict]: como o Android/View: CANCEL encerra todos os ponteiros;
 * - [engine]: como motores que tratam cada ponteiro do evento (CANCEL só encerra os ponteiros que estão NELE,
 *   DOWN de um id que o motor ainda acha pressionado vira "movimento" desse id).
 * Eventos com ids duplicados são descartados (validação do InputDispatcher para eventos injetados).
 *
 * É um MODELO (leitura do código do AOSP), não o aparelho: HyperOS pode ter mudanças próprias.
 */
class AospTouchModel(val sampleMs: Int = 8, val ipcMs: Long = 1) {

    // ------------------------------------------------------------------ GestureDescription

    class Stroke(
        val id: Int, val contId: Int,
        val fx: Int, val fy: Int, val tx: Int, val ty: Int,
        val start: Long, val end: Long, val willContinue: Boolean,
    ) {
        fun pos(t: Long): Pair<Int, Int> {
            if (fx == tx && fy == ty) return fx to fy // comprimento zero: "tap location"
            if (t == end) return tx to ty
            val f = (t - start).toFloat() / (end - start).toFloat()
            return Math.round(fx + (tx - fx) * f) to Math.round(fy + (ty - fy) * f)
        }
    }

    private var strokeCounter = 0

    fun newStroke(fx: Int, fy: Int, tx: Int, ty: Int, start: Long, dur: Long, willContinue: Boolean): Stroke {
        require(dur > 0 && start >= 0 && minOf(fx, fy, tx, ty) >= 0)
        return Stroke(strokeCounter++, -1, fx, fy, tx, ty, start, start + dur, willContinue)
    }

    fun continueStroke(prev: Stroke, fx: Int, fy: Int, tx: Int, ty: Int, start: Long, dur: Long, willContinue: Boolean): Stroke {
        check(prev.willContinue) { "Only strokes marked willContinue can be continued" }
        require(dur > 0 && start >= 0 && minOf(fx, fy, tx, ty) >= 0)
        return Stroke(strokeCounter++, prev.id, fx, fy, tx, ty, start, start + dur, willContinue)
    }

    class TP(var strokeId: Int, var contId: Int, var start: Boolean, var end: Boolean, var x: Int, var y: Int) {
        fun copy() = TP(strokeId, contId, start, end, x, y)
        fun copyFrom(o: TP) { strokeId = o.strokeId; contId = o.contId; start = o.start; end = o.end; x = o.x; y = o.y }
    }

    class Step(val t: Long, val pts: List<TP>)

    fun steps(strokes: List<Stroke>): List<Step> {
        fun nextKey(offset: Long): Long {
            var n = Long.MAX_VALUE
            for (s in strokes) {
                if (s.start < n && s.start >= offset) n = s.start
                if (s.end < n && s.end >= offset) n = s.end
            }
            return if (n == Long.MAX_VALUE) -1 else n
        }
        val out = ArrayList<Step>()
        var t = 0L
        var size = 0
        var next = nextKey(0)
        while (next >= 0) {
            t = if (size == 0) next else minOf(next, t + sampleMs)
            val pts = ArrayList<TP>()
            for (s in strokes) if (t >= s.start && t <= s.end) {
                val (x, y) = s.pos(t)
                pts += TP(s.id, s.contId, s.contId < 0 && t == s.start, !s.willContinue && t == s.end, x, y)
            }
            size = pts.size
            out += Step(t, pts)
            next = nextKey(t + 1)
        }
        return out
    }

    // ------------------------------------------------------------------ MotionEventInjector

    class Ev(val time: Long, val action: Int, val index: Int, val ids: IntArray, val xs: IntArray, val ys: IntArray) {
        fun name() = when (action) { DOWN -> "DOWN"; UP -> "UP"; MOVE -> "MOVE"; CANCEL -> "CANCEL"; PDOWN -> "PDOWN"; PUP -> "PUP"; else -> "?" }
        override fun toString() = "t=$time ${name()}[$index] " + ids.indices.joinToString(" ") { "#${ids[it]}(${xs[it]},${ys[it]})" }
    }

    private val last = Array(20) { TP(0, 0, false, false, 0, 0) }
    private var num = 0
    private val strokeToPointer = LinkedHashMap<Int, Int>()
    private var openGesture = false
    private var lastScheduled = 0L
    private val seqs = ArrayList<(Boolean) -> Unit>()

    private class Msg(val at: Long, val order: Long, val ev: Ev, val endOfSeq: Boolean)
    private var msgOrder = 0L
    private val queue = PriorityQueue<Msg>(compareBy<Msg>({ it.at }, { it.order }))

    /** Para o simulador: entregas e callbacks agendados. */
    val sink = ArrayList<Ev>()
    var onEvent: (Ev) -> Unit = {}
    var schedule: (Long, () -> Unit) -> Unit = { _, f -> f() }

    var injected = 0
    var rejectedEmpty = 0
    var rejectedContinue = 0
    var cancelsSent = 0
    var maxPointerIdSeen = -1

    /** `dispatchGesture`: o cliente calcula os passos e o sistema processa [ipcMs] depois. */
    fun inject(strokes: List<Stroke>, now: Long, cb: (Boolean) -> Unit) {
        val st = steps(strokes)
        schedule(now + ipcMs) { injectMain(st, now + ipcMs, cb) }
    }

    private fun notify(cb: (Boolean) -> Unit, ok: Boolean, now: Long) = schedule(now + ipcMs) { cb(ok) }

    private fun injectMain(st: List<Step>, now: Long, cb: (Boolean) -> Unit) {
        injected++
        val continuing = st.isNotEmpty() && st[0].pts.any { !it.start }
        if (continuing) {
            if (!prepare(st)) {
                rejectedContinue++
                cancelAnyPending(now)
                notify(cb, false, now)
                return
            }
        } else {
            cancelAnyPending(now)
            cancelAnyGestureInProgress(now)
        }
        val start = if (seqs.isEmpty()) now else lastScheduled
        val evs = eventsFromSteps(st, start)
        if (evs.isEmpty()) {
            rejectedEmpty++
            notify(cb, false, now)
            return
        }
        seqs += cb
        for ((i, e) in evs.withIndex()) {
            lastScheduled = e.time
            val at = maxOf(now, e.time)
            queue.add(Msg(at, msgOrder++, e, i == evs.size - 1))
            schedule(at) { deliverDue(at) }
        }
    }

    private fun deliverDue(now: Long) {
        while (true) {
            val m = queue.peek() ?: return
            if (m.at > now) return
            queue.poll()
            send(m.ev)
            if (m.endOfSeq && seqs.isNotEmpty()) {
                val cb = seqs.removeAt(0)
                notify(cb, true, now)
            }
        }
    }

    private fun prepare(st: List<Step>): Boolean {
        if (st.isEmpty() || num == 0) return false
        var n = 0
        for (tp in st[0].pts) {
            if (!tp.start) {
                val pid = strokeToPointer[tp.contId] ?: return false
                strokeToPointer[tp.strokeId] = pid
                val idx = find(tp.contId)
                if (idx < 0) return false
                if (last[idx].end || last[idx].x != tp.x || last[idx].y != tp.y) return false
                last[idx].strokeId = tp.strokeId
            }
            n++
        }
        for (i in 0 until num) if (!last[i].end) n--
        return n == 0
    }

    /** Toque real na tela (ou qualquer MotionEvent de outra origem): cancela o gesture injetado. */
    fun realTouch(now: Long) = cancelAnyPending(now)

    private fun cancelAnyPending(now: Long) {
        if (queue.isNotEmpty()) {
            queue.clear()
            cancelAnyGestureInProgress(now)
            for (i in seqs.indices.reversed()) notify(seqs[i], false, now)
            seqs.clear()
        } else if (num != 0) {
            cancelAnyGestureInProgress(now)
        }
        num = 0
        strokeToPointer.clear()
    }

    private fun cancelAnyGestureInProgress(now: Long) {
        if (openGesture) {
            cancelsSent++
            send(obtain(now, CANCEL, 0, 1)) // AOSP: obtainMotionEvent(..., ACTION_CANCEL, getLastTouchPoints(), 1)
            openGesture = false
        }
    }

    private fun send(e: Ev) {
        if (e.action == DOWN) openGesture = true
        if (e.action == UP || e.action == CANCEL) openGesture = false
        sink += e
        onEvent(e)
    }

    private fun find(strokeId: Int): Int {
        for (i in 0 until num) if (last[i].strokeId == strokeId) return i
        return -1
    }

    private fun eventsFromSteps(st: List<Step>, start: Long): List<Ev> {
        val out = ArrayList<Ev>()
        for (step in st) {
            if (step.pts.size > last.size) { num = 0; return emptyList() }
            val t = start + step.t
            var moved = false
            for (tp in step.pts) {
                val i = find(tp.strokeId)
                if (i >= 0) {
                    moved = moved || last[i].x != tp.x || last[i].y != tp.y
                    last[i].copyFrom(tp)
                }
            }
            if (moved) out += obtain(t, MOVE, 0, num)
            for (tp in step.pts) if (tp.end) {
                val i = find(tp.strokeId)
                if (i < 0) continue
                out += obtain(t, if (num == 1) UP else PUP, i, num)
                for (j in i until num - 1) last[j].copyFrom(last[j + 1])
                num--
                if (num == 0) strokeToPointer.clear()
            }
            for ((i, tp) in step.pts.withIndex()) if (tp.start) {
                last[num++].copyFrom(tp)
                out += obtain(t, if (num == 1) DOWN else PDOWN, i, num) // AOSP usa i (posição no passo)
            }
        }
        return out
    }

    private fun obtain(t: Long, action: Int, index: Int, size: Int): Ev {
        val ids = IntArray(size)
        val xs = IntArray(size)
        val ys = IntArray(size)
        for (i in 0 until size) {
            var id = strokeToPointer[last[i].strokeId] ?: -1
            if (id == -1) {
                id = unusedPointerId()
                strokeToPointer[last[i].strokeId] = id
            }
            ids[i] = id
            xs[i] = last[i].x
            ys[i] = last[i].y
            maxPointerIdSeen = maxOf(maxPointerIdSeen, id)
        }
        return Ev(t, action, index, ids, xs, ys)
    }

    private fun unusedPointerId(): Int {
        var p = 0
        while (strokeToPointer.containsValue(p)) {
            p++
            if (p >= 10) return 10
        }
        return p
    }

    companion object {
        const val DOWN = 0
        const val UP = 1
        const val MOVE = 2
        const val CANCEL = 3
        const val PDOWN = 5
        const val PUP = 6
    }
}

/**
 * O "jogo": valida o fluxo como o InputDispatcher (ids duplicados = evento descartado; consistência de DOWN/UP) e
 * mantém duas leituras dos dedos ([strict] e [engine], ver [AospTouchModel]) com um joystick virtual em cada.
 */
class FakeGame(val joyX: Int, val joyY: Int, val joyRadius: Int, val zoneRadius: Int, val floating: Boolean) {
    class View(val name: String) {
        val fingers = LinkedHashMap<Int, Pair<Int, Int>>()
        var joyId: Int? = null
        var baseX = 0
        var baseY = 0
        var joyReleases = 0
    }

    val strict = View("android")
    val engine = View("motor por ponteiro")
    val dropped = ArrayList<String>()
    val inconsistencies = ArrayList<String>()
    val events = ArrayList<AospTouchModel.Ev>()
    var cancels = 0
    /** Momentos (ms) em que um evento qualquer chegou, por id do ponteiro. */
    val lastEventAt = HashMap<Int, Long>()

    fun onEvent(e: AospTouchModel.Ev) {
        if (e.ids.toSet().size != e.ids.size) {
            dropped += "ids duplicados: $e"
            return
        }
        events += e
        if (e.action == AospTouchModel.CANCEL) cancels++
        checkConsistency(e)
        for (v in listOf(strict, engine)) apply(v, e)
        for (id in e.ids) lastEventAt[id] = e.time
    }

    private fun checkConsistency(e: AospTouchModel.Ev) {
        val v = strict
        val before = v.fingers.keys.toSet()
        val ids = e.ids.toSet()
        when (e.action) {
            AospTouchModel.DOWN -> if (before.isNotEmpty()) inconsistencies += "DOWN com dedos já no chão $before: $e"
            AospTouchModel.PDOWN -> {
                val nid = e.ids.getOrNull(e.index)
                if (nid == null || nid in before || ids - setOf(nid) != before) inconsistencies += "POINTER_DOWN inconsistente (antes $before): $e"
            }
            AospTouchModel.MOVE -> if (ids != before) inconsistencies += "MOVE com ids $ids != $before: $e"
            AospTouchModel.PUP, AospTouchModel.UP -> if (ids != before || e.index !in e.ids.indices) inconsistencies += "UP inconsistente (antes $before): $e"
        }
    }

    private fun began(v: View, id: Int, x: Int, y: Int) {
        val existed = id in v.fingers
        v.fingers[id] = x to y
        if (!existed && v.joyId == null && hypot((x - joyX).toDouble(), (y - joyY).toDouble()) <= zoneRadius) {
            v.joyId = id
            if (floating) { v.baseX = x; v.baseY = y } else { v.baseX = joyX; v.baseY = joyY }
        }
    }

    private fun ended(v: View, id: Int) {
        v.fingers.remove(id)
        if (v.joyId == id) { v.joyId = null; v.joyReleases++ }
    }

    private fun apply(v: View, e: AospTouchModel.Ev) {
        when (e.action) {
            AospTouchModel.DOWN, AospTouchModel.PDOWN -> {
                for (i in e.ids.indices) if (i != e.index) v.fingers[e.ids[i]]?.let { v.fingers[e.ids[i]] = e.xs[i] to e.ys[i] }
                began(v, e.ids[e.index], e.xs[e.index], e.ys[e.index])
            }
            AospTouchModel.MOVE -> for (i in e.ids.indices) {
                if (v === engine && e.ids[i] !in v.fingers) began(v, e.ids[i], e.xs[i], e.ys[i]) else v.fingers[e.ids[i]] = e.xs[i] to e.ys[i]
            }
            AospTouchModel.UP, AospTouchModel.PUP -> ended(v, e.ids[e.index])
            AospTouchModel.CANCEL -> if (v === strict) for (id in v.fingers.keys.toList()) ended(v, id) else for (id in e.ids) ended(v, id)
        }
    }

    /** Leitura do joystick (-1..1 em x e y), ou null se nenhum dedo o segura. */
    fun joystick(v: View): Pair<Double, Double>? {
        val id = v.joyId ?: return null
        val (x, y) = v.fingers[id] ?: return null
        val dx = (x - v.baseX).toDouble() / joyRadius
        val dy = (y - v.baseY).toDouble() / joyRadius
        val m = maxOf(1.0, hypot(dx, dy))
        return dx / m to dy / m
    }
}

/**
 * Laço do injetor como no [TouchInjector] (uma thread, um gesture em voo, `pump` depois de cada entrada/callback e
 * no `wakeAt`), ligado ao [AospTouchModel] e ao [FakeGame]. Relógio em ms.
 */
class AospSim(
    val planner: TouchPlanner = TouchPlanner(maxStrokes = 20),
    val w: Int = 2712, val h: Int = 1220,
    sampleMs: Int = 8,
    floating: Boolean = false,
) {
    var now = 0L
    private class Task(val at: Long, val order: Long, val f: () -> Unit)
    private var order = 0L
    private val tasks = PriorityQueue<Task>(compareBy<Task>({ it.at }, { it.order }))
    fun at(t: Long, f: () -> Unit) { tasks.add(Task(maxOf(t, now), order++, f)) }

    val model = AospTouchModel(sampleMs)
    val joyC = (0.14f * (w - 1)).roundToInt() to (0.68f * (h - 1)).roundToInt()
    val joyR = (0.16f * minOf(w, h)).roundToInt()
    val game = FakeGame(joyC.first, joyC.second, joyR, (0.18f * minOf(w, h)).roundToInt(), floating)

    private val strokes = arrayOfNulls<AospTouchModel.Stroke>(TouchPlanner.MAX_POINTERS)
    private var current: Any? = null
    var dispatched = 0
    var cancelledCallbacks = 0
    val buildErrors = ArrayList<String>()
    /** Início de cada gesture despachado (para medir lacunas). */
    val dispatchTimes = ArrayList<Long>()

    init {
        planner.setBounds(w - 1, h - 1)
        model.schedule = { t, f -> at(t, f) }
        model.onEvent = { game.onEvent(it) }
    }

    fun pump() {
        if (planner.inFlight) return
        val g = planner.plan(now) ?: return
        val built = ArrayList<AospTouchModel.Stroke>()
        val next = strokes.copyOf()
        try {
            for (s in g.segments) {
                val st = if (s.continues) {
                    val prev = strokes[s.pointer] ?: error("sem stroke anterior p=${s.pointer}")
                    model.continueStroke(prev, s.fromX, s.fromY, s.toX, s.toY, s.startMs, s.durationMs, s.willContinue)
                } else model.newStroke(s.fromX, s.fromY, s.toX, s.toY, s.startMs, s.durationMs, s.willContinue)
                built += st
                next[s.pointer] = st
            }
        } catch (e: Exception) {
            buildErrors += "t=$now $e $g"
            planner.cancelled(now)
            return
        }
        for (i in next.indices) strokes[i] = next[i]
        val token = Any()
        current = token
        dispatched++
        dispatchTimes += now
        model.inject(built, now) { ok ->
            if (current === token) {
                current = null
                if (ok) planner.completed(now) else { cancelledCallbacks++; planner.cancelled(now) }
                pump()
            }
        }
    }

    // Entrada como o TouchInjector.apply (coordenadas normalizadas → px).
    private val lookIdleMs = 150L
    private var lookIdleAt = Long.MAX_VALUE
    fun packet(action: Int, pointer: Int, nx: Float, ny: Float, dx: Float = 0f, dy: Float = 0f, gen: Int = 0) {
        val x = nx * (w - 1)
        val y = ny * (h - 1)
        when (action) {
            InputProtocol.DOWN -> planner.down(pointer, x, y, now, gen, if (pointer == 9) 0 else planner.cfg.minTapMs)
            InputProtocol.MOVE -> planner.move(pointer, x, y, now)
            InputProtocol.UP -> planner.up(pointer, now, gen)
            InputProtocol.LOOK -> {
                planner.look(9, x, y, dx * h, dy * h, 0.22f * minOf(w, h), now)
                lookIdleAt = now + lookIdleMs
            }
            InputProtocol.RELEASE_ALL -> planner.releaseAll()
        }
        pump()
    }

    /** Avança [ms] milissegundos; [each] roda a cada ms (amostragem dos testes). */
    fun run(ms: Long, each: (AospSim) -> Unit = {}) {
        val end = now + ms
        while (now < end) {
            now++
            while (true) {
                val t = tasks.peek() ?: break
                if (t.at > now) break
                tasks.poll()
                t.f()
            }
            if (now >= lookIdleAt) {
                lookIdleAt = Long.MAX_VALUE
                planner.up(9, now)
                pump()
            }
            if (!planner.inFlight && planner.wakeAt(now) <= now) pump()
            each(this)
        }
    }
}

/**
 * O site (entrada v2) reimplementado em Kotlin para os testes do celular: gerações, cópias de DOWN/UP em 20/60 ms,
 * keepalive de 100 ms (DOWN(gen) com o ponto ORIGINAL + MOVE da posição atual se nenhum MOVE saiu), joystick que
 * encosta no centro e arrasta. Entrega pelo "USB" (ordenado, [latencyMs]).
 */
class FakeSite(val sim: AospSim, val latencyMs: Long = 2, val v2: Boolean = true) {
    private class Held(val gen: Int, val x: Float, val y: Float, var mx: Float, var my: Float, var moved: Boolean)
    private val held = HashMap<Int, Held>()
    private var gen = 0
    private var nextKeepalive = Long.MAX_VALUE
    val joyX = 0.14f
    val joyY = 0.68f
    val joyR = 0.16f
    val sent = ArrayList<String>()

    private fun send(a: Int, p: Int, x: Float, y: Float, dx: Float = 0f, dy: Float = 0f) {
        sent += "t=${sim.now} a=$a p=$p ($x,$y) $dx"
        sim.at(sim.now + latencyMs) { sim.packet(a, p, x, y, dx, dy, if (a == InputProtocol.DOWN || a == InputProtocol.UP) dx.toInt() else 0) }
    }

    private fun edge(a: Int, p: Int, x: Float, y: Float, g: Int) {
        send(a, p, x, y, g.toFloat())
        if (!v2) return
        for (d in listOf(20L, 60L)) sim.at(sim.now + d) { send(a, p, x, y, g.toFloat()) }
    }

    fun press(p: Int, x: Float, y: Float) {
        if (p in held) lift(p)
        val g = ++gen
        held[p] = Held(g, x, y, x, y, false)
        edge(InputProtocol.DOWN, p, x, y, if (v2) g else 0)
        syncKeepalive()
    }

    fun lift(p: Int) {
        val h = held.remove(p) ?: return
        edge(InputProtocol.UP, p, 0f, 0f, if (v2) h.gen else 0)
    }

    fun moveTo(p: Int, x: Float, y: Float) {
        val h = held[p] ?: return
        h.mx = x; h.my = y; h.moved = true
        send(InputProtocol.MOVE, p, x, y)
    }

    /** Joystick: vx/vy em -1..1 (0,0 = solta). Encosta no centro e arrasta, como o inputController.ts. */
    fun joystick(vx: Int, vy: Int) {
        if (vx == 0 && vy == 0) { lift(0); return }
        val len = hypot(vx.toFloat(), vy.toFloat())
        val aspect = sim.w.toFloat() / sim.h
        val x = joyX + vx / len * joyR / aspect
        val y = joyY + vy / len * joyR
        if (0 !in held) press(0, joyX, joyY)
        moveTo(0, x, y)
    }

    fun look(dx: Float, dy: Float) = send(InputProtocol.LOOK, 9, 0.62f, 0.45f, dx, dy)

    private fun syncKeepalive() {
        if (!v2) return
        if (nextKeepalive == Long.MAX_VALUE) {
            nextKeepalive = sim.now + 100
            sim.at(nextKeepalive) { keepalive() }
        }
    }

    private fun keepalive() {
        nextKeepalive = Long.MAX_VALUE
        if (held.isEmpty()) return
        for ((p, h) in held) {
            send(InputProtocol.DOWN, p, h.x, h.y, h.gen.toFloat())
            if ((h.mx != h.x || h.my != h.y) && !h.moved) send(InputProtocol.MOVE, p, h.mx, h.my)
            h.moved = false
        }
        syncKeepalive()
    }
}
