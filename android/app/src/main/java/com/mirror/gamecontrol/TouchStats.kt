package com.mirror.gamecontrol

/**
 * Contadores do injetor para a linha "Diagnóstico de toque" do app (o usuário lê no aparelho e manda os números).
 * Escrito só pela thread do injetor; lido pela UI ([text]) sem trava nos contadores (valores @Volatile; um número de
 * um instante antes não importa) e com trava curta nas janelas de latência. Puro Kotlin (testado na JVM).
 *
 * Latências (app 0.3.3, medidas no celular com o relógio monotônico, em ms com décimos):
 * - pacote→dispatch: da chegada do pacote (thread de leitura do USB/WebRTC) até o `dispatchGesture` que o leva;
 * - DOWN→dispatch: o mesmo, só para o 1º DOWN de um dedo novo (o que mais pesa em "apertei e demorou");
 * - pacote→fim: até o `onCompleted` desse gesture (o DOWN/MOVE é entregue ao jogo antes disso; o fim do gesture é o
 *   limite superior medido no aparelho).
 * Um UP que chega antes do toque mínimo espera o mínimo de propósito: isso entra em pacote→dispatch.
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
    /** Perfil de fluidez ativo e duração do quadro do display (ms) usados pelo planejador. */
    @Volatile var profile: String = FluidityProfile.BALANCED.label
    @Volatile var frameMs: Int = 0

    private var lastDispatchAt = -1L
    private var lastDispatchHeld = false
    private var secondStart = 0L
    private var secondCount = 0L

    /** Janela das últimas [Window.CAP] amostras (µs). add só na thread do injetor; snapshot na UI. */
    class Window {
        private val v = LongArray(CAP)
        private var n = 0
        private var i = 0

        @Synchronized fun add(us: Long) {
            v[i] = us
            i = (i + 1) % CAP
            if (n < CAP) n++
        }

        @Synchronized fun clear() { n = 0; i = 0 }

        /** [p50, p95, máx] em µs, ou null sem amostras. */
        @Synchronized fun summary(): LongArray? {
            if (n == 0) return null
            val s = v.copyOf(n)
            s.sort()
            return longArrayOf(s[(n - 1) / 2], s[((n - 1) * 95) / 100], s[n - 1])
        }

        val count: Int @Synchronized get() = n

        companion object { const val CAP = 512 }
    }

    val inputToDispatch = Window()
    val downToDispatch = Window()
    val inputToCompleted = Window()

    fun reset(now: Long) {
        gestures = 0; cancelled = 0; rejected = 0; recycles = 0; maxGapMs = 0; activePeak = 0; peakPerSecond = 0
        lastSecond = 0; lastDispatchAt = -1; secondStart = now; secondCount = 0; startedAt = now
        clearLatency()
    }

    /** Troca de perfil: as janelas de latência passam a valer só para o perfil novo. */
    fun clearLatency() {
        inputToDispatch.clear(); downToDispatch.clear(); inputToCompleted.clear()
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

    /** Mediana DOWN→dispatch em ms (para o pong do ping do site), ou -1 sem amostras. */
    fun downDispatchP50Ms(): Double = downToDispatch.summary()?.let { it[0] / 1000.0 } ?: -1.0

    private fun fmt(w: Window): String {
        val s = w.summary() ?: return "—"
        return "%.1f/%.1f/%.1f ms (n=%d)".format(s[0] / 1000.0, s[1] / 1000.0, s[2] / 1000.0, w.count)
    }

    fun text(now: Long): String {
        val secs = ((now - startedAt) / 1000.0).coerceAtLeast(0.001)
        return ("perfil: %s (quadro %d ms) · gestures: %d (%.0f/s média, pico %d/s, último s %d) · cancelados: %d (recusados %d) · " +
            "maior lacuna com dedo segurado: %d ms · dedos: %d agora, pico %d · reciclagens de ids: %d · " +
            "latência p50/p95/máx — DOWN→dispatch %s · pacote→dispatch %s · pacote→fim do gesture %s").format(
            profile, frameMs, gestures, gestures / secs, peakPerSecond, lastSecond, cancelled, rejected, maxGapMs, activeNow, activePeak, recycles,
            fmt(downToDispatch), fmt(inputToDispatch), fmt(inputToCompleted),
        )
    }

    companion object {
        const val REJECT_MS = 5L
    }
}
