package com.mirror.gamecontrol

import kotlin.math.hypot
import kotlin.math.roundToInt

/**
 * Planejador PURO (sem classes do Android, testado na JVM em TouchPlannerTest) dos toques injetados por
 * `dispatchGesture`. O [TouchInjector] só traduz o plano em `StrokeDescription`/`GestureDescription`.
 *
 * Modelo do Android (MotionEventInjector):
 * - Só UM gesture pode estar em voo; despachar outro antes do fim cancela o anterior.
 * - Um dedo "segurado" é uma cadeia de strokes: cada segmento `willContinue=true` continua o anterior
 *   (`continueStroke`). O dedo só LEVANTA (ACTION_UP) quando um segmento com `willContinue=false` termina.
 *   Sem esse segmento final o ponteiro fica pressionado no Android.
 * - Um gesture que continua strokes tem de continuar TODOS os strokes abertos e começar EXATAMENTE onde eles
 *   pararam; senão o sistema cancela tudo. Por isso as coordenadas são inteiras (sem erro de arredondamento) e
 *   strokes NOVOS num gesture de continuação começam 1 ms depois (o 1º passo do gesture só tem continuações).
 *
 * Regras daqui:
 * - Um toque ([Press]) só sai do mapa depois que o seu segmento final (`willContinue=false`) foi despachado E
 *   completado. UP que chega com um gesture em voo apenas marca o toque; o final vai no próximo gesture.
 * - Duração mínima de um toque: [Config.minTapMs] (um clique curto vira um toque reconhecível, nunca "segurar").
 * - DOWN do mesmo ponteiro enquanto o toque anterior ainda termina entra numa fila: nunca é engolido nem herda o
 *   stroke antigo.
 * - Dedo parado não gera gestures: só um segmento curto de "renovação" a cada [Config.idleRefreshMs] (detecta uma
 *   cadeia cortada pelo sistema, ex. o usuário tocou na tela). MOVE/UP com nada em voo despacham na hora.
 * - Proteção contra UP perdido (canal WebRTC sem retransmissão): DOWN/UP do site novo trazem uma geração (gen);
 *   DOWN repetido com a mesma gen renova o toque ("keepalive") e, com o deadman ligado ([setDeadman]), um toque
 *   não renovado em `deadmanMs` é solto sozinho. UP/DOWN atrasados (gen menor) são ignorados.
 *
 * Coordenadas em px da tela (float na entrada; arredondadas no plano). Tempo em ms (relógio monotônico).
 * Não é thread-safe: use de uma thread só.
 */
class TouchPlanner(
    private val maxStrokes: Int = 20,
    val cfg: Config = Config(),
) {
    data class Config(
        /** Duração de um segmento normal (movimento, 1º segmento de um toque). */
        val segmentMs: Long = 16,
        /** Duração mínima de um toque, do 1º segmento até o fim do final (clique curto continua sendo clique). */
        val minTapMs: Long = 50,
        /** Menor duração do segmento final. */
        val finalMs: Long = 8,
        /** Dedo parado: intervalo entre segmentos de renovação (0 = desligado). */
        val idleRefreshMs: Long = 250,
        /** Duração do segmento de renovação/de dedos parados que acompanham um gesture. */
        val holdSegmentMs: Long = 8,
        /** Atraso de um stroke novo num gesture que continua outros (ver doc da classe). */
        val newStrokeDelayMs: Long = 1,
        /** Toques enfileirados por ponteiro (DOWN/UP muito rápidos), além do atual. */
        val maxQueued: Int = 4,
        /** Recuo depois de um cancelamento (dobra a cada cancelamento seguido, até [maxBackoffMs]). */
        val cancelBackoffMs: Long = 16,
        val maxBackoffMs: Long = 256,
    )

    class Segment(
        val pointer: Int,
        val fromX: Int, val fromY: Int,
        val toX: Int, val toY: Int,
        val startMs: Long,
        val durationMs: Long,
        val willContinue: Boolean,
        /** true = continua o stroke anterior deste ponteiro (`continueStroke`); false = stroke novo. */
        val continues: Boolean,
    ) {
        override fun toString() =
            "Seg(p=$pointer ${if (continues) "cont" else "new"} ($fromX,$fromY)->($toX,$toY) t=$startMs+$durationMs ${if (willContinue) "…" else "END"})"
    }

    class Gesture(val segments: List<Segment>) {
        val durationMs: Long get() = segments.maxOf { it.startMs + it.durationMs }
        override fun toString() = segments.toString()
    }

    private class Press(var tx: Float, var ty: Float, val gen: Int, val minHoldMs: Long, now: Long) {
        var started = false     // algum segmento já foi despachado
        var open = false        // cadeia aberta no Android (último segmento completou com willContinue=true)
        var lastX = 0           // fim do último segmento completado
        var lastY = 0
        var up = false          // UP pedido (ou RELEASE_ALL / deadman)
        var firstAt = 0L        // início do 1º segmento
        var lastDispatchAt = 0L // fim do último segmento completado
        var lastRefresh = now   // último DOWN/MOVE da rede (deadman)
        var flight: Segment? = null
    }

    private val queues = arrayOfNulls<ArrayDeque<Press>>(MAX_POINTERS)
    private val lastGen = IntArray(MAX_POINTERS)
    private val ended = BooleanArray(MAX_POINTERS)
    private var maxX = Int.MAX_VALUE
    private var maxY = Int.MAX_VALUE
    private var lookAnchorX = 0f
    private var lookAnchorY = 0f
    private var deadmanMs = 0L
    private var backoffUntil = 0L
    private var cancels = 0

    var inFlight = false
        private set

    /** Contadores (diagnóstico/medições). */
    var gestures = 0L
        private set
    var segments = 0L
        private set

    // ------------------------------------------------------------------ entrada

    /** Limites da tela (px, inclusive). Coordenadas fora são presas aqui (Path com coordenada negativa lança). */
    fun setBounds(maxX: Int, maxY: Int) {
        this.maxX = maxOf(0, maxX)
        this.maxY = maxOf(0, maxY)
    }

    /** 0 desliga. Só vale para toques com gen > 0 (site que manda keepalive). */
    fun setDeadman(ms: Long) {
        deadmanMs = if (ms <= 0) 0 else ms
    }

    /**
     * Nova conexão: solta tudo e esquece as gerações (o site novo recomeça a contagem). O deadman continua como
     * está: ele só age em toques com gen > 0, que só o site novo (que manda keepalive) produz.
     */
    fun resetSession() {
        releaseAll()
        lastGen.fill(0)
        ended.fill(false)
    }

    fun down(id: Int, x: Float, y: Float, now: Long, gen: Int = 0, minHoldMs: Long = cfg.minTapMs) {
        if (id !in 0 until MAX_POINTERS) return
        val live = livePress(id)
        if (gen > 0) {
            if (gen < lastGen[id]) return // DOWN atrasado de um toque antigo
            if (gen == lastGen[id]) {
                if (ended[id]) return // repetição de um toque que já terminou
                if (live != null && live.gen == gen) {
                    live.lastRefresh = now // keepalive
                    return
                }
                // mesmo toque, mas o deadman o soltou (rede engasgou): volta a pressionar
            } else {
                lastGen[id] = gen
                ended[id] = false
                live?.up = true // o UP do toque anterior se perdeu: solta antes do novo
            }
        } else if (live != null) {
            return // protocolo antigo: DOWN repetido de um dedo já pressionado é ignorado
        }
        enqueue(id, Press(x, y, gen, minHoldMs, now))
    }

    fun move(id: Int, x: Float, y: Float, now: Long) {
        if (id !in 0 until MAX_POINTERS) return
        val p = livePress(id) ?: return
        p.tx = x
        p.ty = y
        p.lastRefresh = now
    }

    fun up(id: Int, now: Long, gen: Int = 0) {
        if (id !in 0 until MAX_POINTERS) return
        if (gen > 0) {
            if (gen < lastGen[id]) return // UP atrasado: não solta um toque mais novo
            lastGen[id] = gen
            ended[id] = true
        }
        livePress(id)?.up = true
    }

    /** Solta tudo: toques em andamento recebem o segmento final; os que ainda não começaram são descartados. */
    fun releaseAll() {
        for (id in 0 until MAX_POINTERS) {
            val q = queues[id] ?: continue
            ended[id] = true
            while (q.size > 1) q.removeLast()
            val head = q.firstOrNull() ?: continue
            if (!head.started && head.flight == null) q.clear() else head.up = true
        }
    }

    /**
     * Câmera: dedo que desliza a partir da âncora ([ax],[ay]) por ([dx],[dy]) px. Saindo da zona ([zone] px), o dedo
     * levanta e um novo toque começa na âncora (como levantar o dedo e voltar ao centro).
     */
    fun look(id: Int, ax: Float, ay: Float, dx: Float, dy: Float, zone: Float, now: Long) {
        if (id !in 0 until MAX_POINTERS) return
        var p = livePress(id)
        if (p == null) {
            lookAnchorX = ax
            lookAnchorY = ay
            p = enqueue(id, Press(ax, ay, 0, 0, now)) ?: return
        }
        p.tx = (p.tx + dx).coerceIn(0f, maxX.toFloat())
        p.ty = (p.ty + dy).coerceIn(0f, maxY.toFloat())
        p.lastRefresh = now
        if (hypot(p.tx - lookAnchorX, p.ty - lookAnchorY) > zone) {
            p.up = true
            enqueue(id, Press(lookAnchorX, lookAnchorY, 0, 0, now))
        }
    }

    // ------------------------------------------------------------------ plano

    /**
     * Próximo gesture a despachar agora, ou null (nada a fazer, ou um gesture ainda em voo). Marca o gesture como
     * em voo: depois chame [completed], [cancelled] ou [dispatchFailed].
     */
    fun plan(now: Long): Gesture? {
        if (inFlight || now < backoffUntil) return null
        expireDeadman(now)
        var heads = 0
        var open = 0
        for (id in 0 until MAX_POINTERS) {
            val p = queues[id]?.firstOrNull() ?: continue
            heads++
            if (p.open) open++
        }
        if (heads == 0) return null
        val alone = heads == 1
        val out = ArrayList<Segment>(heads)
        var needed = false
        var strokes = 0
        // 1º os strokes abertos (TODOS precisam ser continuados), depois os novos.
        for (pass in 0..1) {
            for (id in 0 until MAX_POINTERS) {
                val p = queues[id]?.firstOrNull() ?: continue
                if ((pass == 0) != p.open) continue
                if (strokes >= maxStrokes) break
                val tx = clampX(p.tx)
                val ty = clampY(p.ty)
                val seg: Segment
                if (p.open) {
                    val moved = tx != p.lastX || ty != p.lastY
                    if (p.up) {
                        val remaining = p.minHoldMs - (now - p.firstAt)
                        seg = if (remaining <= cfg.segmentMs || alone) {
                            Segment(id, p.lastX, p.lastY, tx, ty, 0, maxOf(cfg.finalMs, remaining), false, true)
                        } else {
                            // segura até o mínimo do toque sem travar os outros dedos por muito tempo
                            Segment(id, p.lastX, p.lastY, tx, ty, 0, cfg.segmentMs, true, true)
                        }
                        needed = true
                    } else if (moved) {
                        seg = Segment(id, p.lastX, p.lastY, tx, ty, 0, cfg.segmentMs, true, true)
                        needed = true
                    } else {
                        val refresh = cfg.idleRefreshMs > 0 && now - p.lastDispatchAt >= cfg.idleRefreshMs
                        if (refresh) needed = true
                        seg = Segment(id, p.lastX, p.lastY, tx, ty, 0, cfg.holdSegmentMs, true, true)
                    }
                } else {
                    val start = if (open > 0) cfg.newStrokeDelayMs else 0L
                    seg = if (p.up && alone) {
                        // DOWN e UP já chegaram: um toque completo num stroke só
                        Segment(id, tx, ty, tx, ty, start, maxOf(cfg.finalMs, p.minHoldMs), false, false)
                    } else {
                        Segment(id, tx, ty, tx, ty, start, cfg.segmentMs, true, false)
                    }
                    needed = true
                }
                out.add(seg)
                strokes++
            }
        }
        if (!needed) return null
        for (s in out) {
            val p = queues[s.pointer]!!.first()
            p.flight = s
            if (!p.started) {
                p.started = true
                p.firstAt = now + s.startMs
            }
        }
        inFlight = true
        gestures++
        segments += out.size
        return Gesture(out)
    }

    /** O gesture em voo terminou normalmente. */
    fun completed(now: Long) {
        if (!inFlight) return
        inFlight = false
        cancels = 0
        for (id in 0 until MAX_POINTERS) {
            val q = queues[id] ?: continue
            val p = q.firstOrNull() ?: continue
            val s = p.flight ?: continue
            p.flight = null
            if (!s.willContinue) {
                q.removeFirst() // levantou de verdade: só agora sai do mapa
            } else {
                p.open = true
                p.lastX = s.toX
                p.lastY = s.toY
                p.lastDispatchAt = now
            }
        }
    }

    /**
     * O sistema cancelou o gesture (toque real na tela, outro gesture…): as cadeias abertas morreram. Toques que já
     * deviam levantar terminam aqui; os segurados recomeçam como toque novo (com recuo para não girar em falso).
     */
    fun cancelled(now: Long) {
        inFlight = false
        for (id in 0 until MAX_POINTERS) {
            val q = queues[id] ?: continue
            val p = q.firstOrNull() ?: continue
            val s = p.flight
            p.flight = null
            if (!p.started) continue
            if (p.up || (s != null && !s.willContinue)) {
                q.removeFirst()
            } else {
                p.started = false
                p.open = false
            }
        }
        cancels++
        backoffUntil = now + minOf(cfg.maxBackoffMs, cfg.cancelBackoffMs shl minOf(cancels - 1, 10))
    }

    /** dispatchGesture recusou (serviço desligado): esquece tudo. */
    fun dispatchFailed() {
        inFlight = false
        for (q in queues) q?.clear()
    }

    /**
     * Quando chamar [plan] de novo se nada acontecer antes (renovação de dedo parado, deadman, recuo);
     * Long.MAX_VALUE = só quando chegar entrada ou o gesture em voo terminar.
     */
    fun wakeAt(now: Long): Long {
        if (inFlight) return Long.MAX_VALUE
        var at = Long.MAX_VALUE
        for (id in 0 until MAX_POINTERS) {
            val q = queues[id] ?: continue
            val p = q.firstOrNull() ?: continue
            if (!p.open || p.up || !p.started || clampX(p.tx) != p.lastX || clampY(p.ty) != p.lastY) at = minOf(at, now) // há trabalho já
            else if (cfg.idleRefreshMs > 0) at = minOf(at, p.lastDispatchAt + cfg.idleRefreshMs)
            if (deadmanMs > 0) for (x in q) if (x.gen > 0 && !x.up) at = minOf(at, x.lastRefresh + deadmanMs + 1)
        }
        if (at != Long.MAX_VALUE && at < backoffUntil) at = backoffUntil
        return at
    }

    // ------------------------------------------------------------------ consultas (testes/diagnóstico)

    /** Ponteiro com toque vivo (não pedido para soltar) ou ainda pressionado no Android. */
    fun isActive(id: Int): Boolean = queues.getOrNull(id)?.isNotEmpty() == true

    fun isHeld(id: Int): Boolean = livePress(id) != null

    val activeCount: Int get() = queues.count { it?.isNotEmpty() == true }

    fun queued(id: Int): Int = queues.getOrNull(id)?.size ?: 0

    // ------------------------------------------------------------------ interno

    private fun livePress(id: Int): Press? {
        val q = queues[id] ?: return null
        val last = q.lastOrNull() ?: return null
        return if (last.up) null else last
    }

    private fun enqueue(id: Int, p: Press): Press? {
        val q = queues[id] ?: ArrayDeque<Press>(2).also { queues[id] = it }
        if (q.size > cfg.maxQueued) return null
        q.addLast(p)
        return p
    }

    private fun expireDeadman(now: Long) {
        if (deadmanMs <= 0) return
        for (q in queues) {
            if (q == null) continue
            for (p in q) if (p.gen > 0 && !p.up && now - p.lastRefresh > deadmanMs) p.up = true
        }
    }

    private fun clampX(v: Float): Int = v.roundToInt().coerceIn(0, maxX)
    private fun clampY(v: Float): Int = v.roundToInt().coerceIn(0, maxY)

    companion object {
        const val MAX_POINTERS = 16
    }
}
