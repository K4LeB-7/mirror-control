package com.mirror.gamecontrol

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Pacote de entrada do notebook (18 bytes, little-endian). Espelha lib/protocol.ts.
 *
 * Extensão compatível (site 0.3.1+): em DOWN/UP o campo dx (sem uso nessas ações) leva a GERAÇÃO do toque, um
 * inteiro ≥ 1 em float32. Com ela o celular reconhece DOWN/UP repetidos (redundância contra perda no WebRTC) e
 * keepalive. dx = 0 (site antigo) = gen 0 = comportamento antigo. Ver docs/USB_PROTOCOLO.md ("Entrada").
 */
object InputProtocol {
    const val DOWN = 1
    const val MOVE = 2
    const val UP = 3
    const val LOOK = 4
    const val RELEASE_ALL = 5
    const val PACKET_SIZE = 18
    /** Maior inteiro representável exatamente em float32. */
    const val MAX_GEN = 1 shl 24
    /**
     * Celular → site (canal ctrl / CTRL do USB), ao abrir a conexão: entrada v2 = gerações + deadman. O site então
     * manda `{"type":"input","deadmanMs":N}` e passa a enviar DOWN/UP redundantes e keepalive.
     */
    const val CAPS_JSON = InputCtrl.CAPS_JSON

    data class Packet(
        val action: Int,
        val pointer: Int,
        val x: Float,
        val y: Float,
        val dx: Float,
        val dy: Float,
        /** Geração do toque em DOWN/UP (0 = sem geração / site antigo). */
        val gen: Int = 0,
    )

    fun decode(bytes: ByteArray): Packet? {
        if (bytes.size != PACKET_SIZE) return null
        return decode(ByteBuffer.wrap(bytes))
    }

    /** Lê a partir da posição atual de [buf] (não altera posição nem ordem do buffer). */
    fun decode(buf: ByteBuffer): Packet? {
        if (buf.remaining() != PACKET_SIZE) return null
        val b = buf.duplicate().order(ByteOrder.LITTLE_ENDIAN)
        val o = b.position()
        val action = b.get(o).toInt() and 0xFF
        val pointer = b.get(o + 1).toInt() and 0xFF
        if (pointer > 9) return null
        val x = b.getFloat(o + 2)
        val y = b.getFloat(o + 6)
        val dx = b.getFloat(o + 10)
        val dy = b.getFloat(o + 14)
        if (!(x.isFinite() && y.isFinite() && dx.isFinite() && dy.isFinite())) return null
        val gen = if (action == DOWN || action == UP) genOf(dx) else 0
        return Packet(action, pointer, x.coerceIn(0f, 1f), y.coerceIn(0f, 1f), dx.coerceIn(-1f, 1f), dy.coerceIn(-1f, 1f), gen)
    }

    private fun genOf(v: Float): Int {
        if (v < 1f || v > MAX_GEN) return 0
        val i = v.toInt()
        return if (i.toFloat() == v) i else 0
    }
}
