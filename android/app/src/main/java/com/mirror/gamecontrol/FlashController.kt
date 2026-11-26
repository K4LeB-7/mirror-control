package com.mirror.gamecontrol

import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Choreographer
import android.view.Gravity
import android.view.View
import android.view.WindowManager

/**
 * Teste de latência do vídeo (CTRL `flash`, app 0.3.4). Um quadrado opaco no canto superior esquerdo da tela, numa
 * janela TYPE_ACCESSIBILITY_OVERLAY do serviço de acessibilidade (o mesmo padrão do [RotationController]: não focável,
 * não tocável, sem permissão extra), alterna preto/branco conforme o [FlashPlan]. A cada pulso branco o app responde
 * `flashAck` com o instante em que ele foi apresentado; o site procura o pulso nos quadros decodificados.
 *
 * Instante do pulso: depois de `setBackgroundColor` o desenho acontece no PRÓXIMO quadro do Choreographer;
 * `frameTimeNanos` (CLOCK_MONOTONIC) é o vsync em que esse quadro começou a ser produzido e o SurfaceFlinger o
 * apresenta cerca de 1 vsync depois, então `pm = frameTime + [PRESENT_DELAY_VSYNCS] × período do vsync` (a estimativa
 * tem incerteza de ~±1 vsync: 8 ms a 120 Hz, 17 ms a 60 Hz; `pm0` leva o valor bruto). Tudo na main thread.
 * NÃO verificado em aparelho (este código só compila aqui).
 */
object FlashController {
    private const val TAG = "FlashController"
    const val PRESENT_DELAY_VSYNCS = 1

    private val main = Handler(Looper.getMainLooper())
    private var view: View? = null
    private var owner: GameAccessibilityService? = null
    private var pending: List<Runnable> = emptyList()
    private var gen = 0

    /** Pode ser chamado de qualquer thread. [reply] manda texto ao site (pode ser chamado na main thread). */
    fun start(ctx: Context, clock: PtsClock, plan: FlashPlan = FlashPlan(), reply: (String) -> Unit) {
        main.post { startOnMain(ctx.applicationContext, clock, plan, reply) }
    }

    /** Remove o overlay e cancela o que estiver agendado (fim da conexão, serviço desligado, novo teste). */
    fun cancel() {
        main.post { cancelOnMain() }
    }

    private fun startOnMain(ctx: Context, clock: PtsClock, plan: FlashPlan, reply: (String) -> Unit) {
        cancelOnMain()
        if (!clock.trusted) {
            // Sem a base do PTS confirmada o `pm` não seria comparável com o vídeo: não mede (o site explica).
            reply(FlashPlan.failJson("O relógio do vídeo ainda não foi confirmado no celular (o encoder precisa entregar quadros). Tente de novo em alguns segundos."))
            reply(FlashPlan.endJson(0))
            return
        }
        val svc = GameAccessibilityService.instance
        if (svc == null) {
            reply(FlashPlan.failJson("Para medir a latência do vídeo, ative o serviço de acessibilidade do Mirror Control (é ele quem desenha o quadrado de teste)."))
            reply(FlashPlan.endJson(0))
            return
        }
        val wm = svc.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val display = wm.defaultDisplay
        val m = android.util.DisplayMetrics()
        @Suppress("DEPRECATION")
        display.getRealMetrics(m)
        val side = FlashPlan.squareSidePx(minOf(m.widthPixels, m.heightPixels))
        val v = View(svc)
        v.setBackgroundColor(Color.BLACK)
        val lp = WindowManager.LayoutParams(
            side, side,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.OPAQUE
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = 0
            y = 0
            title = "MirrorControlFlash"
            if (Build.VERSION.SDK_INT >= 28) layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
        }
        try {
            wm.addView(v, lp)
        } catch (e: Exception) {
            Log.w(TAG, "addView", e)
            reply(FlashPlan.failJson("O Android recusou desenhar o quadrado de teste (${e.javaClass.simpleName}). Confira se a acessibilidade do Mirror Control está ligada."))
            reply(FlashPlan.endJson(0))
            return
        }
        view = v
        owner = svc
        val myGen = ++gen
        val vsyncUs = (1_000_000f / maxOf(1f, display.refreshRate)).toLong()
        val steps = plan.steps()
        val runs = ArrayList<Runnable>()
        for (st in steps) {
            val r = Runnable {
                if (gen != myGen || view !== v) return@Runnable
                v.setBackgroundColor(if (st.white) Color.WHITE else Color.BLACK)
                if (st.white) {
                    Choreographer.getInstance().postFrameCallback { frameTimeNanos ->
                        if (gen != myGen) return@postFrameCallback
                        // Base do PTS perdida no meio do teste (não deveria): sem ack, o site conta o pulso como faltando.
                        if (!clock.trusted) return@postFrameCallback
                        val pm0 = clock.fromMono(frameTimeNanos / 1000)
                        reply(FlashPlan.ackJson(st.n, pm0 + PRESENT_DELAY_VSYNCS * vsyncUs, pm0, vsyncUs))
                    }
                }
            }
            runs.add(r)
            main.postDelayed(r, st.atMs)
        }
        val end = Runnable {
            if (gen != myGen) return@Runnable
            reply(FlashPlan.endJson(plan.pulses))
            cancelOnMain()
        }
        runs.add(end)
        main.postDelayed(end, plan.totalMs + 200)
        pending = runs
    }

    private fun cancelOnMain() {
        gen++
        for (r in pending) main.removeCallbacks(r)
        pending = emptyList()
        val v = view ?: return
        val o = owner
        view = null
        owner = null
        try {
            (o?.getSystemService(Context.WINDOW_SERVICE) as? WindowManager)?.removeView(v)
        } catch (e: Exception) {
            Log.w(TAG, "removeView", e)
        }
    }

    /** O serviço de acessibilidade foi desligado: a janela dele some junto. */
    fun onServiceGone(svc: GameAccessibilityService) {
        if (owner === svc) cancelOnMain()
    }
}
