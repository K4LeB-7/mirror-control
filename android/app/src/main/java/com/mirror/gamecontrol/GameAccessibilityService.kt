package com.mirror.gamecontrol

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.util.DisplayMetrics
import android.view.accessibility.AccessibilityEvent

class GameAccessibilityService : AccessibilityService() {

    /** Injetor de toques persistentes (multitouch). Só existe enquanto o serviço está ativo. */
    lateinit var injector: TouchInjector
        private set

    override fun onServiceConnected() {
        super.onServiceConnected()
        injector = TouchInjector(this) { screenSize() }
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

    override fun onInterrupt() {
        if (::injector.isInitialized) injector.releaseAll()
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        if (instance === this) instance = null
        if (::injector.isInitialized) injector.releaseAll()
        return super.onUnbind(intent)
    }

    @Suppress("DEPRECATION")
    private fun screenSize(): Pair<Int, Int> {
        val m = DisplayMetrics()
        (getSystemService(WINDOW_SERVICE) as android.view.WindowManager).defaultDisplay.getRealMetrics(m)
        return m.widthPixels to m.heightPixels
    }

    // Utilitários de gesto único (toque curto / arrasto), conforme a especificação.
    fun dispatchClick(x: Float, y: Float, durationMs: Long = 10) {
        val path = Path().apply { moveTo(x, y) }
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs)
        dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }

    fun dispatchDrag(startX: Float, startY: Float, endX: Float, endY: Float, durationMs: Long = 50) {
        val path = Path().apply {
            moveTo(startX, startY)
            lineTo(endX, endY)
        }
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs)
        dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }

    companion object {
        @Volatile
        var instance: GameAccessibilityService? = null
            private set
    }
}
