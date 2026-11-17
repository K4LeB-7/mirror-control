package com.mirror.gamecontrol

import android.content.Context
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.WindowManager

/**
 * Gira a tela a pedido do site (CTRL rotate). Tudo na main thread.
 *
 * Método principal: uma janela 1×1 transparente do serviço de acessibilidade (TYPE_ACCESSIBILITY_OVERLAY,
 * não focável e não tocável) com `screenOrientation` = USER_PORTRAIT/USER_LANDSCAPE: o sistema gira a tela para
 * atender a janela visível que pede orientação. "auto" remove a janela. Não precisa de permissão extra, mas depende
 * da ROM respeitar a orientação de janelas de sobreposição (a maioria respeita; algumas ROMs e telas grandes no
 * Android 12L+/16 ignoram pedidos de orientação).
 *
 * Fallback: `Settings.System` (ACCELEROMETER_ROTATION=0 + USER_ROTATION) se o usuário permitiu "Modificar
 * configurações do sistema" (WRITE_SETTINGS). Os valores originais são restaurados no "auto" e ao parar.
 *
 * A captura acompanha a rotação sozinha (ScreenShareService.onDisplayChanged → RtcClient/UsbStreamServer).
 */
object RotationController {
    private const val TAG = "RotationController"

    data class Result(val ok: Boolean, val text: String)

    private var overlay: View? = null
    private var overlayOwner: GameAccessibilityService? = null
    /** Valores do sistema antes de o fallback mexer (null = não mexemos). */
    private var savedAccelerometer: Int? = null
    private var savedUserRotation: Int? = null

    fun apply(ctx: Context, mode: RotationMode): Result {
        if (mode == RotationMode.AUTO) {
            val hadOverlay = removeOverlay()
            val restored = restoreSettings(ctx)
            return Result(true, if (hadOverlay || restored) "Rotação automática (o sensor do celular decide)" else "Rotação já estava automática")
        }
        val orientation = RotationPolicy.overlayOrientation(mode)!!
        val svc = GameAccessibilityService.instance
        if (svc != null) {
            try {
                setOverlay(svc, orientation)
                restoreSettings(ctx) // não deixa o fallback antigo brigando com o overlay
                return Result(true, "Tela em ${mode.label}")
            } catch (e: Exception) {
                Log.w(TAG, "overlay", e)
                removeOverlay()
            }
        }
        if (canWriteSettings(ctx)) {
            return try {
                val cr = ctx.contentResolver
                if (savedAccelerometer == null) {
                    savedAccelerometer = Settings.System.getInt(cr, Settings.System.ACCELEROMETER_ROTATION, 1)
                    savedUserRotation = Settings.System.getInt(cr, Settings.System.USER_ROTATION, 0)
                }
                Settings.System.putInt(cr, Settings.System.ACCELEROMETER_ROTATION, 0)
                Settings.System.putInt(cr, Settings.System.USER_ROTATION, RotationPolicy.userRotation(mode)!!)
                Result(true, "Tela em ${mode.label} (configuração do sistema)")
            } catch (e: Exception) {
                Log.w(TAG, "settings", e)
                Result(false, "O Android recusou girar a tela: ${e.message}")
            }
        }
        return Result(
            false,
            "Para girar pelo site: ative o serviço de acessibilidade do Mirror Control ou, no app, toque em " +
                "\"Permitir girar a tela\" (Modificar configurações do sistema)."
        )
    }

    /** Fim do espelhamento: devolve a rotação ao usuário. */
    fun release(ctx: Context) {
        removeOverlay()
        restoreSettings(ctx)
    }

    /** O serviço de acessibilidade foi desligado: a janela dele some junto. */
    fun onServiceGone(svc: GameAccessibilityService) {
        if (overlayOwner === svc) removeOverlay()
    }

    fun canWriteSettings(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < 23 || Settings.System.canWrite(ctx)

    private fun setOverlay(svc: GameAccessibilityService, orientation: Int) {
        val wm = svc.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val lp = WindowManager.LayoutParams(
            1, 1,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSPARENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            screenOrientation = orientation
            title = "MirrorControlRotation"
        }
        val current = overlay
        if (current != null && overlayOwner === svc) {
            wm.updateViewLayout(current, lp)
            return
        }
        removeOverlay()
        val v = View(svc)
        wm.addView(v, lp)
        overlay = v
        overlayOwner = svc
    }

    private fun removeOverlay(): Boolean {
        val v = overlay ?: return false
        val owner = overlayOwner
        overlay = null
        overlayOwner = null
        try {
            (owner?.getSystemService(Context.WINDOW_SERVICE) as? WindowManager)?.removeView(v)
        } catch (e: Exception) {
            Log.w(TAG, "removeView", e)
        }
        return true
    }

    private fun restoreSettings(ctx: Context): Boolean {
        val accel = savedAccelerometer ?: return false
        val rot = savedUserRotation ?: 0
        savedAccelerometer = null
        savedUserRotation = null
        if (!canWriteSettings(ctx)) return false
        return try {
            val cr = ctx.contentResolver
            Settings.System.putInt(cr, Settings.System.USER_ROTATION, rot)
            Settings.System.putInt(cr, Settings.System.ACCELEROMETER_ROTATION, accel)
            true
        } catch (e: Exception) {
            Log.w(TAG, "restore", e)
            false
        }
    }
}

/**
 * Despacha rotate/nav vindos de qualquer transporte (DataChannel "ctrl" ou CTRL do USB), na main thread, e responde
 * com um status JSON pelo mesmo canal. Rotação responde sempre; navegação só quando falha (para não poluir a barra).
 */
object RemoteControl {
    private val main = Handler(Looper.getMainLooper())

    /** @return true se o comando era rotate/nav (tratado aqui). */
    fun handle(ctx: Context, cmd: RemoteCommand?, reply: (String) -> Unit): Boolean {
        when (cmd) {
            is RemoteCommand.Rotate -> main.post {
                val r = RotationController.apply(ctx.applicationContext, cmd.mode)
                reply(RemoteCommand.statusJson("rotate", r.ok, r.text))
            }
            is RemoteCommand.Nav -> main.post {
                val svc = GameAccessibilityService.instance
                if (svc == null) {
                    reply(RemoteCommand.statusJson("nav", false, "Ative o serviço de acessibilidade do Mirror Control para usar ${cmd.action.label}."))
                } else if (!svc.performGlobalAction(cmd.action.globalAction)) {
                    reply(RemoteCommand.statusJson("nav", false, "O Android recusou \"${cmd.action.label}\"."))
                }
            }
            null -> return false
        }
        return true
    }
}
