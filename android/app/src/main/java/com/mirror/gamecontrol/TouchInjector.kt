package com.mirror.gamecontrol

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.accessibilityservice.GestureDescription.StrokeDescription
import android.graphics.Path
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.os.SystemClock
import android.util.Log

/**
 * Multitouch persistente sobre dispatchGesture(). As decisões (quando despachar, qual segmento de cada dedo, quando
 * um dedo levanta) ficam no [TouchPlanner] (puro, testado na JVM); aqui só montamos os StrokeDescription.
 *
 * Roda numa thread própria ("touch-injector", prioridade de display), não na main thread: a UI do app e o
 * RtcClient não atrasam toques, e vice-versa. AccessibilityService.dispatchGesture é sincronizado internamente.
 *
 * Com dedo segurado há um gesture a cada holdPeriodMs do perfil de fluidez ([FluidityProfile]; 16 ms no
 * Equilibrado): o jogo recebe um fluxo contínuo de MOVE, como de um dedo real. A cadência acompanha a taxa do display
 * (relida a cada 500 ms). [stats] alimenta a linha "Diagnóstico de toque" do app (contadores + latências).
 */
class TouchInjector(
    private val service: AccessibilityService,
    private val screen: () -> Pair<Int, Int>,
    /** Taxa de atualização atual do display (Hz). O AOSP gera os passos dos gestures a cada 1000/Hz ms. */
    private val refreshHz: () -> Float = { 60f },
) {
    private val thread = HandlerThread("touch-injector").apply { start() }
    private val handler = Handler(thread.looper)
    private val planner = TouchPlanner(maxStrokes = safeMaxStrokes())
    @Volatile private var closed = false

    /** Perfil de fluidez pedido pelo site (CTRL input.profile). Só na thread do injetor. */
    private var profile = FluidityProfile.BALANCED
    private var frameMs = 0

    // Fila de entrada (qualquer thread → injetor) sem alocar por pacote: anel sob trava + UM "drain" postado quando a
    // fila sai de vazia. O drain aplica TODOS os pacotes que já chegaram e só então planeja (teclas que chegam juntas
    // saem no mesmo gesture; 0.3.2 planejava a cada pacote).
    private val qLock = Any()
    private val qPackets = arrayOfNulls<InputProtocol.Packet>(QUEUE_CAP)
    private val qAt = LongArray(QUEUE_CAP)
    private var qHead = 0
    private var qSize = 0
    private var drainPosted = false
    private val batch = arrayOfNulls<InputProtocol.Packet>(QUEUE_CAP) // só na thread do injetor
    private val batchAt = LongArray(QUEUE_CAP)

    // Latência (ns, relógio monotônico; só na thread do injetor). 0 = nada pendente.
    private var pendingInputNs = 0L
    private val downPendingNs = LongArray(TouchPlanner.MAX_POINTERS)
    private var flightInputNs = 0L

    /** Contadores para o diagnóstico (escritos só nesta thread; lidos pela UI). */
    val stats = TouchStats()

    // Só na thread do injetor:
    private val strokes = arrayOfNulls<StrokeDescription>(TouchPlanner.MAX_POINTERS)
    private val paths = Array(TouchPlanner.MAX_POINTERS) { Path() }
    private val built = arrayOfNulls<StrokeDescription>(TouchPlanner.MAX_POINTERS)
    private var current: GestureDescription? = null
    private var currentAt = 0L
    private var wakeAt = Long.MAX_VALUE
    private var screenW = 0
    private var screenH = 0
    private var screenAt = 0L

    private val wake = Runnable {
        wakeAt = Long.MAX_VALUE
        pump()
    }
    private val drain = Runnable { drainInput() }
    /**
     * Callback que nunca chega (serviço desconectando, tela apagando, ROM que perde o callback) deixaria o
     * planejador "em voo" para sempre e nenhum toque sairia mais: depois do prazo, conta como cancelado.
     */
    private val watchdog = Runnable {
        if (current == null) return@Runnable
        Log.w(TAG, "gesture sem resposta do sistema; tratando como cancelado")
        current = null
        stats.onCancelled(now(), currentAt)
        planner.cancelled(now())
        pump()
    }
    private val lookIdle = Runnable {
        planner.up(LOOK_POINTER, now())
        pump()
    }

    private val callback = object : AccessibilityService.GestureResultCallback() {
        override fun onCompleted(g: GestureDescription?) {
            if (g !== current) return
            handler.removeCallbacks(watchdog)
            current = null
            if (flightInputNs != 0L) {
                stats.inputToCompleted.add((System.nanoTime() - flightInputNs) / 1000)
                flightInputNs = 0L
            }
            planner.completed(now())
            pump()
        }

        override fun onCancelled(g: GestureDescription?) {
            if (g !== current) return
            handler.removeCallbacks(watchdog)
            current = null
            flightInputNs = 0L
            stats.onCancelled(now(), currentAt)
            planner.cancelled(now())
            pump()
        }
    }

    init {
        handler.post {
            stats.reset(now())
            stats.profile = profile.label
            // Prioridade alta (o injetor dorme quase sempre; quando acorda é para um toque). URGENT_DISPLAY (-8) é a
            // das threads de UI críticas; se a ROM recusar, fica a de display (-4) como na 0.3.2.
            try {
                Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_DISPLAY)
            } catch (e: Exception) {
                try { Process.setThreadPriority(Process.THREAD_PRIORITY_DISPLAY) } catch (e2: Exception) { Log.w(TAG, "prioridade da thread: $e2") }
            }
        }
    }

    /**
     * API pública: pode ser chamada de qualquer thread (ex.: thread do DataChannel / usb-read). Não aloca (além do
     * Packet já decodificado): entra no anel e, se ele estava vazio, posta o drain.
     */
    fun handle(p: InputProtocol.Packet) {
        if (closed) return
        val at = System.nanoTime()
        var post = false
        synchronized(qLock) {
            if (qSize == QUEUE_CAP) {
                // 256 pacotes sem o injetor rodar (thread travada?): descarta o mais velho, nunca bloqueia a leitura
                qPackets[qHead] = null
                qHead = (qHead + 1) % QUEUE_CAP
                qSize--
            }
            val i = (qHead + qSize) % QUEUE_CAP
            qPackets[i] = p
            qAt[i] = at
            qSize++
            if (!drainPosted) { drainPosted = true; post = true }
        }
        if (post) handler.post(drain)
    }

    /**
     * Perfil de fluidez (CTRL `{"type":"input","profile":...}` do site 0.3.3). [onApplied] recebe (na thread do
     * injetor) o perfil e o quadro do display efetivamente usados, para a resposta ao site.
     */
    fun setProfile(p: FluidityProfile, onApplied: (FluidityProfile, Int) -> Unit = { _, _ -> }) {
        if (closed) return
        handler.post {
            if (p != profile) stats.clearLatency() // latências passam a ser só do perfil novo
            profile = p
            stats.profile = p.label
            applyConfig()
            onApplied(p, frameMs)
            pump()
        }
    }

    /** Mediana DOWN→dispatch (ms) medida no celular, para o pong (-1 sem amostras). */
    fun downDispatchP50Ms(): Double = stats.downDispatchP50Ms()

    fun releaseAll() {
        if (closed) return
        handler.post {
            handler.removeCallbacks(lookIdle)
            planner.releaseAll()
            pump()
        }
    }

    /** Nova conexão (WebRTC/USB): solta tudo e zera as gerações (o deadman só vale para gen > 0). */
    fun newSession() {
        if (closed) return
        handler.post {
            handler.removeCallbacks(lookIdle)
            planner.resetSession()
            pump()
        }
    }

    /** CTRL `{"type":"input","deadmanMs":N}` do site novo (ele manda keepalive dos dedos segurados). */
    fun setDeadman(ms: Long) {
        if (closed) return
        handler.post {
            planner.setDeadman(if (ms <= 0) 0 else ms.coerceIn(MIN_DEADMAN_MS, MAX_DEADMAN_MS))
            pump()
        }
    }

    /** Zera os contadores do diagnóstico (o app chama ao ligar a linha "Diagnóstico de toque"). */
    fun resetStats() {
        if (closed) return
        handler.post { stats.reset(now()) }
    }

    /** Serviço desligando: solta os dedos e encerra a thread. */
    fun shutdown() {
        if (closed) return
        handler.post {
            handler.removeCallbacks(lookIdle)
            planner.releaseAll()
            pump()
        }
        closed = true
        handler.postDelayed({ thread.quitSafely() }, 300)
    }

    // ------------------------------------------------------------------ thread do injetor

    private fun now() = SystemClock.uptimeMillis()

    private fun refreshScreen(t: Long) {
        if (screenW > 0 && t - screenAt < SCREEN_TTL_MS) return
        val (w, h) = try { screen() } catch (_: Exception) { screenW to screenH }
        if (w > 0 && h > 0) {
            screenW = w
            screenH = h
            planner.setBounds(w - 1, h - 1)
        }
        // A taxa do display muda sozinha (HyperOS alterna 60/90/120 Hz): a cadência acompanha.
        val f = FluidityProfile.frameMs(try { refreshHz() } catch (_: Exception) { 60f })
        if (f != frameMs) {
            frameMs = f
            applyConfig()
        }
        screenAt = t
    }

    private fun applyConfig() {
        if (frameMs <= 0) frameMs = FluidityProfile.frameMs(try { refreshHz() } catch (_: Exception) { 60f })
        planner.setConfig(profile.config(frameMs))
        stats.frameMs = frameMs
    }

    private fun drainInput() {
        var n: Int
        synchronized(qLock) {
            n = qSize
            for (k in 0 until n) {
                val i = (qHead + k) % QUEUE_CAP
                batch[k] = qPackets[i]
                batchAt[k] = qAt[i]
                qPackets[i] = null
            }
            qHead = 0
            qSize = 0
            drainPosted = false
        }
        for (k in 0 until n) {
            val p = batch[k] ?: continue
            batch[k] = null
            apply(p, batchAt[k])
        }
        pump()
    }

    /** Aplica um pacote ao planejador (sem planejar: o drain planeja uma vez depois do lote). */
    private fun apply(p: InputProtocol.Packet, atNs: Long) {
        val t = now()
        refreshScreen(t)
        val w = screenW
        val h = screenH
        if (w <= 0 || h <= 0) return
        val x = p.x * (w - 1)
        val y = p.y * (h - 1)
        val id = p.pointer
        val effective: Boolean
        when (p.action) {
            InputProtocol.DOWN -> {
                val before = planner.queued(id)
                planner.down(id, x, y, t, p.gen, if (id == LOOK_POINTER) 0 else planner.cfg.minTapMs)
                effective = planner.queued(id) > before // keepalive/cópia redundante não conta
                if (effective && id < downPendingNs.size && downPendingNs[id] == 0L) downPendingNs[id] = atNs
            }
            InputProtocol.MOVE -> { planner.move(id, x, y, t); effective = planner.isHeld(id) }
            InputProtocol.UP -> {
                val held = planner.isHeld(id)
                planner.up(id, t, p.gen)
                effective = held && !planner.isHeld(id)
            }
            InputProtocol.LOOK -> {
                planner.look(LOOK_POINTER, x, y, p.dx * h, p.dy * h, LOOK_ZONE * minOf(w, h), t)
                handler.removeCallbacks(lookIdle)
                handler.postDelayed(lookIdle, LOOK_IDLE_MS)
                effective = true
            }
            InputProtocol.RELEASE_ALL -> {
                handler.removeCallbacks(lookIdle)
                effective = planner.activeCount > 0
                planner.releaseAll()
            }
            else -> return
        }
        if (effective && pendingInputNs == 0L) pendingInputNs = atNs
    }

    private fun pump() {
        if (planner.inFlight) return
        val t = now()
        val g = planner.plan(t)
        if (g == null) {
            stats.onIdle(t, planner.activeCount)
            schedule(planner.wakeAt(t), t)
            return
        }
        val gesture = try {
            build(g)
        } catch (e: Exception) {
            // Não deveria acontecer (coordenadas presas na tela, durações > 0). Recomeça as cadeias com recuo.
            Log.w(TAG, "gesture inválido $g: $e")
            planner.cancelled(t)
            schedule(planner.wakeAt(t), t)
            return
        }
        current = gesture
        currentAt = t
        val ok = try {
            service.dispatchGesture(gesture, callback, handler)
        } catch (e: Exception) {
            Log.w(TAG, "dispatchGesture: $e")
            false
        }
        if (!ok) {
            current = null
            planner.dispatchFailed()
            strokes.fill(null)
            pendingInputNs = 0L
            downPendingNs.fill(0L)
        } else {
            val ns = System.nanoTime()
            if (pendingInputNs != 0L) {
                stats.inputToDispatch.add((ns - pendingInputNs) / 1000)
                flightInputNs = pendingInputNs
                pendingInputNs = 0L
            }
            for (s in g.segments) {
                if (!s.continues && s.pointer < downPendingNs.size && downPendingNs[s.pointer] != 0L) {
                    stats.downToDispatch.add((ns - downPendingNs[s.pointer]) / 1000)
                    downPendingNs[s.pointer] = 0L
                }
            }
            stats.onDispatch(t, planner.activeCount, g.recycle)
            handler.removeCallbacks(watchdog)
            handler.postDelayed(watchdog, g.durationMs + WATCHDOG_SLACK_MS)
        }
    }

    private fun build(g: TouchPlanner.Gesture): GestureDescription {
        val builder = GestureDescription.Builder()
        for (s in g.segments) {
            val path = paths[s.pointer]
            path.rewind()
            path.moveTo(s.fromX.toFloat(), s.fromY.toFloat())
            if (s.toX != s.fromX || s.toY != s.fromY) path.lineTo(s.toX.toFloat(), s.toY.toFloat())
            val prev = strokes[s.pointer]
            val stroke = if (s.continues) {
                checkNotNull(prev) { "sem stroke anterior para continuar (ponteiro ${s.pointer})" }
                    .continueStroke(path, s.startMs, s.durationMs, s.willContinue)
            } else {
                StrokeDescription(path, s.startMs, s.durationMs, s.willContinue)
            }
            builder.addStroke(stroke)
            built[s.pointer] = stroke
        }
        val gesture = builder.build()
        // Só depois de montar tudo (uma exceção acima não deixa strokes pela metade). A StrokeDescription guarda
        // uma cópia do Path, então os Paths acima podem ser reaproveitados.
        for (s in g.segments) {
            strokes[s.pointer] = built[s.pointer]
            built[s.pointer] = null
        }
        return gesture
    }

    private fun schedule(at: Long, t: Long) {
        if (at == Long.MAX_VALUE) {
            if (wakeAt != Long.MAX_VALUE) handler.removeCallbacks(wake)
            wakeAt = Long.MAX_VALUE
            return
        }
        val target = maxOf(at, t + 1)
        if (target == wakeAt) return
        handler.removeCallbacks(wake)
        wakeAt = target
        handler.postAtTime(wake, target)
    }

    companion object {
        const val LOOK_POINTER = 9
        private const val TAG = "TouchInjector"
        private const val LOOK_IDLE_MS = 150L
        private const val LOOK_ZONE = 0.22f
        private const val SCREEN_TTL_MS = 500L
        private const val WATCHDOG_SLACK_MS = 1_000L
        private const val QUEUE_CAP = 256
        const val MIN_DEADMAN_MS = 200L
        const val MAX_DEADMAN_MS = 5_000L

        private fun safeMaxStrokes(): Int = try {
            GestureDescription.getMaxStrokeCount()
        } catch (_: Throwable) {
            10
        }
    }
}
