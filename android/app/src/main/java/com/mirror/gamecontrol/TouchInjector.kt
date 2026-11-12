package com.mirror.gamecontrol

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.accessibilityservice.GestureDescription.StrokeDescription
import android.graphics.Path
import android.os.Handler
import android.os.Looper
import kotlin.math.abs
import kotlin.math.hypot

/**
 * Multitouch persistente sobre dispatchGesture().
 *
 * Um dedo "segurado" é uma cadeia de StrokeDescription com willContinue=true, cada segmento
 * continuando o anterior (continueStroke). Só um gesture fica em voo por vez: ao completar,
 * despachamos o próximo segmento de TODOS os dedos ativos. Tudo roda na main thread.
 */
class TouchInjector(
    private val service: AccessibilityService,
    private val screen: () -> Pair<Int, Int>,
) {
    private class Finger(var x: Float, var y: Float) {
        var lastX = x
        var lastY = y
        var stroke: StrokeDescription? = null
        var releasing = false
        /** Se != null, ao terminar o stroke atual o dedo reaparece nesta posição (re-ancoragem da câmera). */
        var restartAt: Pair<Float, Float>? = null
    }

    private val handler = Handler(Looper.getMainLooper())
    private val fingers = HashMap<Int, Finger>()
    private var inFlight = false

    // Câmera (mouse look): dedo virtual que desliza a partir de uma âncora.
    private var lookAnchor = 0f to 0f
    private val lookIdle = Runnable { up(LOOK_POINTER) }

    /** API pública: pode ser chamada de qualquer thread (ex.: thread do DataChannel). */
    fun handle(p: InputProtocol.Packet) {
        handler.post {
            when (p.action) {
                InputProtocol.DOWN -> down(p.pointer, p.x, p.y)
                InputProtocol.MOVE -> move(p.pointer, p.x, p.y)
                InputProtocol.UP -> up(p.pointer)
                InputProtocol.LOOK -> look(p)
                InputProtocol.RELEASE_ALL -> doReleaseAll()
            }
        }
    }

    fun releaseAll() = handler.post { doReleaseAll() }

    private fun px(nx: Float, ny: Float): Pair<Float, Float> {
        val (w, h) = screen()
        return nx * (w - 1) to ny * (h - 1)
    }

    private fun down(id: Int, nx: Float, ny: Float) {
        val (x, y) = px(nx, ny)
        val existing = fingers[id]
        if (existing != null && !existing.releasing) return
        fingers[id] = Finger(x, y)
        pump()
    }

    private fun move(id: Int, nx: Float, ny: Float) {
        val f = fingers[id] ?: return
        if (f.releasing) return
        val (x, y) = px(nx, ny)
        f.x = x
        f.y = y
        pump()
    }

    private fun up(id: Int) {
        val f = fingers[id] ?: return
        f.releasing = true
        f.restartAt = null
        pump()
    }

    private fun look(p: InputProtocol.Packet) {
        val (w, h) = screen()
        val f = fingers[LOOK_POINTER]
        if (f == null || f.releasing) {
            lookAnchor = px(p.x, p.y)
            fingers[LOOK_POINTER] = Finger(lookAnchor.first, lookAnchor.second)
        }
        val finger = fingers[LOOK_POINTER] ?: return
        finger.x += p.dx * h
        finger.y += p.dy * h
        // Saiu da zona de câmera: termina o stroke e recomeça na âncora (como levantar o dedo e voltar).
        val zone = 0.22f * minOf(w, h)
        if (hypot(finger.x - lookAnchor.first, finger.y - lookAnchor.second) > zone) {
            finger.x = finger.x.coerceIn(0f, (w - 1).toFloat())
            finger.y = finger.y.coerceIn(0f, (h - 1).toFloat())
            finger.releasing = true
            finger.restartAt = lookAnchor
        }
        handler.removeCallbacks(lookIdle)
        handler.postDelayed(lookIdle, LOOK_IDLE_MS)
        pump()
    }

    private fun doReleaseAll() {
        handler.removeCallbacks(lookIdle)
        for (f in fingers.values) {
            f.releasing = true
            f.restartAt = null
        }
        pump()
    }

    private fun pump() {
        if (inFlight || fingers.isEmpty()) return
        val builder = GestureDescription.Builder()
        var count = 0
        val maxStrokes = GestureDescription.getMaxStrokeCount()
        for (f in fingers.values) {
            if (count >= maxStrokes) break
            val path = Path().apply {
                moveTo(f.lastX, f.lastY)
                if (abs(f.x - f.lastX) > 0.5f || abs(f.y - f.lastY) > 0.5f) lineTo(f.x, f.y)
            }
            val cont = !f.releasing
            val prev = f.stroke
            val stroke = if (prev != null) prev.continueStroke(path, 0, SEGMENT_MS, cont)
            else StrokeDescription(path, 0, SEGMENT_MS, cont)
            f.stroke = stroke
            f.lastX = f.x
            f.lastY = f.y
            builder.addStroke(stroke)
            count++
        }
        if (count == 0) return
        inFlight = true
        val ok = service.dispatchGesture(builder.build(), object : AccessibilityService.GestureResultCallback() {
            override fun onCompleted(g: GestureDescription?) {
                inFlight = false
                finishReleased()
                pump()
            }

            override fun onCancelled(g: GestureDescription?) {
                inFlight = false
                // O sistema abortou a cadeia: os dedos ainda ativos reiniciam como novo toque.
                for (f in fingers.values) f.stroke = null
                finishReleased()
                pump()
            }
        }, handler)
        if (!ok) {
            inFlight = false
            fingers.clear()
        }
    }

    private fun finishReleased() {
        val it = fingers.entries.iterator()
        val restarts = HashMap<Int, Finger>()
        while (it.hasNext()) {
            val (id, f) = it.next()
            if (f.releasing) {
                it.remove()
                f.restartAt?.let { (rx, ry) -> restarts[id] = Finger(rx, ry) }
            }
        }
        fingers.putAll(restarts)
    }

    companion object {
        const val LOOK_POINTER = 9
        private const val SEGMENT_MS = 16L
        private const val LOOK_IDLE_MS = 150L
    }
}
