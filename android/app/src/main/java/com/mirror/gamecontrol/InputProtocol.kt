package com.mirror.gamecontrol

import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Pacote de entrada do notebook (18 bytes, little-endian). Espelha lib/protocol.ts. */
object InputProtocol {
    const val DOWN = 1
    const val MOVE = 2
    const val UP = 3
    const val LOOK = 4
    const val RELEASE_ALL = 5
    const val PACKET_SIZE = 18

    data class Packet(
        val action: Int,
        val pointer: Int,
        val x: Float,
        val y: Float,
        val dx: Float,
        val dy: Float,
    )

    fun decode(bytes: ByteArray): Packet? {
        if (bytes.size != PACKET_SIZE) return null
        val b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val action = b.get(0).toInt() and 0xFF
        val pointer = b.get(1).toInt() and 0xFF
        if (pointer > 9) return null
        val x = b.getFloat(2)
        val y = b.getFloat(6)
        val dx = b.getFloat(10)
        val dy = b.getFloat(14)
        if (!(x.isFinite() && y.isFinite() && dx.isFinite() && dy.isFinite())) return null
        return Packet(action, pointer, x.coerceIn(0f, 1f), y.coerceIn(0f, 1f), dx.coerceIn(-1f, 1f), dy.coerceIn(-1f, 1f))
    }
}
