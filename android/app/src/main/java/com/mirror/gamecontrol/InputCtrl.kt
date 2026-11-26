package com.mirror.gamecontrol

import java.util.Locale

/**
 * Mensagens de controle da entrada (app 0.3.3), iguais no USB (quadro CTRL) e no WebRTC (canal "ctrl"). Só monta
 * texto (puro Kotlin, testado na JVM); quem recebe o JSON é UsbStreamServer/RtcClient. Ver docs/USB_PROTOCOLO.md.
 *
 * Site → celular:
 * - `{"type":"input","deadmanMs":N,"profile":"balanced|smooth|eco"}`: o site 0.3.3 manda os dois campos juntos
 *   (app 0.3.1/0.3.2 lê só deadmanMs e ignora profile). Só os campos presentes são aplicados.
 * - `{"type":"ping","t":T}`: respondido na hora com [pong].
 * Celular → site:
 * - [CAPS_JSON]: `input` 2 (gerações/deadman, 0.3.1+), `profile` 1 e `ping` 1 (0.3.3).
 * - [profileStatus]: perfil efetivamente aplicado.
 */
object InputCtrl {
    const val CAPS_JSON = "{\"type\":\"caps\",\"input\":2,\"profile\":1,\"ping\":1}"

    /**
     * Resposta ao ping: `t` = o mesmo valor do site (relógio dele), `p` = µs entre o celular receber o ping e
     * mandar o pong, `d` = mediana DOWN→dispatchGesture medida no celular (ms; -1 sem amostras), `profile`.
     * App 0.3.4+: `pm` = relógio monotônico do celular (µs, a base do PTS do vídeo) quando o pong é montado; o site
     * estima o offset de relógio com ele (linkProbe.ts). Sem relógio ([pmUs] < 0) o campo é omitido.
     */
    fun pong(t: Double, procUs: Long, downDispatchMs: Double, profile: FluidityProfile, pmUs: Long = -1): String =
        String.format(Locale.US, "{\"type\":\"pong\",\"t\":%.3f,\"p\":%d,\"d\":%.1f,\"profile\":\"%s\"%s}",
            if (t.isFinite()) t else 0.0, procUs.coerceAtLeast(0), downDispatchMs, profile.wire,
            if (pmUs >= 0) ",\"pm\":$pmUs" else "")

    fun profileStatus(p: FluidityProfile, frameMs: Int): String =
        "{\"type\":\"status\",\"scope\":\"profile\",\"ok\":true,\"profile\":\"${p.wire}\",\"frameMs\":$frameMs," +
            "\"text\":\"Fluidez no celular: ${p.label} (quadro $frameMs ms)\"}"

    /** Perfil atual (lido pelo pong de qualquer thread). */
    @Volatile var currentProfile: FluidityProfile = FluidityProfile.BALANCED

    /**
     * Trata "input" e "ping" (devolve false para os outros tipos). [receivedNs] = System.nanoTime() de quando o
     * quadro/mensagem chegou; [reply] manda texto de volta pelo mesmo caminho (pode ser chamado de outra thread).
     */
    fun handle(msg: org.json.JSONObject, receivedNs: Long, clock: PtsClock? = null, reply: (String) -> Unit): Boolean {
        val injector = GameAccessibilityService.instance?.injector
        when (msg.optString("type")) {
            "ping" -> {
                val t = msg.optDouble("t", 0.0)
                val d = injector?.downDispatchP50Ms() ?: -1.0
                reply(pong(t, (System.nanoTime() - receivedNs) / 1000, d, currentProfile, clock?.nowUs() ?: -1))
                return true
            }
            "input" -> {
                // Só os campos presentes (o site 0.3.3 manda deadmanMs e profile juntos; um app 0.3.2 lê só deadmanMs).
                if (msg.has("deadmanMs")) injector?.setDeadman(msg.optLong("deadmanMs", 0))
                val p = FluidityProfile.fromWire(msg.optString("profile", ""))
                if (p != null) {
                    currentProfile = p
                    if (injector != null) injector.setProfile(p) { applied, frame -> reply(profileStatus(applied, frame)) }
                    else reply(profileStatus(p, 0))
                }
                return true
            }
        }
        return false
    }
}
