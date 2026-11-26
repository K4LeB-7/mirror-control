package com.mirror.gamecontrol

import java.util.Locale

/**
 * Perfil de vídeo do modo USB (app 0.3.4): "Baixa latência" (padrão do site novo) ou "Padrão (0.3.3)". Escolhido no
 * site (CTRL `{"type":"video","mode":"lowlat|legacy"}`) e aplicado reconfigurando o encoder SEM derrubar a conexão.
 * Um site antigo nunca manda esse CTRL: o app fica em [VideoMode.LEGACY] (o comportamento exato da 0.3.3).
 * Puro Kotlin (testado na JVM).
 */
enum class VideoMode(val wire: String, val label: String) {
    LOWLAT("lowlat", "Baixa latência"),
    LEGACY("legacy", "Padrão (0.3.3)");

    companion object {
        fun fromWire(s: String?): VideoMode? = values().firstOrNull { it.wire == s }
    }
}

/** Constantes de ajuste por modo (um lugar só; os valores do LOWLAT são hipóteses a comparar no aparelho). */
object VideoTuning {
    const val LEGACY_GOP_SECONDS = 1
    /** IDR periódico no modo de baixa latência; recuperação de perda = IDR sob demanda (PARAMETER_KEY_REQUEST_SYNC_FRAME). */
    const val LOWLAT_GOP_SECONDS = 4
    /** Bitrate do modo de baixa latência = este percentual do bitrate legado (quadros menores ocupam menos o cabo). */
    const val LOWLAT_BITRATE_PERCENT = 75
    /** Fila de saída: no legado 8 quadros (~133 ms a 60 fps de atraso possível); em baixa latência 4 (~67 ms). */
    const val LEGACY_QUEUE_FRAMES = 8
    const val LEGACY_QUEUE_BYTES = 4 * 1024 * 1024
    const val LOWLAT_QUEUE_FRAMES = 4
    const val LOWLAT_QUEUE_BYTES = 2 * 1024 * 1024

    fun gopSeconds(m: VideoMode) = if (m == VideoMode.LOWLAT) LOWLAT_GOP_SECONDS else LEGACY_GOP_SECONDS
    fun queueFrames(m: VideoMode) = if (m == VideoMode.LOWLAT) LOWLAT_QUEUE_FRAMES else LEGACY_QUEUE_FRAMES
    fun queueBytes(m: VideoMode) = if (m == VideoMode.LOWLAT) LOWLAT_QUEUE_BYTES else LEGACY_QUEUE_BYTES

    /** Bitrate alvo (bps). O legado é exatamente [ScreenEncoder.bitrateFor]; a seleção de resolução/fps é do usuário. */
    fun bitrate(m: VideoMode, shortSide: Int, fps: Int): Int {
        val base = ScreenEncoder.bitrateFor(shortSide, fps)
        return if (m == VideoMode.LOWLAT) (base.toLong() * LOWLAT_BITRATE_PERCENT / 100).toInt() else base
    }
}

/**
 * Relógio do PTS (µs). O PTS dos quadros de uma entrada por Surface é o timestamp do buffer (BufferQueue do
 * VirtualDisplay), em ns, na base CLOCK_MONOTONIC do sistema (a mesma de `System.nanoTime()`); o MediaCodec o entrega
 * em µs. Isso NÃO foi verificado em aparelho (só lido na documentação/AOSP), então o app confere em tempo de execução:
 * para cada quadro compara `agora − pts` na base MONOTONIC e na BOOTTIME (`elapsedRealtimeNanos`) e adota a base em
 * que a diferença é plausível ([-PLAUSIBLE_MIN_US, PLAUSIBLE_MAX_US]). Se nenhuma serve (ex.: encoder normalizou o PTS
 * para começar em 0), [trusted] fica falso e o app NÃO reporta "enc" nem usa o PTS como captura. O mesmo relógio é
 * usado no `pm` do pong e do flashAck, para o site converter tudo com um único offset.
 */
class PtsClock(private val monoUs: () -> Long, private val bootUs: () -> Long) {
    enum class Base(val wire: String) { MONO("mono"), BOOT("boot"), UNKNOWN("unk") }

    @Volatile var base = Base.UNKNOWN
        private set
    @Volatile private var locked = false

    /** true quando a base do PTS foi confirmada (a de [nowUs]) e `agora − pts` é a idade real do quadro. */
    val trusted get() = base != Base.UNKNOWN

    /** Agora na base do PTS (MONOTONIC enquanto desconhecida: é a base esperada). */
    fun nowUs(): Long = if (base == Base.BOOT) bootUs() else monoUs()

    /** Converte um instante MONOTONIC (ex.: Choreographer.frameTimeNanos/1000) para a base do PTS. */
    fun fromMono(tMonoUs: Long): Long = if (base == Base.BOOT) tMonoUs + (bootUs() - monoUs()) else tMonoUs

    /** Chamada a cada quadro codificado (barata). Depois de confirmada a base, não reavalia. */
    fun observe(ptsUs: Long) {
        if (locked) return
        val m = monoUs() - ptsUs
        val b = bootUs() - ptsUs
        val chosen = when {
            plausible(m) -> Base.MONO
            plausible(b) -> Base.BOOT
            else -> Base.UNKNOWN
        }
        base = chosen
        if (chosen != Base.UNKNOWN) locked = true
    }

    fun reset() {
        base = Base.UNKNOWN
        locked = false
    }

    companion object {
        const val PLAUSIBLE_MIN_US = 50_000L // um quadro não pode ser "do futuro" além de erro de relógio/arredondamento
        const val PLAUSIBLE_MAX_US = 5_000_000L
        fun plausible(ageUs: Long) = ageUs >= -PLAUSIBLE_MIN_US && ageUs <= PLAUSIBLE_MAX_US
    }
}

/**
 * Estatística agregada do encoder para o CTRL `vstat` (~1 Hz). Alimentada pela thread do encoder (e pela de escrita);
 * [snapshot] roda na thread de controle: tudo sob uma trava curta (sem alocação por quadro).
 *
 * - enc: `agora − pts` no momento em que o quadro codificado sai do MediaCodec = captura + codificação (ms);
 * - q: espera do quadro na fila de saída do app, da oferta até a thread de escrita pegá-lo (ms);
 * - w: duração do write+flush no socket (só os writes que deram flush; o socket é loopback para o adbd: mede cópia
 *   para o kernel, não o cabo);
 * - fps/kbps do intervalo; keyMaxKB = maior quadro-chave desde o início da conexão.
 */
class VideoStats(private val cap: Int = 1024) {
    data class Pct(val p50: Double, val p95: Double, val max: Double)

    class Snapshot(
        val enc: Pct?, val q: Pct?, val w: Pct?,
        val fps: Double, val kbps: Double, val keyMaxKB: Double, val frames: Int, val keys: Int,
    )

    private val lock = Any()
    private val encUs = LongArray(cap)
    private var nEnc = 0
    private val qUs = LongArray(cap)
    private var nQ = 0
    private val wUs = LongArray(cap)
    private var nW = 0
    private var frames = 0
    private var keys = 0
    private var bytes = 0L
    private var keyMax = 0
    private var sinceMs = -1L

    fun onFrame(encUs: Long, size: Int, key: Boolean) = synchronized(lock) {
        frames++
        bytes += size
        if (key) {
            keys++
            if (size > keyMax) keyMax = size
        }
        if (encUs >= 0 && nEnc < cap) this.encUs[nEnc++] = encUs
    }

    fun onQueueWaitUs(us: Long) = synchronized(lock) { if (us >= 0 && nQ < cap) qUs[nQ++] = us }

    fun onWriteUs(us: Long) = synchronized(lock) { if (us >= 0 && nW < cap) wUs[nW++] = us }

    /** Fecha o intervalo atual (zera os acumuladores do intervalo; keyMax continua). */
    fun snapshot(nowMs: Long): Snapshot = synchronized(lock) {
        val dt = if (sinceMs < 0) 0.0 else (nowMs - sinceMs).coerceAtLeast(1).toDouble()
        val s = Snapshot(
            pct(encUs, nEnc), pct(qUs, nQ), pct(wUs, nW),
            if (dt > 0) frames * 1000.0 / dt else 0.0,
            if (dt > 0) bytes * 8.0 / dt else 0.0, // bits/ms = kbit/s
            keyMax / 1024.0, frames, keys,
        )
        nEnc = 0; nQ = 0; nW = 0; frames = 0; keys = 0; bytes = 0
        sinceMs = nowMs
        s
    }

    /** Nova conexão/encoder: esquece tudo. */
    fun reset() = synchronized(lock) {
        nEnc = 0; nQ = 0; nW = 0; frames = 0; keys = 0; bytes = 0; keyMax = 0; sinceMs = -1
    }

    companion object {
        /** [p50, p95, max] em ms (mesma definição de índices do site: p50 = s[(n-1)/2], p95 = s[(n-1)*95/100]). */
        fun pct(v: LongArray, n: Int): Pct? {
            if (n == 0) return null
            val s = v.copyOf(n)
            s.sort()
            return Pct(s[(n - 1) / 2] / 1000.0, s[((n - 1) * 95) / 100] / 1000.0, s[n - 1] / 1000.0)
        }

        private fun f1(v: Double) = String.format(Locale.US, "%.1f", v)
        private fun pctJson(p: Pct?) =
            if (p == null) "null" else "{\"p50\":${f1(p.p50)},\"p95\":${f1(p.p95)},\"max\":${f1(p.max)}}"

        class Meta(
            val seq: Int, val mode: VideoMode, val tier: Int, val clk: String,
            val width: Int, val height: Int, val fps: Int, val bitrate: Int, val gopSeconds: Int,
            val queueDrops: Long, val queueOverflows: Long, val queuePeak: Int, val rejected: String,
            val appVersion: String = "",
        )

        /** O CTRL `vstat` (docs/USB_PROTOCOLO.md). `enc` é null se o relógio do PTS não foi confirmado. */
        fun vstatJson(s: Snapshot, m: Meta, trusted: Boolean): String {
            val rej = m.rejected.filter { it.isLetterOrDigit() || it in " ._-,:/" }.take(80)
            return "{\"type\":\"vstat\",\"seq\":${m.seq},\"enc\":${if (trusted) pctJson(s.enc) else "null"}," +
                "\"q\":${pctJson(s.q)},\"wr\":${pctJson(s.w)},\"fps\":${f1(s.fps)},\"kbps\":${s.kbps.toInt()}," +
                "\"keyMaxKB\":${f1(s.keyMaxKB)},\"queueDrops\":${m.queueDrops},\"queueOverflows\":${m.queueOverflows}," +
                "\"queuePeak\":${m.queuePeak},\"clk\":\"${m.clk}\",\"mode\":\"${m.mode.wire}\",\"tier\":${m.tier}," +
                "\"rej\":\"$rej\",\"vw\":${m.width},\"vh\":${m.height},\"capFps\":${m.fps}," +
                "\"targetKbps\":${m.bitrate / 1000},\"gop\":${m.gopSeconds},\"n\":${s.frames}," +
                "\"ver\":\"${m.appVersion.filter { it.isLetterOrDigit() || it == '.' || it == '-' }.take(16)}\"}"
        }
    }
}

/**
 * Teste de latência do vídeo (CTRL `flash`): um quadrado no canto superior esquerdo da tela alterna preto/branco; o
 * app responde com o instante (relógio do PTS, µs) em que cada pulso BRANCO foi apresentado e o site o procura nos
 * quadros decodificados. Aqui só o plano (temporização) e o JSON; o desenho é do [FlashController].
 */
data class FlashPlan(val pulses: Int = 5, val onMs: Long = 300, val offMs: Long = 300, val leadMs: Long = 300) {
    /** n = número do pulso (1..pulses) nos passos brancos; 0 no preto inicial; no preto de fim de pulso, o pulso que acabou. */
    class Step(val atMs: Long, val white: Boolean, val n: Int)

    fun steps(): List<Step> {
        val out = ArrayList<Step>()
        out.add(Step(0, false, 0))
        for (i in 1..pulses) {
            val t = leadMs + (i - 1) * (onMs + offMs)
            out.add(Step(t, true, i))
            out.add(Step(t + onMs, false, i))
        }
        return out
    }

    /** Duração total até o último preto. */
    val totalMs: Long get() = leadMs + (pulses - 1) * (onMs + offMs) + onMs

    companion object {
        /** Lado do quadrado = esta fração do menor lado da tela (o site amostra o interior dele em coordenadas do vídeo). */
        const val SQUARE_FRACTION = 0.10
        fun squareSidePx(minScreenPx: Int): Int = maxOf(48, Math.round(SQUARE_FRACTION * minScreenPx).toInt())

        /** `pm` = apresentação estimada (µs, base do PTS); `pm0` = o frameTime bruto do Choreographer; `vs` = período do vsync. */
        fun ackJson(n: Int, pmUs: Long, pm0Us: Long, vsyncUs: Long): String =
            "{\"type\":\"flashAck\",\"n\":$n,\"pm\":$pmUs,\"pm0\":$pm0Us,\"vs\":$vsyncUs}"

        fun endJson(pulses: Int): String = "{\"type\":\"flashAck\",\"n\":0,\"end\":1,\"pulses\":$pulses}"

        fun failJson(text: String): String =
            "{\"type\":\"status\",\"scope\":\"flash\",\"ok\":false,\"text\":\"${text.filter { it != '"' && it != '\\' && it >= ' ' }.take(240)}\"}"
    }
}
