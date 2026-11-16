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
    private var gotOpen = false

    /**
     * O PeerServer NÃO manda "OPEN" quando o mesmo id+token reconecta antes de ele notar a queda do
     * socket antigo (só troca o socket). Sem isso o app ficava sem heartbeat e sem renegociar.
     */
    private val assumeOpen = Runnable {
        if (!closed && !gotOpen) {
            gotOpen = true
            attempts = 0
            onStatus("Sinalização reconectada")
            onOpen()
        }
    }

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
        gotOpen = false
        ws = http.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                main.post {
                    if (webSocket !== ws || closed) return@post
                    main.removeCallbacks(heartbeat)
                    main.postDelayed(heartbeat, 5000)
                    main.removeCallbacks(assumeOpen)
                    main.postDelayed(assumeOpen, 2000)
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val obj = try { JSONObject(text) } catch (e: Exception) { return }
                main.post {
                    if (webSocket !== ws || closed) return@post
                    when (val type = obj.optString("type")) {
                        "OPEN" -> {
                            main.removeCallbacks(assumeOpen)
                            gotOpen = true
                            attempts = 0
                            onStatus("Sinalização conectada")
                            onOpen()
                        }
                        "ID-TAKEN", "ERROR" -> {
                            main.removeCallbacks(assumeOpen)
                            gotOpen = true // não é "reconectado"; o socket será fechado pelo servidor → retry()
                            onStatus(if (type == "ID-TAKEN") "ID já em uso; tentando de novo…"
                                     else "Erro na sinalização: ${obj.optJSONObject("payload")?.optString("msg")}")
                        }
                        else -> this@Signaling.onMessage(type, obj.optString("src").ifEmpty { null }, obj.optJSONObject("payload"))
                    }
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = retry(webSocket)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = retry(webSocket)
        })
    }

    fun send(type: String, dst: String, payload: JSONObject) {
        val msg = JSONObject().put("type", type).put("dst", dst).put("payload", payload)
        ws?.send(msg.toString())
    }

    fun close() {
        closed = true
        main.removeCallbacks(heartbeat)
        main.removeCallbacks(assumeOpen)
        ws?.close(1000, null)
        http.dispatcher.executorService.shutdown()
    }

    private fun retry(socket: WebSocket) {
        main.post {
            // Só o socket atual pode disparar reconexão (evita conexões duplicadas).
            if (closed || socket !== ws) return@post
            ws = null
            main.removeCallbacks(heartbeat)
            main.removeCallbacks(assumeOpen)
            val delay = minOf(1000L shl attempts.coerceAtMost(4), 15000L)
            attempts++
            onStatus("Sinalização caiu; tentando de novo…")
            main.postDelayed({ connect() }, delay)
        }
    }
}
