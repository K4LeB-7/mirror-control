package com.mirror.gamecontrol

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.roundToInt

/**
 * Planejador PURO (sem classes do Android, testado na JVM em TouchPlannerTest e AospInjectionTest) dos toques
 * injetados por `dispatchGesture`. O [TouchInjector] só traduz o plano em `StrokeDescription`/`GestureDescription`.
 *
 * Regras do Android que importam aqui (lidas do código do AOSP 14/15, `MotionEventInjector` e
 * `GestureDescription`; modeladas em AospTouchModel nos testes):
 * - Só UM gesture pode estar em voo; despachar outro antes do fim cancela o anterior.
 * - Um dedo "segurado" é uma cadeia de strokes: cada segmento `willContinue=true` continua o anterior
 *   (`continueStroke`). O dedo só LEVANTA (ACTION_UP) quando um segmento com `willContinue=false` termina.
 * - Um gesture que continua strokes tem de continuar TODOS os strokes abertos e começar EXATAMENTE onde eles
 *   pararam; senão o sistema cancela tudo. Por isso as coordenadas são inteiras e strokes NOVOS num gesture de
 *   continuação começam 1 ms depois (o 1º passo do gesture só pode ter continuações).
 * - **Um gesture que não gera nenhum MotionEvent é RECUSADO** (`events.isEmpty()` → onCancelled): continuar um dedo
 *   parado com um caminho de comprimento zero não gera MOVE. O planejador antigo (0.3.1) tratava a recusa como
 *   cancelamento e recomeçava os dedos como toques novos, e o sistema então mandava ACTION_CANCEL ao jogo e um
 *   DOWN novo — a cada ~270 ms com o joystick parado (bug "anda, para") e com os ids dos dedos re-atribuídos (bug
 *   "esquerda + pular anda para a direita"). Aqui todo gesture gera pelo menos um evento: dedos parados fazem um
 *   micro-movimento de [Config.keepAlivePx] px (vai e volta) quando nada mais no gesture mudaria.
 * - Ids de ponteiro do sistema: um id só volta a ficar livre quando TODOS os dedos injetados levantam; esgotados
 *   0..9, todo dedo novo recebe 10 (dois dedos com o mesmo id = eventos descartados ou dedos trocados no jogo). O
 *   planejador acompanha os ids previstos e, antes de um dedo novo colidir, levanta e re-encosta todos os dedos
 *   ("reciclagem", [Config.systemPointerIdCap]).
 *
 * Regras daqui:
 * - Um toque ([Press]) só sai do mapa depois que o seu segmento final (`willContinue=false`) foi despachado E
 *   completado. UP que chega com um gesture em voo apenas marca o toque; o final vai no próximo gesture.
 * - Duração mínima de um toque: [Config.minTapMs] (um clique curto vira um toque reconhecível, nunca "segurar").
 * - DOWN do mesmo ponteiro enquanto o toque anterior ainda termina entra numa fila: nunca é engolido nem herda o
 *   stroke antigo.
 * - Um toque novo encosta no ponto do DOWN e arrasta até a posição atual (DOWN+MOVE que chegam juntos não viram
 *   um toque direto no destino: um joystick "flutuante" leria zero). Depois de um cancelamento/reciclagem, toques
 *   "absolutos" (joystick, botões, mouse) recomeçam do ponto do DOWN; a câmera (relativa) recomeça onde estava.
 * - Dedo segurado recebe um segmento a cada [Config.holdPeriodMs] mesmo parado (fluxo contínuo de MOVE, como um
 *   dedo real; troca CPU x suavidade documentada em [Config] e nos perfis [FluidityProfile]). MOVE/UP com nada em voo
 *   despacham na hora.
 * - 0.3.3 (perfis): segmentos curtos — movimento direto ao destino em [Config.moveSegmentMs], renovação parada em
 *   [Config.holdSegmentMs], 1º segmento de botão em [Config.pressSegmentMs], toque mínimo esperado SEM gesture em voo
 *   ([Config.idleWait]) — para que um DOWN/UP novo quase nunca espere o gesture anterior (só um pode estar em voo).
 * - Strokes novos entram em ordem crescente de ponteiro do protocolo (joystick 0 primeiro): depois de um
 *   recomeço o sistema re-atribui ids na ordem dos strokes, então o joystick fica sempre com o menor id.
 * - Proteção contra UP perdido (canal WebRTC sem retransmissão): DOWN/UP do site novo trazem uma geração (gen);
 *   DOWN repetido com a mesma gen renova o toque ("keepalive") e, com o deadman ligado ([setDeadman]), um toque
 *   não renovado em `deadmanMs` é solto sozinho. UP/DOWN atrasados (gen menor) são ignorados.
 *
 * Coordenadas em px da tela (float na entrada; arredondadas no plano). Tempo em ms (relógio monotônico).
 * Não é thread-safe: use de uma thread só.
 */
class TouchPlanner(
    private val maxStrokes: Int = 20,
    cfg: Config = FluidityProfile.BALANCED.config(8),
) {
    /** Configuração atual (o perfil de fluidez pode trocá-la em tempo de execução: [setConfig]). */
    var cfg: Config = cfg
        private set

    /**
     * Valores padrão = comportamento da 0.3.2 (referência das medições, `Config()`); os perfis da 0.3.3 ficam em
     * [FluidityProfile].
     */
    data class Config(
        /** 1º segmento de um toque novo que ARRASTA (DOWN num ponto, destino em outro: joystick, arrasto). */
        val segmentMs: Long = 16,
        /**
         * 1º segmento de um toque novo PARADO (botão: DOWN e destino no mesmo ponto). O DOWN sai no início do
         * segmento; um segmento curto só libera mais cedo o próximo gesture (outra tecla apertada logo depois).
         */
        val pressSegmentMs: Long = 16,
        /** Segmento de movimento de um dedo já no chão (o destino novo é entregue no FIM do segmento). */
        val moveSegmentMs: Long = 16,
        /**
         * true (0.3.3): enquanto um toque solto espera o [minTapMs], nada fica em voo por causa dele (o final sai
         * perto do fim do mínimo), então outra tecla não espera; false (0.3.2): o toque fica num segmento longo.
         */
        val idleWait: Boolean = false,
        /** Duração mínima de um toque, do 1º segmento até o fim do final (clique curto continua sendo clique). */
        val minTapMs: Long = 50,
        /** Menor duração do segmento final. */
        val finalMs: Long = 8,
        /**
         * Dedo segurado e parado: um segmento novo a cada N ms (do início de um ao início do próximo).
         * Troca CPU x suavidade: 16 (padrão) ≈ 60 gestures/s e um MOVE a cada ~16 ms por dedo segurado, como a 0.3.0
         * e como um dedo real; 33 ≈ 30/s (metade da CPU); 250 = modo econômico da 0.3.1 (agora sem o bug, graças ao
         * micro-movimento, mas o jogo fica até 250 ms sem eventos do dedo). Negativo = nunca renova.
         */
        val holdPeriodMs: Long = 16,
        /** Duração do segmento de manutenção de dedos parados. */
        val holdSegmentMs: Long = 16,
        /** Micro-movimento (px) que garante pelo menos um MotionEvent em gestures só de dedos parados. */
        val keepAlivePx: Int = 1,
        /** Atraso de um stroke novo num gesture que continua outros (ver doc da classe). */
        val newStrokeDelayMs: Long = 1,
        /** Toques enfileirados por ponteiro (DOWN/UP muito rápidos), além do atual. */
        val maxQueued: Int = 4,
        /** Recuo depois de um cancelamento (dobra a cada cancelamento seguido, até [maxBackoffMs]). */
        val cancelBackoffMs: Long = 16,
        val maxBackoffMs: Long = 256,
        /** Teto dos ids de ponteiro do MotionEventInjector (10 no AOSP 8..15). 0 = não prevê nem recicla. */
        val systemPointerIdCap: Int = 10,
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
        /** Gera algum MotionEvent no sistema (DOWN, UP ou movimento). */
        val producesEvent: Boolean get() = !continues || !willContinue || fromX != toX || fromY != toY

        override fun toString() =
            "Seg(p=$pointer ${if (continues) "cont" else "new"} ($fromX,$fromY)->($toX,$toY) t=$startMs+$durationMs ${if (willContinue) "…" else "END"})"
    }

    class Gesture(val segments: List<Segment>, val recycle: Boolean = false) {
        val durationMs: Long get() = segments.maxOf { it.startMs + it.durationMs }
        override fun toString() = (if (recycle) "RECICLA " else "") + segments.toString()
    }

    private class Press(var tx: Float, var ty: Float, val gen: Int, val minHoldMs: Long, now: Long, val relative: Boolean = false) {
        /** Ponto do DOWN (um toque novo/recomeçado encosta aqui e arrasta até (tx, ty)). */
        val ox = tx
        val oy = ty
        var started = false     // algum segmento já foi despachado
        var open = false        // cadeia aberta no Android (último segmento completou com willContinue=true)
        var restarted = false   // recomeça depois de cancelamento/reciclagem
        var recycling = false   // o segmento em voo é o final de uma reciclagem (o toque continua depois)
        var lastX = 0           // fim do último segmento completado
        var lastY = 0
        var up = false          // UP pedido (ou RELEASE_ALL / deadman)
        var firstAt = 0L        // início do 1º segmento
        var lastSegmentAt = 0L  // início do último segmento despachado
        var lastRefresh = now   // último DOWN/MOVE da rede (deadman)
        var sysId = -1          // id de ponteiro previsto no sistema
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
    /** Ids de ponteiro que o sistema considera usados na sequência atual (só ficam livres quando todos levantam). */
    private val sysUsed = BooleanArray(maxOf(1, cfg.systemPointerIdCap + 1))
    private val sysScratch = BooleanArray(sysUsed.size)
    private val liveScratch = BooleanArray(sysUsed.size)

    /**
     * Troca a configuração (perfil de fluidez) em tempo de execução. Seguro a qualquer momento: só muda durações e
     * cadências dos PRÓXIMOS segmentos (o teto de ids do sistema não muda).
     */
    fun setConfig(c: Config) {
        cfg = c.copy(systemPointerIdCap = cfg.systemPointerIdCap)
    }
    private var recycleNeeded = false

    var inFlight = false
        private set

    /** Contadores (diagnóstico/medições). */
    var gestures = 0L
        private set
    var segments = 0L
        private set
    var recycles = 0L
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
            p = enqueue(id, Press(ax, ay, 0, 0, now, relative = true)) ?: return
        }
        p.tx = (p.tx + dx).coerceIn(0f, maxX.toFloat())
        p.ty = (p.ty + dy).coerceIn(0f, maxY.toFloat())
        p.lastRefresh = now
        if (hypot(p.tx - lookAnchorX, p.ty - lookAnchorY) > zone) {
            p.up = true
            enqueue(id, Press(lookAnchorX, lookAnchorY, 0, 0, now, relative = true))
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
        dropFinishedRestarts(now)
        var heads = 0
        var open = 0
        for (id in 0 until MAX_POINTERS) {
            val p = queues[id]?.firstOrNull() ?: continue
            heads++
            if (p.open) open++
        }
        if (heads == 0) {
            recycleNeeded = false
            return null
        }
        if (open == 0) {
            // nenhum dedo injetado no chão: o sistema começa uma sequência nova (ids livres de novo)
            sysUsed.fill(false)
            recycleNeeded = false
        }
        if (recycleNeeded) return dispatch(planRecycle(now), now, recycle = true)

        val alone = heads == 1 && !cfg.idleWait
        val out = ArrayList<Segment>(heads)
        var needed = false
        var strokes = 0
        // 1º os strokes abertos (TODOS precisam ser continuados), depois os novos (em ordem crescente de ponteiro).
        for (pass in 0..1) {
            for (id in 0 until MAX_POINTERS) {
                val p = queues[id]?.firstOrNull() ?: continue
                if ((pass == 0) != p.open) continue
                if (strokes >= maxStrokes) break
                val tx = clampX(p.tx)
                val ty = clampY(p.ty)
                val seg: Segment
                if (p.open) {
                    if (p.up && cfg.idleWait) {
                        val remaining = p.minHoldMs - (now - p.firstAt)
                        if (remaining <= cfg.finalMs) {
                            seg = Segment(id, p.lastX, p.lastY, tx, ty, 0, maxOf(cfg.finalMs, remaining), false, true)
                            needed = true
                        } else if (!atRest(p, tx, ty)) {
                            seg = Segment(id, p.lastX, p.lastY, tx, ty, 0, minOf(cfg.moveSegmentMs, remaining - cfg.finalMs), true, true)
                            needed = true
                        } else {
                            // espera o mínimo do toque SEM gesture em voo (o final sai em wakeAt); se outro dedo
                            // precisar de um gesture antes, este só é continuado parado
                            seg = Segment(id, p.lastX, p.lastY, p.lastX, p.lastY, 0, cfg.holdSegmentMs, true, true)
                        }
                    } else if (p.up) {
                        val remaining = p.minHoldMs - (now - p.firstAt)
                        seg = if (remaining <= cfg.segmentMs || alone) {
                            Segment(id, p.lastX, p.lastY, tx, ty, 0, maxOf(cfg.finalMs, remaining), false, true)
                        } else {
                            // segura até o mínimo do toque sem travar os outros dedos por muito tempo
                            Segment(id, p.lastX, p.lastY, tx, ty, 0, cfg.segmentMs, true, true)
                        }
                        needed = true
                    } else if (!atRest(p, tx, ty)) {
                        seg = Segment(id, p.lastX, p.lastY, tx, ty, 0, cfg.moveSegmentMs, true, true)
                        needed = true
                    } else {
                        if (cfg.holdPeriodMs >= 0 && now - p.lastSegmentAt >= cfg.holdPeriodMs) needed = true
                        seg = Segment(id, p.lastX, p.lastY, p.lastX, p.lastY, 0, cfg.holdSegmentMs, true, true)
                    }
                } else {
                    val start = if (open > 0) cfg.newStrokeDelayMs else 0L
                    // Encosta no ponto do DOWN e arrasta até o destino (a câmera recomeçada fica onde estava).
                    val fx = if (p.relative && p.restarted) tx else clampX(p.ox)
                    val fy = if (p.relative && p.restarted) ty else clampY(p.oy)
                    val first = if (fx == tx && fy == ty) cfg.pressSegmentMs else cfg.segmentMs
                    seg = if (p.up && (alone || (cfg.idleWait && p.minHoldMs <= first))) {
                        // DOWN e UP já chegaram: um toque completo num stroke só
                        Segment(id, fx, fy, tx, ty, start, maxOf(cfg.finalMs, p.minHoldMs), false, false)
                    } else {
                        Segment(id, fx, fy, tx, ty, start, first, true, false)
                    }
                    needed = true
                }
                out.add(seg)
                strokes++
            }
        }
        if (!needed) return null
        avoidEndAtNewStrokeStart(out)
        if (open > 0 && !assignSystemIds(out, commit = false)) {
            // Um dedo novo receberia um id já usado por outro dedo no chão: levanta e re-encosta todos antes.
            recycleNeeded = true
            recycles++
            return dispatch(planRecycle(now), now, recycle = true)
        }
        assignSystemIds(out, commit = true)
        return dispatch(ensureEvent(out), now, recycle = false)
    }

    /**
     * Toque re-encostado por reciclagem/cancelamento cujo UP chegou antes de ele voltar ao chão e cujo pedaço já
     * entregue durou o bastante para um jogo a 30 fps vê-lo ([VISIBLE_TAP_MS]): não volta a encostar. A 0.3.2 o
     * re-pressionava por mais [Config.minTapMs] — um 2º toque que o usuário não fez (pulo duplo) e um UP atrasado.
     */
    private fun dropFinishedRestarts(now: Long) {
        if (!cfg.idleWait) return
        for (id in 0 until MAX_POINTERS) {
            val q = queues[id] ?: continue
            val p = q.firstOrNull() ?: continue
            if (p.restarted && p.up && !p.started && p.flight == null && now - p.firstAt >= minOf(p.minHoldMs, VISIBLE_TAP_MS)) q.removeFirst()
        }
    }

    /** Fim de todos os dedos no chão (UP de verdade); os que continuam segurados recomeçam no próximo gesture. */
    private fun planRecycle(now: Long): List<Segment> {
        val out = ArrayList<Segment>()
        for (id in 0 until MAX_POINTERS) {
            val p = queues[id]?.firstOrNull() ?: continue
            if (!p.open) continue
            val dur = if (p.up) maxOf(cfg.finalMs, p.minHoldMs - (now - p.firstAt)) else cfg.finalMs
            p.recycling = !p.up
            out.add(Segment(id, p.lastX, p.lastY, clampX(p.tx), clampY(p.ty), 0, dur, false, true))
        }
        return out
    }

    private fun dispatch(out: List<Segment>, now: Long, recycle: Boolean): Gesture? {
        if (out.isEmpty()) {
            recycleNeeded = false
            return null
        }
        for (s in out) {
            val p = queues[s.pointer]!!.first()
            p.flight = s
            p.lastSegmentAt = now
            if (!p.started) {
                p.started = true
                // Re-encostado (reciclagem/cancelamento) nos perfis 0.3.3: o toque mínimo conta do 1º DOWN de verdade
                // (a 0.3.2 recomeçava a contagem: um UP que chegava logo depois esperava mais 50 ms).
                if (!(p.restarted && cfg.idleWait)) p.firstAt = now + s.startMs
            }
        }
        inFlight = true
        gestures++
        segments += out.size
        return Gesture(out, recycle)
    }

    /**
     * Gesture só de dedos parados não gera MotionEvent e o sistema o recusa: o 1º dedo parado faz o micro-movimento
     * (vai [Config.keepAlivePx] px e volta no próximo; um MOVE basta para o gesture valer).
     */
    private fun ensureEvent(out: ArrayList<Segment>): List<Segment> {
        if (out.any { it.producesEvent }) return out
        for ((i, s) in out.withIndex()) {
            val p = queues[s.pointer]!!.first()
            val ax = clampX(p.tx)
            val ay = clampY(p.ty)
            val (nx, ny) = if (s.fromX != ax || s.fromY != ay) {
                ax to ay // volta ao ponto exato
            } else {
                val d = cfg.keepAlivePx.coerceAtLeast(1)
                when {
                    ax + d <= maxX -> (ax + d) to ay
                    ax - d >= 0 -> (ax - d) to ay
                    ay + d <= maxY -> ax to (ay + d)
                    ay - d >= 0 -> ax to (ay - d)
                    else -> continue
                }
            }
            out[i] = Segment(s.pointer, s.fromX, s.fromY, nx, ny, s.startMs, s.durationMs, s.willContinue, s.continues)
            return out
        }
        return out
    }

    /**
     * AOSP: o índice do POINTER_DOWN é a posição do stroke no PASSO (não na lista de dedos). Se um stroke termina no
     * mesmo instante em que um novo começa, o passo ainda tem o que terminou e o índice aponta para o dedo errado
     * (ou para fora do evento, que o InputDispatcher descarta). Segmentos curtos (perfis 0.3.3) podiam terminar em
     * t = [Config.newStrokeDelayMs]: estende esses em 1 ms.
     */
    private fun avoidEndAtNewStrokeStart(out: ArrayList<Segment>) {
        var start = -1L
        for (s in out) if (!s.continues) { start = s.startMs; break }
        if (start <= 0) return
        for ((i, s) in out.withIndex()) {
            if (s.continues && s.startMs + s.durationMs == start) {
                out[i] = Segment(s.pointer, s.fromX, s.fromY, s.toX, s.toY, s.startMs, s.durationMs + 1, s.willContinue, s.continues)
            }
        }
    }

    /**
     * Prevê os ids que o sistema dará aos strokes novos (menor id livre na sequência; esgotados 0..cap-1, todos
     * recebem cap). false = algum colidiria com um dedo no chão ou com outro novo.
     */
    private fun assignSystemIds(out: List<Segment>, commit: Boolean): Boolean {
        val cap = cfg.systemPointerIdCap
        if (cap <= 0) return true
        // Sem alocar por gesture (0.3.3): buffers reaproveitados em vez de copyOf + HashSet.
        val used = if (commit) sysUsed else sysScratch.also { sysUsed.copyInto(it) }
        val live = liveScratch
        live.fill(false)
        for (id in 0 until MAX_POINTERS) {
            val p = queues[id]?.firstOrNull() ?: continue
            if (p.open && p.sysId >= 0 && p.sysId < live.size) live[p.sysId] = true
        }
        for (s in out) {
            if (s.continues) continue
            var sid = 0
            while (sid < cap && used[sid]) sid++
            if (live[sid]) return false
            live[sid] = true
            used[sid] = true
            if (commit) queues[s.pointer]!!.first().sysId = sid
        }
        return true
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
                if (p.recycling && !p.up) restart(p) else q.removeFirst() // levantou de verdade: só agora sai do mapa
                p.recycling = false
            } else {
                p.open = true
                p.lastX = s.toX
                p.lastY = s.toY
            }
        }
    }

    /**
     * O sistema cancelou o gesture (toque real na tela, outro gesture…): as cadeias abertas morreram. Toques que já
     * deviam levantar terminam aqui; os segurados recomeçam como toque novo (com recuo para não girar em falso).
     */
    fun cancelled(now: Long) {
        inFlight = false
        recycleNeeded = false
        for (id in 0 until MAX_POINTERS) {
            val q = queues[id] ?: continue
            val p = q.firstOrNull() ?: continue
            val s = p.flight
            p.flight = null
            val recycling = p.recycling
            p.recycling = false
            if (!p.started) continue
            if (p.up || (s != null && !s.willContinue && !recycling)) {
                q.removeFirst()
            } else {
                restart(p)
            }
        }
        cancels++
        backoffUntil = now + minOf(cfg.maxBackoffMs, cfg.cancelBackoffMs shl minOf(cancels - 1, 10))
    }

    /** dispatchGesture recusou (serviço desligado): esquece tudo. */
    fun dispatchFailed() {
        inFlight = false
        recycleNeeded = false
        for (q in queues) q?.clear()
    }

    /**
     * Quando chamar [plan] de novo se nada acontecer antes (renovação de dedo parado, deadman, recuo);
     * Long.MAX_VALUE = só quando chegar entrada ou o gesture em voo terminar.
     */
    fun wakeAt(now: Long): Long {
        if (inFlight) return Long.MAX_VALUE
        var at = Long.MAX_VALUE
        if (recycleNeeded) at = now
        for (id in 0 until MAX_POINTERS) {
            val q = queues[id] ?: continue
            val p = q.firstOrNull() ?: continue
            val rest = atRest(p, clampX(p.tx), clampY(p.ty))
            if (p.up && p.open && cfg.idleWait && rest) {
                // toque solto esperando o mínimo: o final sai [finalMs] antes do fim do mínimo
                at = minOf(at, maxOf(now, p.firstAt + p.minHoldMs - cfg.finalMs))
            } else if (!p.open || p.up || !p.started || !rest) at = minOf(at, now) // há trabalho já
            else if (cfg.holdPeriodMs >= 0) at = minOf(at, p.lastSegmentAt + cfg.holdPeriodMs)
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

    /** No destino, ou a [Config.keepAlivePx] dele (micro-movimento): não precisa de segmento de movimento. */
    private fun atRest(p: Press, tx: Int, ty: Int): Boolean {
        val dx = abs(p.lastX - tx)
        val dy = abs(p.lastY - ty)
        return dx + dy <= cfg.keepAlivePx
    }

    private fun restart(p: Press) {
        p.started = false
        p.open = false
        p.restarted = true
        p.sysId = -1
    }

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
        /** Um quadro de um jogo a 30 fps (+ folga): toque que já durou isso foi visto pelo jogo. */
        const val VISIBLE_TAP_MS = 34L
    }
}
