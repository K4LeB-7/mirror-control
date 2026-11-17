package com.mirror.gamecontrol

import android.accessibilityservice.AccessibilityService
import android.content.pm.ActivityInfo
import android.view.Surface

/** Modo de rotação pedido pelo site (CTRL `{"type":"rotate","mode":…}`). */
enum class RotationMode(val wire: String, val label: String) {
    PORTRAIT("portrait", "retrato"),
    LANDSCAPE("landscape", "paisagem"),
    AUTO("auto", "automática");

    companion object {
        fun parse(s: String?): RotationMode? {
            val v = s?.trim()?.lowercase() ?: return null
            return values().firstOrNull { it.wire == v }
        }
    }
}

/** Botões de navegação do Android (CTRL `{"type":"nav","action":…}`) → performGlobalAction. */
enum class NavAction(val wire: String, val globalAction: Int, val label: String) {
    BACK("back", AccessibilityService.GLOBAL_ACTION_BACK, "Voltar"),
    HOME("home", AccessibilityService.GLOBAL_ACTION_HOME, "Início"),
    RECENTS("recents", AccessibilityService.GLOBAL_ACTION_RECENTS, "Recentes");

    companion object {
        fun parse(s: String?): NavAction? {
            val v = s?.trim()?.lowercase() ?: return null
            return values().firstOrNull { it.wire == v }
        }
    }
}

/**
 * Comandos de controle do site tratados fora do transporte (app 0.3.0+). Lógica PURA (testada na JVM em
 * RemoteCommandTest): quem chama extrai type/mode/action do JSON. "quality"/"keyframe" continuam com o transporte.
 */
sealed class RemoteCommand {
    data class Rotate(val mode: RotationMode) : RemoteCommand()
    data class Nav(val action: NavAction) : RemoteCommand()

    companion object {
        fun from(type: String?, mode: String?, action: String?): RemoteCommand? = when (type) {
            "rotate" -> RotationMode.parse(mode)?.let { Rotate(it) }
            "nav" -> NavAction.parse(action)?.let { Nav(it) }
            else -> null
        }

        /** Resposta celular → site: `{"type":"status","scope":…,"ok":…,"text":…}`. */
        fun statusJson(scope: String, ok: Boolean, text: String): String =
            "{\"type\":\"status\",\"scope\":${quote(scope)},\"ok\":$ok,\"text\":${quote(text)}}"

        fun quote(s: String): String {
            val b = StringBuilder(s.length + 2).append('"')
            for (c in s) {
                when (c) {
                    '"' -> b.append("\\\"")
                    '\\' -> b.append("\\\\")
                    '\n' -> b.append("\\n")
                    '\r' -> b.append("\\r")
                    '\t' -> b.append("\\t")
                    else -> if (c < ' ') b.append(String.format("\\u%04x", c.code)) else b.append(c)
                }
            }
            return b.append('"').toString()
        }
    }
}

/** Como cada modo vira configuração do Android (puro; constantes inlinadas pelo compilador). */
object RotationPolicy {
    /** `LayoutParams.screenOrientation` do overlay 1×1; null = sem overlay (o sensor decide). */
    fun overlayOrientation(mode: RotationMode): Int? = when (mode) {
        RotationMode.PORTRAIT -> ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT
        RotationMode.LANDSCAPE -> ActivityInfo.SCREEN_ORIENTATION_USER_LANDSCAPE
        RotationMode.AUTO -> null
    }

    /** `Settings.System.USER_ROTATION` do fallback (com ACCELEROMETER_ROTATION=0); null = devolver ao sensor. */
    fun userRotation(mode: RotationMode): Int? = when (mode) {
        RotationMode.PORTRAIT -> Surface.ROTATION_0
        RotationMode.LANDSCAPE -> Surface.ROTATION_90
        RotationMode.AUTO -> null
    }
}
