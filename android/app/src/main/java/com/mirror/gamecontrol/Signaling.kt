package com.mirror.gamecontrol

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Cliente mínimo do protocolo do PeerServer (o mesmo usado pelo PeerJS no navegador).
 * Só usamos o relay de OFFER / ANSWER / CANDIDATE.
 */
class Signaling(
    private val host: String,
    private val port: Int,
    private val path: String,
    private val key: String,
    private val secure: Boolean,
    private val myId: String,
    private val onOpen: () -> Unit,
    private val onMessage: (type: String, src: String?, payload: JSONObject?) -> Unit,
    private val onStatus: (String) -> Unit,
) {
    private val http = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private val main = Handler(Looper.getMainLooper())
    private val token = java.util.UUID.randomUUID().toString().take(10)
    private var ws: WebSocket? = null
    private var closed = false
    private var attempts = 0

    private val heartbeat = object : Runnable {
        override fun run() {
            ws?.send("""{"type":"HEARTBEAT"}""")
            if (!closed) main.postDelayed(this, 5000)
        }
    }

    fun connect() {
        if (closed) return
        val scheme = if (secure) "wss" else "ws"
        val url = "$scheme://$host:$port${path}peerjs?key=$key&id=$myId&token=$token"
        onStatus("Conectando à sinalização…")
        ws = http.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val obj = try { JSONObject(text) } catch (e: Exception) { return }
                when (val type = obj.optString("type")) {
                    "OPEN" -> {
                        attempts = 0
                        main.removeCallbacks(heartbeat)
                        main.postDelayed(heartbeat, 5000)
                        main.post { onStatus("Sinalização conectada"); onOpen() }
                    }
                    "ID-TAKEN" -> { close(); main.post { onStatus("ID já em uso") } }
                    else -> main.post { this@Signaling.onMessage(type, obj.optString("src").ifEmpty { null }, obj.optJSONObject("payload")) }
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = retry()
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = retry()
        })
    }

    fun send(type: String, dst: String, payload: JSONObject) {
        val msg = JSONObject().put("type", type).put("dst", dst).put("payload", payload)
        ws?.send(msg.toString())
    }

    fun close() {
        closed = true
        main.removeCallbacks(heartbeat)
        ws?.close(1000, null)
        http.dispatcher.executorService.shutdown()
    }

    private fun retry() {
        if (closed) return
        main.removeCallbacks(heartbeat)
        val delay = minOf(1000L shl attempts.coerceAtMost(4), 15000L)
        attempts++
        main.post { onStatus("Sinalização caiu; tentando de novo…") }
        main.postDelayed({ connect() }, delay)
    }
}
