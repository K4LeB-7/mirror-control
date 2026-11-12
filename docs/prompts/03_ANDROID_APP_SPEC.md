# ESPECIFICAÇÃO DO APP ANDROID (KOTLIN)

## Arquitetura & Permissões:
- **MediaProjection API:** Captura contínua do frame buffer da tela para codificação WebRTC.
- **AccessibilityService (`android.permission.BIND_ACCESSIBILITY_SERVICE`):** Injeção de toques e gestos multitouch.
- **WebRTC Native SDK (`org.webrtc`):** Gerenciamento da conexão P2P e recebimento dos comandos do notebook.

## Lógica de Injeção de Gestos (`GameAccessibilityService.kt`):
```kotlin
package com.mirror.gamecontrol

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.view.accessibility.AccessibilityEvent

class GameAccessibilityService : AccessibilityService() {

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    fun dispatchClick(x: Float, y: Float, durationMs: Long = 10) {
        val path = Path().apply { moveTo(x, y) }
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs)
        val builder = GestureDescription.Builder().addStroke(stroke)
        dispatchGesture(builder.build(), null, null)
    }

    fun dispatchDrag(startX: Float, startY: Float, endX: Float, endY: Float, durationMs: Long = 50) {
        val path = Path().apply {
            moveTo(startX, startY)
            lineTo(endX, endY)
        }
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs)
        val builder = GestureDescription.Builder().addStroke(stroke)
        dispatchGesture(builder.build(), null, null)
    }
}
```
