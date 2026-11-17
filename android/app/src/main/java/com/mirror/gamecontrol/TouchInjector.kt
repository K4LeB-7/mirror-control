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
 */
class TouchInjector(
    private val service: AccessibilityService,
    private val screen: () -> Pair<Int, Int>,
) {
    private val thread = HandlerThread("touch-injector").apply { start() }
    private val handler = Handler(thread.looper)
    private val planner = TouchPlanner(maxStrokes = safeMaxStrokes())
    @Volatile private var closed = false

    // Só na thread do injetor:
    private val strokes = arrayOfNulls<StrokeDescription>(TouchPlanner.MAX_POINTERS)
    private val paths = Array(TouchPlanner.MAX_POINTERS) { Path() }
    private val built = arrayOfNulls<StrokeDescription>(TouchPlanner.MAX_POINTERS)
    private var current: GestureDescription? = null
    private var wakeAt = Long.MAX_VALUE
    private var screenW = 0
    private var screenH = 0
    private var screenAt = 0L

    private val wake = Runnable {
        wakeAt = Long.MAX_VALUE
        pump()
    }
    /**
     * Callback que nunca chega (serviço desconectando, tela apagando, ROM que perde o callback) deixaria o
     * planejador "em voo" para sempre e nenhum toque sairia mais: depois do prazo, conta como cancelado.
     */
    private val watchdog = Runnable {
        if (current == null) return@Runnable
        Log.w(TAG, "gesture sem resposta do sistema; tratando como cancelado")
        current = null
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
            planner.completed(now())
            pump()
        }

        override fun onCancelled(g: GestureDescription?) {
            if (g !== current) return
            handler.removeCallbacks(watchdog)
            current = null
            planner.cancelled(now())
            pump()
        }
    }

    init {
        handler.post {
            try {
                Process.setThreadPriority(Process.THREAD_PRIORITY_DISPLAY)
            } catch (e: Exception) {
                Log.w(TAG, "prioridade da thread: $e")
            }
        }
    }

    /** API pública: pode ser chamada de qualquer thread (ex.: thread do DataChannel / usb-read). */
    fun handle(p: InputProtocol.Packet) {
        if (closed) return
        handler.post { apply(p) }
    }

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
        screenAt = t
    }

    private fun apply(p: InputProtocol.Packet) {
        val t = now()
        refreshScreen(t)
        val w = screenW
        val h = screenH
        if (w <= 0 || h <= 0) return
        val x = p.x * (w - 1)
        val y = p.y * (h - 1)
        when (p.action) {
            InputProtocol.DOWN -> planner.down(p.pointer, x, y, t, p.gen, if (p.pointer == LOOK_POINTER) 0 else planner.cfg.minTapMs)
            InputProtocol.MOVE -> planner.move(p.pointer, x, y, t)
            InputProtocol.UP -> planner.up(p.pointer, t, p.gen)
            InputProtocol.LOOK -> {
                planner.look(LOOK_POINTER, x, y, p.dx * h, p.dy * h, LOOK_ZONE * minOf(w, h), t)
                handler.removeCallbacks(lookIdle)
                handler.postDelayed(lookIdle, LOOK_IDLE_MS)
            }
            InputProtocol.RELEASE_ALL -> {
                handler.removeCallbacks(lookIdle)
                planner.releaseAll()
            }
            else -> return
        }
        pump()
    }

    private fun pump() {
        if (planner.inFlight) return
        val t = now()
        val g = planner.plan(t)
        if (g == null) {
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
        } else {
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
        const val MIN_DEADMAN_MS = 200L
        const val MAX_DEADMAN_MS = 5_000L

        private fun safeMaxStrokes(): Int = try {
            GestureDescription.getMaxStrokeCount()
        } catch (_: Throwable) {
            10
        }
    }
}
