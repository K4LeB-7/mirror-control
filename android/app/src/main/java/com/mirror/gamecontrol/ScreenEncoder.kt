package com.mirror.gamecontrol

import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Surface

/**
 * MediaProjection → VirtualDisplay → MediaCodec H.264 (entrada por Surface).
 *
 * A VirtualDisplay é criada UMA vez e reaproveitada (resize + setSurface) a cada reinício do encoder: no Android 14+
 * chamar createVirtualDisplay de novo no mesmo MediaProjection lança SecurityException.
 *
 * [start]/[stop]/[release]/[requestKeyFrame] devem ser chamados de uma única thread (a thread de controle do
 * UsbStreamServer). A saída do codec é lida numa thread própria e entregue ao [Listener] nessa thread.
 */
class ScreenEncoder(
    private val projection: MediaProjection,
    private val dpi: Int,
    private val listener: Listener,
) {
    interface Listener {
        /** SPS/PPS em Annex B (pode repetir; o servidor descarta duplicatas). */
        fun onConfig(config: ByteArray)
        fun onFrame(key: Boolean, ptsUs: Long, data: ByteArray)
        fun onError(e: Exception)
    }

    data class Params(val width: Int, val height: Int, val fps: Int, val bitrate: Int)

    private var display: VirtualDisplay? = null
    @Volatile private var codec: MediaCodec? = null
    private var surface: Surface? = null
    private var thread: Thread? = null
    @Volatile private var running = false

    /** Parâmetros do encoder em execução (null = parado). */
    @Volatile var params: Params? = null
        private set

    val isRunning get() = params != null

    fun start(p: Params) {
        stop()
        val c = createCodec(p)
        val s: Surface
        try {
            s = c.createInputSurface()
            c.start()
        } catch (e: Exception) {
            c.release()
            throw e
        }
        try {
            val d = display
            if (d == null) {
                display = projection.createVirtualDisplay(
                    "MirrorControlUSB", p.width, p.height, dpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, s, null, null
                ) ?: throw IllegalStateException("createVirtualDisplay devolveu null")
            } else {
                d.resize(p.width, p.height, dpi)
                d.setSurface(s)
            }
        } catch (e: Exception) {
            try { c.stop() } catch (_: Exception) {}
            c.release()
            s.release()
            throw e
        }
        codec = c
        surface = s
        params = p
        running = true
        thread = Thread({ drain(c) }, "usb-encoder").also { it.start() }
    }

    /** Para o encoder; a VirtualDisplay fica viva, sem surface, pronta para o próximo [start]. */
    fun stop() {
        running = false
        thread?.let {
            it.join(2_000)
            if (it.isAlive) Log.w(TAG, "thread do encoder não terminou a tempo")
        }
        thread = null
        try { display?.setSurface(null) } catch (_: Exception) {}
        codec?.let {
            try { it.stop() } catch (_: Exception) {}
            try { it.release() } catch (_: Exception) {}
        }
        codec = null
        surface?.release()
        surface = null
        params = null
    }

    fun release() {
        stop()
        try { display?.release() } catch (_: Exception) {}
        display = null
    }

    /** Pode ser chamado de qualquer thread (MediaCodec.setParameters é thread-safe). */
    fun requestKeyFrame() {
        val c = codec ?: return
        try {
            c.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) })
        } catch (e: Exception) {
            Log.w(TAG, "pedido de IDR falhou: $e")
        }
    }

    private fun drain(c: MediaCodec) {
        val info = MediaCodec.BufferInfo()
        try {
            while (running) {
                val idx = c.dequeueOutputBuffer(info, 100_000)
                if (idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    val f = c.outputFormat
                    val csd0 = f.getByteBuffer("csd-0")
                    val csd1 = f.getByteBuffer("csd-1")
                    if (csd0 != null) {
                        val a = ByteArray(csd0.remaining()).also { csd0.duplicate().get(it) }
                        val b = csd1?.let { x -> ByteArray(x.remaining()).also { x.duplicate().get(it) } } ?: ByteArray(0)
                        listener.onConfig(a + b)
                    }
                } else if (idx >= 0) {
                    val buf = c.getOutputBuffer(idx)
                    if (buf != null && info.size > 0) {
                        buf.position(info.offset)
                        buf.limit(info.offset + info.size)
                        val bytes = ByteArray(info.size).also { buf.get(it) }
                        if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) listener.onConfig(bytes)
                        else listener.onFrame(
                            info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0, info.presentationTimeUs, bytes
                        )
                    }
                    c.releaseOutputBuffer(idx, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
                }
            }
        } catch (e: Exception) {
            if (running) listener.onError(e) // parado de propósito: exceção esperada, ignora
        }
    }

    private fun createCodec(p: Params): MediaCodec {
        var last: Exception? = null
        // 2 = tudo (perfil, CBR, prioridade, low-latency); 1 = perfil + CBR; 0 = o mínimo que todo encoder aceita.
        for (tier in 2 downTo 0) {
            val c = MediaCodec.createEncoderByType(MIME)
            try {
                c.configure(format(p, tier, c.codecInfo), null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                Log.i(TAG, "encoder ${c.name} ${p.width}x${p.height}@${p.fps} ${p.bitrate}bps nível=$tier")
                return c
            } catch (e: Exception) {
                Log.w(TAG, "configure(nível=$tier) falhou: $e")
                last = e
                c.release()
            }
        }
        throw last ?: IllegalStateException("sem encoder H.264")
    }

    private fun format(p: Params, tier: Int, info: MediaCodecInfo): MediaFormat =
        MediaFormat.createVideoFormat(MIME, p.width, p.height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, p.bitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, p.fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
            // Tela parada: o VirtualDisplay não gera quadros; o encoder repete o último (µs).
            setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 150_000L)
            if (tier == 0) return@apply // mínimo: nada opcional
            // Telas de 90/120 Hz: não entrega ao encoder mais quadros do que o fps pedido.
            if (Build.VERSION.SDK_INT >= 29) setFloat(MediaFormat.KEY_MAX_FPS_TO_ENCODER, p.fps.toFloat())
            val caps = try { info.getCapabilitiesForType(MIME) } catch (_: Exception) { null }
            val baseline = caps?.profileLevels?.filter {
                it.profile == MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline
            }?.maxByOrNull { it.level }
            if (baseline != null) {
                setInteger(MediaFormat.KEY_PROFILE, baseline.profile)
                setInteger(MediaFormat.KEY_LEVEL, baseline.level)
            }
            if (caps?.encoderCapabilities?.isBitrateModeSupported(
                    MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR) == true
            ) setInteger(MediaFormat.KEY_BITRATE_MODE, MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)
            if (tier == 1) return@apply
            setInteger(MediaFormat.KEY_PRIORITY, 0) // tempo real
            if (Build.VERSION.SDK_INT >= 29) setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
            if (Build.VERSION.SDK_INT >= 30) setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
        }

    companion object {
        const val MIME = MediaFormat.MIMETYPE_VIDEO_AVC
        private const val TAG = "ScreenEncoder"

        /**
         * Tamanho do vídeo: lado menor = [shortSide] (sem aumentar além da tela), múltiplos de 8, e reduzido até o
         * encoder aceitar (muitos H.264 limitam a largura a 1920/2048, e 1080p de uma tela 20:9 dá 2400×1080).
         */
        fun fitSize(screenW: Int, screenH: Int, shortSide: Int, supported: (Int, Int) -> Boolean): Pair<Int, Int> {
            var scale = minOf(1f, shortSide.toFloat() / minOf(screenW, screenH))
            fun r8(v: Float) = maxOf(8, (v / 8f).toInt() * 8)
            while (true) {
                val w = r8(screenW * scale)
                val h = r8(screenH * scale)
                if (supported(w, h) || minOf(w, h) <= 240) return w to h
                scale *= 0.9f
            }
        }

        /** Consulta as capacidades do encoder H.264 padrão (o mesmo que createEncoderByType escolhe). */
        fun sizeChecker(): (Int, Int) -> Boolean {
            val caps = try {
                val c = MediaCodec.createEncoderByType(MIME)
                try { c.codecInfo.getCapabilitiesForType(MIME).videoCapabilities } finally { c.release() }
            } catch (_: Exception) { null }
            return { w, h -> caps?.isSizeSupported(w, h) ?: true }
        }

        fun bitrateFor(shortSide: Int, fps: Int): Int =
            (if (shortSide >= 1080) 16_000_000 else 8_000_000) * fps / 60
    }
}
