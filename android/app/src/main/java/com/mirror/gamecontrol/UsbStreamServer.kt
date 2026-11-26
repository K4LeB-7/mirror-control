package com.mirror.gamecontrol

import android.content.Context
import android.media.projection.MediaProjection
import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.os.SystemClock
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Modo USB (ADB): ServerSocket em 127.0.0.1:27183. O navegador do PC chega aqui pelo cabo, via WebUSB → adbd →
 * serviço ADB `tcp:27183` (o adbd conecta do próprio aparelho, por isso só aceitamos loopback).
 * Protocolo: docs/USB_PROTOCOLO.md.
 *
 * Threads:
 *  - "usb-accept": aceita conexões; cada uma faz o HELLO numa thread curta ("usb-hello", no máximo 2 ao mesmo tempo);
 *  - "usb-ctl": única thread que mexe no encoder (início/reinício/parada, rotação, qualidade);
 *  - por sessão, "usb-read" (INPUT/CTRL) e "usb-write" (esvazia a FrameQueue no socket);
 *  - "usb-encoder" (dentro do ScreenEncoder) produz os quadros.
 */
class UsbStreamServer(
    private val ctx: Context,
    projection: MediaProjection,
    private val onStatus: (String) -> Unit,
) {
    private val guard = PinGuard()
    val pin: String get() = guard.pin

    private val ctlThread = HandlerThread("usb-ctl").apply { start() }
    private val ctl = Handler(ctlThread.looper)
    private var server: ServerSocket? = null
    private var acceptThread: Thread? = null
    @Volatile private var stopped = false
    private val handshakes = AtomicInteger(0)

    /** Sessão autenticada atual (no máximo uma). Escrita sob `synchronized(this)`. */
    @Volatile private var current: Session? = null

    // Estado do encoder: só na thread usb-ctl (exceto o que está sob videoLock).
    private var shortSide = 720
    private var fps = 60
    private var pendingStart: Runnable? = null
    private val sizeSupported by lazy { ScreenEncoder.sizeChecker() }

    private val videoLock = Any()
    private var infoPending = false // sob videoLock
    private var lastConfig: ByteArray? = null // sob videoLock
    @Volatile private var lastKeyRequest = 0L

    private val encoderListener = object : ScreenEncoder.Listener {
        override fun onConfig(config: ByteArray) {
            val s = current ?: return
            synchronized(videoLock) {
                if (!infoPending && lastConfig?.contentEquals(config) == true) return
                lastConfig = config
                if (infoPending) {
                    val p = encoder.params ?: return
                    val codec = UsbWire.codecFromAnnexB(config) ?: "avc1.42C01F"
                    s.send(UsbWire.INFO, UsbWire.infoJson(p.width, p.height, p.fps, codec).toByteArray())
                    infoPending = false
                    status("navegador conectado ✔ (${p.width}×${p.height}, ${p.fps} fps)")
                }
                s.send(UsbWire.VIDEO_CONFIG, config)
            }
        }

        override fun onFrame(key: Boolean, ptsUs: Long, data: java.nio.ByteBuffer) {
            val s = current ?: return
            if (synchronized(videoLock) { infoPending }) {
                // Encoder que só manda SPS/PPS dentro do IDR (sem csd): extrai daqui para gerar INFO + CONFIG.
                val cfg = if (key) UsbWire.parameterSets(ByteArray(data.remaining()).also { data.duplicate().get(it) }) else null
                if (cfg != null) onConfig(cfg)
                if (synchronized(videoLock) { infoPending }) return // sem INFO/CONFIG: o navegador não decodificaria
            }
            val type = if (key) UsbWire.VIDEO_KEY else UsbWire.VIDEO_DELTA
            if (s.queue.offer(FrameQueue.Item(type, UsbWire.encodeVideo(type, ptsUs, data)))) {
                // Fila cheia (USB lento): deltas descartados até o próximo IDR → pede um já.
                val now = SystemClock.elapsedRealtime()
                if (now - lastKeyRequest > 300) {
                    lastKeyRequest = now
                    encoder.requestKeyFrame()
                }
            }
        }

        override fun onError(e: Exception) {
            Log.e(TAG, "encoder", e)
            ctl.post { current?.close("ENCODER: ${e.javaClass.simpleName}: ${e.message}") }
        }
    }

    private val encoder: ScreenEncoder =
        ScreenEncoder(projection, ctx.resources.displayMetrics.densityDpi, encoderListener)

    // ------------------------------------------------------------------ ciclo de vida

    /** Abre a porta. Lança IOException se não der (ex.: porta ocupada). */
    fun start() {
        val ss = ServerSocket()
        ss.reuseAddress = true
        ss.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), UsbWire.PORT), 4)
        server = ss
        acceptThread = Thread({ acceptLoop(ss) }, "usb-accept").also { it.start() }
        status("aguardando o navegador")
    }

    fun stop() {
        if (stopped) return
        stopped = true
        try { server?.close() } catch (_: IOException) {}
        val s = synchronized(this) { current.also { current = null } }
        s?.finish()
        GameAccessibilityService.instance?.injector?.releaseAll()
        val done = CountDownLatch(1)
        ctl.post {
            pendingStart?.let { ctl.removeCallbacks(it) }
            try { encoder.release() } catch (e: Exception) { Log.w(TAG, "release", e) }
            done.countDown()
        }
        done.await(3, TimeUnit.SECONDS)
        ctlThread.quitSafely()
        acceptThread?.join(1_000)
    }

    /** Rotação / mudança de tamanho da tela: reinicia o encoder se o tamanho do vídeo mudou. */
    fun onDisplayChanged() {
        ctl.post {
            val p = encoder.params ?: return@post
            if (current == null) return@post
            val n = computeParams()
            if (n.width != p.width || n.height != p.height) restartEncoder()
        }
    }

    // ------------------------------------------------------------------ conexões

    private fun acceptLoop(ss: ServerSocket) {
        while (!stopped) {
            val s = try { ss.accept() } catch (e: IOException) {
                if (stopped) break
                Log.w(TAG, "accept", e)
                SystemClock.sleep(200)
                continue
            }
            // O adbd conecta de dentro do aparelho; qualquer outra origem é recusada.
            if (!s.inetAddress.isLoopbackAddress || handshakes.incrementAndGet() > 2) {
                if (s.inetAddress.isLoopbackAddress) handshakes.decrementAndGet()
                closeQuietly(s)
                continue
            }
            Thread({
                try { handshake(s) } catch (e: Exception) { Log.w(TAG, "handshake", e); closeQuietly(s) }
                finally { handshakes.decrementAndGet() }
            }, "usb-hello").start()
        }
    }

    private fun handshake(s: Socket) {
        s.tcpNoDelay = true
        s.soTimeout = 5_000
        val input = BufferedInputStream(s.getInputStream(), 64 * 1024)
        fun reject(msg: String) {
            try { s.getOutputStream().apply { write(UsbWire.encodeText(UsbWire.ERROR, msg)); flush() } } catch (_: IOException) {}
            closeQuietly(s)
        }
        val hello = try { UsbWire.read(input) } catch (_: SocketTimeoutException) {
            return reject("TIMEOUT: o navegador não enviou o PIN a tempo")
        } catch (e: IOException) {
            return reject("PROTOCOL: ${e.message}")
        }
        if (hello == null) return closeQuietly(s)
        if (hello.type != UsbWire.HELLO) return reject("PROTOCOL: esperava HELLO")
        when (val r = guard.check(hello.payload)) {
            is PinGuard.Result.Wrong -> {
                status("PIN errado recebido (restam ${r.remaining} tentativas)")
                return reject("PIN_INVALID: PIN incorreto (restam ${r.remaining} tentativas antes do bloqueio)")
            }
            is PinGuard.Result.Locked -> {
                val sec = (r.remainingMs + 999) / 1000
                status("bloqueado por $sec s após PINs errados")
                return reject("LOCKED: muitas tentativas com PIN errado; aguarde $sec s")
            }
            PinGuard.Result.Ok -> {}
        }
        s.soTimeout = 0
        val session = Session(s, input)
        val old = synchronized(this) {
            if (stopped) return closeQuietly(s)
            current.also { current = session }
        }
        old?.close("REPLACED: outra aba/navegador conectou com o PIN")
        // Navegador novo: zera gerações do injetor e anuncia a entrada v2 (o site antigo ignora o CTRL).
        GameAccessibilityService.instance?.injector?.newSession()
        session.send(UsbWire.CTRL, InputCtrl.CAPS_JSON.toByteArray(Charsets.UTF_8))
        session.startThreads()
        ctl.post { scheduleStart(session) }
    }

    // ------------------------------------------------------------------ encoder (thread usb-ctl)

    private fun screenPx(): Pair<Int, Int> {
        val m = DisplayMetrics()
        @Suppress("DEPRECATION")
        (ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(m)
        return m.widthPixels to m.heightPixels
    }

    private fun computeParams(): ScreenEncoder.Params {
        val (sw, sh) = screenPx()
        val (w, h) = ScreenEncoder.fitSize(sw, sh, shortSide, sizeSupported)
        return ScreenEncoder.Params(w, h, fps, ScreenEncoder.bitrateFor(minOf(w, h), fps))
    }

    /** Espera um instante pelo CTRL quality que o navegador manda logo após o HELLO (evita dois reinícios). */
    private fun scheduleStart(session: Session) {
        pendingStart?.let { ctl.removeCallbacks(it) }
        val r = Runnable {
            pendingStart = null
            if (current === session) restartEncoder()
        }
        pendingStart = r
        ctl.postDelayed(r, 150)
    }

    private fun restartEncoder() {
        encoder.stop() // antes de marcar infoPending: nenhum quadro do encoder antigo escapa depois
        synchronized(videoLock) {
            infoPending = true
            lastConfig = null
        }
        val p = computeParams()
        try {
            encoder.start(p)
        } catch (e: Exception) {
            Log.e(TAG, "start", e)
            current?.close("ENCODER: não foi possível iniciar o H.264 ${p.width}×${p.height}: ${e.message}")
        }
    }

    private fun onCtrl(json: String, from: Session, receivedNs: Long) {
        val msg = try { JSONObject(json) } catch (_: Exception) { return }
        // input (deadman/perfil) e ping: a resposta entra na fila de saída como qualquer CTRL (atrás de quadros de
        // vídeo já enfileirados; ver "ping/pong" em docs/USB_PROTOCOLO.md)
        if (InputCtrl.handle(msg, receivedNs) { reply -> if (current === from) from.send(UsbWire.CTRL, reply.toByteArray(Charsets.UTF_8)) }) return
        when (msg.optString("type")) {
            // rotate / nav (app 0.3.0+). Girar dispara onDisplayChanged → encoder reinicia → INFO+CONFIG+KEY novos.
            "rotate", "nav" -> {
                val cmd = RemoteCommand.from(msg.optString("type"), msg.optString("mode"), msg.optString("action"))
                RemoteControl.handle(ctx, cmd) { reply ->
                    if (current === from) from.send(UsbWire.CTRL, reply.toByteArray(Charsets.UTF_8))
                }
            }
            "quality" -> {
                val side = if (msg.optInt("height", shortSide) >= 1080) 1080 else 720
                val f = if (msg.optInt("fps", fps) >= 60) 60 else 30
                ctl.post {
                    if (side == shortSide && f == fps) return@post
                    shortSide = side
                    fps = f
                    // Se o início ainda está agendado, ele já usa os valores novos.
                    if (pendingStart == null && encoder.isRunning) restartEncoder()
                }
            }
            "keyframe" -> encoder.requestKeyFrame()
        }
    }

    private fun onSessionGone() {
        ctl.post {
            if (current != null) return@post // outra sessão já assumiu
            pendingStart?.let { ctl.removeCallbacks(it) }
            pendingStart = null
            encoder.stop()
            if (!stopped) status("navegador desconectado; aguardando nova conexão")
        }
    }

    private fun status(s: String) {
        if (!stopped) onStatus("Modo USB — PIN $pin — $s")
    }

    // ------------------------------------------------------------------ sessão

    private inner class Session(private val socket: Socket, private val input: InputStream) {
        val queue = FrameQueue()
        private val closing = AtomicBoolean(false)
        private val finished = AtomicBoolean(false)
        @Volatile private var warnedNoAccessibility = false

        fun send(type: Int, payload: ByteArray) {
            queue.offer(FrameQueue.Item(type, UsbWire.encode(type, payload)))
        }

        fun startThreads() {
            Thread(::readLoop, "usb-read").start()
            Thread(::writeLoop, "usb-write").start()
        }

        private fun readLoop() {
            // A thread de leitura dorme no socket; quando acorda é para entregar um toque ao injetor: prioridade de
            // display (a mesma faixa das threads de UI), sem passar pela main thread.
            try { Process.setThreadPriority(Process.THREAD_PRIORITY_DISPLAY) } catch (_: Exception) {}
            val scratch = UsbWire.Scratch()
            try {
                while (!closing.get()) {
                    val f = UsbWire.read(input, scratch) ?: break
                    when (f.type) {
                        UsbWire.INPUT -> onInput(f.payload)
                        UsbWire.CTRL -> {
                            val t = System.nanoTime()
                            onCtrl(String(f.payload, 0, f.length, Charsets.UTF_8), this, t)
                        }
                        else -> {} // HELLO repetido / tipos desconhecidos: ignorados
                    }
                }
                close(null)
            } catch (e: UsbWire.WireException) {
                close("PROTOCOL: ${e.message}")
            } catch (_: IOException) {
                close(null)
            }
        }

        private fun onInput(bytes: ByteArray) {
            val packet = InputProtocol.decode(bytes) ?: return // decode copia os campos: o buffer pode ser reusado
            val injector = GameAccessibilityService.instance?.injector
            if (injector == null) {
                if (!warnedNoAccessibility) {
                    warnedNoAccessibility = true
                    status("ative o serviço de acessibilidade para receber toques")
                }
                return
            }
            injector.handle(packet)
        }

        private fun writeLoop() {
            try {
                val out = BufferedOutputStream(socket.getOutputStream(), 256 * 1024)
                while (!finished.get()) {
                    val item = queue.take(500) ?: continue
                    out.write(item.bytes)
                    if (queue.size == 0) out.flush()
                }
            } catch (_: IOException) {
                close(null)
            }
        }

        /** Fecha a sessão; com [error], o ERROR é enviado antes (pela própria fila, sem misturar bytes). */
        fun close(error: String?) {
            if (!closing.compareAndSet(false, true)) return
            GameAccessibilityService.instance?.injector?.releaseAll()
            val wasCurrent = synchronized(this@UsbStreamServer) {
                (current === this).also { if (it) current = null }
            }
            if (error != null) {
                queue.offer(FrameQueue.Item(UsbWire.ERROR, UsbWire.encodeText(UsbWire.ERROR, error)))
                Thread {
                    SystemClock.sleep(300) // tempo para a thread de escrita mandar o ERROR
                    finish()
                }.start()
            } else finish()
            if (wasCurrent) onSessionGone()
        }

        /** Libera tudo imediatamente (desbloqueia as threads de leitura/escrita). */
        fun finish() {
            closing.set(true)
            if (!finished.compareAndSet(false, true)) return
            queue.close()
            closeQuietly(socket)
            GameAccessibilityService.instance?.injector?.releaseAll()
        }
    }

    private companion object {
        const val TAG = "UsbStreamServer"
        fun closeQuietly(s: Socket) {
            try { s.close() } catch (_: IOException) {}
        }
    }
}
