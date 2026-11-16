package com.mirror.gamecontrol

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.os.Handler
import android.os.Looper
import android.util.DisplayMetrics
import android.view.WindowManager
import org.json.JSONObject
import org.webrtc.*

/**
 * Lado "celular": captura a tela (MediaProjection), envia por WebRTC e recebe os comandos do
 * notebook num DataChannel não confiável/não ordenado.
 *
 * O celular é quem faz a OFFER (tem a track de vídeo e cria os DataChannels). Se a conexão
 * cair ou o par não responder, refazemos a negociação sozinhos (fallback de reconexão P2P).
 */
class RtcClient(
    private val ctx: Context,
    private val projectionData: Intent,
    private val roomId: String,
    private val onStatus: (String) -> Unit,
    private val onStopped: () -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private val myId = "m" + java.util.UUID.randomUUID().toString().replace("-", "").take(11)

    private var eglBase: EglBase? = null
    private var factory: PeerConnectionFactory? = null
    private var videoSource: VideoSource? = null
    private var videoTrack: VideoTrack? = null
    private var capturer: ScreenCapturerAndroid? = null
    private var textureHelper: SurfaceTextureHelper? = null
    private var pc: PeerConnection? = null
    private var sender: RtpSender? = null
    private var signaling: Signaling? = null
    private var inputChannel: DataChannel? = null
    private var ctrlChannel: DataChannel? = null

    private var qualityHeight = 720
    private var qualityFps = 60
    private var disposed = false
    private var warnedNoAccessibility = false

    // Candidatos só podem seguir DEPOIS da oferta; senão o navegador os descarta.
    private var offerSent = false
    private val queuedCandidates = mutableListOf<JSONObject>()

    private val iceServers = listOf(
        PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer(),
    )

    // ---------------------------------------------------------------- ciclo de vida

    fun start() {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(ctx.applicationContext).createInitializationOptions()
        )
        val egl = EglBase.create().also { eglBase = it }
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()

        videoSource = factory!!.createVideoSource(true /* isScreencast */)
        videoTrack = factory!!.createVideoTrack("screen", videoSource)
        textureHelper = SurfaceTextureHelper.create("capture", egl.eglBaseContext)
        capturer = ScreenCapturerAndroid(projectionData, object : MediaProjection.Callback() {
            override fun onStop() {
                main.post { if (!disposed) onStopped() }
            }
        }).also {
            it.initialize(textureHelper, ctx.applicationContext, videoSource!!.capturerObserver)
            val (w, h) = captureSize()
            it.startCapture(w, h, qualityFps)
        }

        signaling = Signaling(
            host = "0.peerjs.com", port = 443, path = "/", key = "peerjs", secure = true,
            myId = myId,
            onOpen = { negotiate() },
            onMessage = ::onSignal,
            onStatus = onStatus,
        ).also { it.connect() }
    }

    fun dispose() {
        if (disposed) return
        disposed = true
        main.removeCallbacksAndMessages(null)
        GameAccessibilityService.instance?.injector?.releaseAll()
        signaling?.close()
        closePc()
        try { capturer?.stopCapture() } catch (_: Exception) {}
        capturer?.dispose()
        textureHelper?.dispose()
        videoTrack?.dispose()
        videoSource?.dispose()
        factory?.dispose()
        eglBase?.release()
    }

    /** Chamado pelo Service quando a tela gira: ajusta a captura SEM derrubar a conexão. */
    fun onDisplayChanged() {
        if (disposed) return
        applyQuality(qualityHeight, qualityFps)
    }

    // ---------------------------------------------------------------- qualidade

    private fun screenPx(): Pair<Int, Int> {
        val m = DisplayMetrics()
        @Suppress("DEPRECATION")
        (ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.getRealMetrics(m)
        return m.widthPixels to m.heightPixels
    }

    /** `qualityHeight` é o lado menor (720/1080), seja retrato ou paisagem. */
    private fun captureSize(): Pair<Int, Int> {
        val (w, h) = screenPx()
        val scale = qualityHeight.toFloat() / minOf(w, h)
        fun even(v: Float) = (v.toInt() / 2) * 2
        return even(w * scale) to even(h * scale)
    }

    fun applyQuality(height: Int, fps: Int) {
        qualityHeight = if (height >= 1080) 1080 else 720
        qualityFps = if (fps >= 60) 60 else 30
        val (w, h) = captureSize()
        capturer?.changeCaptureFormat(w, h, qualityFps)
        val bitrate = (if (qualityHeight == 1080) 10_000_000 else 6_000_000) * qualityFps / 60
        sender?.let { s ->
            val p = s.parameters
            p.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_FRAMERATE
            p.encodings.forEach { e ->
                e.maxBitrateBps = bitrate
                e.maxFramerate = qualityFps
            }
            s.setParameters(p)
        }
    }

    // ---------------------------------------------------------------- negociação

    /** Sem ANSWER em 10 s: o site provavelmente ainda não estava aberto → oferece de novo. */
    private val retryNoAnswer = Runnable {
        onStatus("Sem resposta do navegador; tentando de novo…")
        negotiate(force = true)
    }

    /** Respondeu mas o ICE não fechou em 30 s (rede bloqueada/NAT) → recomeça. */
    private val retryIce = Runnable {
        onStatus("ICE não conectou em 30 s (rede diferente/bloqueada?); tentando de novo…")
        negotiate(force = true)
    }

    private fun negotiate(force: Boolean = false) {
        if (disposed) return
        if (!force && pc?.connectionState() == PeerConnection.PeerConnectionState.CONNECTED) return
        main.removeCallbacks(retryNoAnswer)
        main.removeCallbacks(retryIce)
        closePc()
        offerSent = false
        queuedCandidates.clear()
        val f = factory ?: return

        val config = PeerConnection.RTCConfiguration(iceServers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        val connection = f.createPeerConnection(config, PcObserver()) ?: return
        pc = connection

        sender = connection.addTrack(videoTrack, listOf("screen-stream"))
        applyQuality(qualityHeight, qualityFps)

        // Entrada: não confiável e não ordenada → latência mínima, pacote velho é descartado.
        inputChannel = connection.createDataChannel("input", DataChannel.Init().apply {
            ordered = false
            maxRetransmits = 0
        })?.also { it.registerObserver(InputObserver(it)) }
        // Controle (qualidade etc.): confiável, JSON, baixo volume.
        ctrlChannel = connection.createDataChannel("ctrl", DataChannel.Init())?.also {
            it.registerObserver(CtrlObserver(it))
        }

        connection.createOffer(object : SdpAdapter() {
            override fun onCreateSuccess(desc: SessionDescription) {
                val munged = if (PREFER_H264) SessionDescription(desc.type, preferH264(desc.description)) else desc
                connection.setLocalDescription(object : SdpAdapter() {
                    override fun onSetSuccess() {
                        val payload = JSONObject().put("type", "offer").put("sdp", munged.description)
                        main.post {
                            signaling?.send("OFFER", roomId, payload)
                            offerSent = true
                            onStatus("Oferta enviada; aguardando o navegador (sala $roomId)…")
                            queuedCandidates.forEach { signaling?.send("CANDIDATE", roomId, it) }
                            queuedCandidates.clear()
                        }
                    }
                }, munged)
            }
        }, MediaConstraints())

        main.postDelayed(retryNoAnswer, 10_000)
        main.postDelayed(retryIce, 30_000)
    }

    private fun onSignal(type: String, src: String?, payload: JSONObject?) {
        if (disposed || src != roomId || payload == null) return
        val connection = pc ?: return
        when (type) {
            "ANSWER" -> {
                main.removeCallbacks(retryNoAnswer)
                onStatus("Resposta recebida; negociando a rede (ICE)…")
                connection.setRemoteDescription(
                    SdpAdapter(),
                    SessionDescription(SessionDescription.Type.ANSWER, payload.optString("sdp"))
                )
            }
            "CANDIDATE" -> connection.addIceCandidate(
                IceCandidate(
                    payload.optString("sdpMid"),
                    payload.optInt("sdpMLineIndex"),
                    payload.optString("candidate")
                )
            )
        }
    }

    private fun closePc() {
        inputChannel?.unregisterObserver(); inputChannel?.close(); inputChannel?.dispose(); inputChannel = null
        ctrlChannel?.unregisterObserver(); ctrlChannel?.close(); ctrlChannel?.dispose(); ctrlChannel = null
        sender = null
        pc?.close()
        pc?.dispose()
        pc = null
    }

    /** Coloca H.264 na frente na linha m=video (preferência da especificação; o navegador decide). */
    private companion object {
        /** H.264 por hardware pode dar tela preta em alguns aparelhos; VP8 é o padrão seguro. */
        const val PREFER_H264 = false
    }

    private fun preferH264(sdp: String): String {
        val lines = sdp.split("\r\n").toMutableList()
        val m = lines.indexOfFirst { it.startsWith("m=video") }
        if (m < 0) return sdp
        val h264 = Regex("a=rtpmap:(\\d+) H264/90000").findAll(sdp).map { it.groupValues[1] }.toSet()
        if (h264.isEmpty()) return sdp
        val parts = lines[m].split(" ")
        val payloads = parts.drop(3)
        lines[m] = (parts.take(3) + payloads.filter { it in h264 } + payloads.filter { it !in h264 }).joinToString(" ")
        return lines.joinToString("\r\n")
    }

    // ---------------------------------------------------------------- observers

    private inner class PcObserver : PeerConnection.Observer {
        override fun onIceCandidate(c: IceCandidate) {
            val payload = JSONObject()
                .put("candidate", c.sdp).put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex)
            main.post {
                if (offerSent) signaling?.send("CANDIDATE", roomId, payload) else queuedCandidates.add(payload)
            }
        }

        override fun onIceConnectionChange(s: PeerConnection.IceConnectionState) {
            main.post { if (!disposed) onStatus("ICE: ${s.name.lowercase()}") }
        }

        override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
            main.post {
                if (disposed) return@post
                when (state) {
                    PeerConnection.PeerConnectionState.CONNECTED -> {
                        main.removeCallbacks(retryNoAnswer)
                        main.removeCallbacks(retryIce)
                        onStatus("Conectado ao navegador ✔")
                    }
                    PeerConnection.PeerConnectionState.DISCONNECTED -> {
                        onStatus("Conexão instável…")
                        main.removeCallbacks(retryIce)
                        main.postDelayed(retryIce, 8000)
                    }
                    PeerConnection.PeerConnectionState.FAILED,
                    PeerConnection.PeerConnectionState.CLOSED -> {
                        onStatus("Conexão perdida; reconectando…")
                        main.removeCallbacks(retryIce)
                        main.postDelayed({ negotiate(force = true) }, 1000)
                    }
                    else -> {}
                }
            }
        }

        override fun onSignalingChange(s: PeerConnection.SignalingState) {}
        override fun onIceConnectionReceivingChange(b: Boolean) {}
        override fun onIceGatheringChange(s: PeerConnection.IceGatheringState) {}
        override fun onIceCandidatesRemoved(c: Array<out IceCandidate>) {}
        override fun onAddStream(s: MediaStream) {}
        override fun onRemoveStream(s: MediaStream) {}
        override fun onDataChannel(d: DataChannel) {}
        override fun onRenegotiationNeeded() {}
        override fun onAddTrack(r: RtpReceiver, s: Array<out MediaStream>) {}
    }

    private inner class InputObserver(private val ch: DataChannel) : DataChannel.Observer {
        override fun onMessage(buffer: DataChannel.Buffer) {
            if (!buffer.binary) return
            val bytes = ByteArray(buffer.data.remaining()).also { buffer.data.get(it) }
            val packet = InputProtocol.decode(bytes) ?: return
            val injector = GameAccessibilityService.instance?.injector
            if (injector == null) {
                if (!warnedNoAccessibility) {
                    warnedNoAccessibility = true
                    main.post { onStatus("Ative o serviço de acessibilidade para receber toques") }
                }
                return
            }
            injector.handle(packet)
        }

        override fun onBufferedAmountChange(previous: Long) {}
        override fun onStateChange() {
            // Perdeu o canal de entrada: nenhum dedo pode ficar "preso" na tela.
            if (ch.state() != DataChannel.State.OPEN) GameAccessibilityService.instance?.injector?.releaseAll()
        }
    }

    private inner class CtrlObserver(private val ch: DataChannel) : DataChannel.Observer {
        override fun onMessage(buffer: DataChannel.Buffer) {
            if (buffer.binary) return
            val bytes = ByteArray(buffer.data.remaining()).also { buffer.data.get(it) }
            try {
                val msg = JSONObject(String(bytes, Charsets.UTF_8))
                if (msg.optString("type") == "quality") {
                    val h = msg.optInt("height", qualityHeight)
                    val f = msg.optInt("fps", qualityFps)
                    main.post { if (!disposed) applyQuality(h, f) }
                }
            } catch (_: Exception) {
            }
        }

        override fun onBufferedAmountChange(previous: Long) {}
        override fun onStateChange() {}
    }

    private open class SdpAdapter : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription) {}
        override fun onSetSuccess() {}
        override fun onCreateFailure(error: String?) {}
        override fun onSetFailure(error: String?) {}
    }
}
