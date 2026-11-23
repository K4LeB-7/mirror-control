package com.mirror.gamecontrol

/**
 * Contadores do injetor para a linha "Diagnóstico de toque" do app (o usuário lê no aparelho e manda os números).
 * Escrito só pela thread do injetor; lido pela UI ([text]) sem trava (valores @Volatile; um número de um instante
 * antes não importa). Puro Kotlin (testado na JVM).
 */
class TouchStats {
    @Volatile var gestures = 0L; private set
    @Volatile var cancelled = 0L; private set
    /** Cancelados logo depois do despacho (< [REJECT_MS]): o sistema recusou o gesture (ex.: sem nenhum evento). */
    @Volatile var rejected = 0L; private set
    @Volatile var recycles = 0L; private set
    /** Maior intervalo entre dois gestures enquanto havia dedo segurado (ms). */
    @Volatile var maxGapMs = 0L; private set
    @Volatile var activeNow = 0; private set
    @Volatile var activePeak = 0; private set
    @Volatile var peakPerSecond = 0L; private set
    @Volatile private var lastSecond = 0L
    @Volatile var startedAt = 0L; private set

    private var lastDispatchAt = -1L
    private var lastDispatchHeld = false
    private var secondStart = 0L
    private var secondCount = 0L

    fun reset(now: Long) {
        gestures = 0; cancelled = 0; rejected = 0; recycles = 0; maxGapMs = 0; activePeak = 0; peakPerSecond = 0
        lastSecond = 0; lastDispatchAt = -1; secondStart = now; secondCount = 0; startedAt = now
    }

    /** Um gesture foi despachado; [active] = dedos ativos no planejador. */
    fun onDispatch(now: Long, active: Int, recycle: Boolean) {
        gestures++
        if (recycle) recycles++
        if (lastDispatchAt >= 0 && lastDispatchHeld && active > 0) maxGapMs = maxOf(maxGapMs, now - lastDispatchAt)
        lastDispatchAt = now
        lastDispatchHeld = active > 0
        tick(now, active, 1)
    }

    fun onCancelled(now: Long, dispatchedAt: Long) {
        cancelled++
        if (now - dispatchedAt < REJECT_MS) rejected++
    }

    /** Sem gesture (nenhum dedo): a contagem de lacuna recomeça. */
    fun onIdle(now: Long, active: Int) {
        if (active == 0) lastDispatchHeld = false
        tick(now, active, 0)
    }

    private fun tick(now: Long, active: Int, n: Int) {
        activeNow = active
        if (active > activePeak) activePeak = active
        if (now - secondStart >= 1000) {
            lastSecond = secondCount
            if (secondCount > peakPerSecond) peakPerSecond = secondCount
            secondStart = now
            secondCount = 0
        }
        secondCount += n
    }

    fun text(now: Long): String {
        val secs = ((now - startedAt) / 1000.0).coerceAtLeast(0.001)
        return "gestures: %d (%.0f/s média, pico %d/s, último s %d) · cancelados: %d (recusados %d) · maior lacuna com dedo segurado: %d ms · dedos: %d agora, pico %d · reciclagens de ids: %d".format(
            gestures, gestures / secs, peakPerSecond, lastSecond, cancelled, rejected, maxGapMs, activeNow, activePeak, recycles,
        )
    }

    companion object {
        const val REJECT_MS = 5L
    }
}
