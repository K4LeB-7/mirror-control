package com.mirror.gamecontrol

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class InputProtocolTest {
    private fun packet(a: Int, k: Int, x: Float, y: Float, dx: Float, dy: Float): ByteArray =
        ByteBuffer.allocate(18).order(ByteOrder.LITTLE_ENDIAN).apply {
            put(a.toByte()); put(k.toByte()); putFloat(x); putFloat(y); putFloat(dx); putFloat(dy)
        }.array()

    @Test fun generationOnlyInDownUp() {
        assertEquals(7, InputProtocol.decode(packet(1, 3, 0.5f, 0.5f, 7f, 0f))!!.gen)
        assertEquals(123456, InputProtocol.decode(packet(3, 3, 0f, 0f, 123456f, 0f))!!.gen)
        assertEquals(0, InputProtocol.decode(packet(1, 3, 0f, 0f, 0f, 0f))!!.gen) // site antigo
        assertEquals(0, InputProtocol.decode(packet(1, 3, 0f, 0f, 2.5f, 0f))!!.gen) // não inteiro
        assertEquals(0, InputProtocol.decode(packet(2, 3, 0f, 0f, 7f, 0f))!!.gen) // MOVE não tem gen
        val look = InputProtocol.decode(packet(4, 9, 0.5f, 0.5f, 7f, -3f))!!
        assertEquals(0, look.gen)
        assertEquals(1f, look.dx) // LOOK continua preso em ±1
        assertEquals(-1f, look.dy)
    }

    @Test fun byteBufferDecodeMatchesArrayAndKeepsPosition() {
        val bytes = packet(1, 8, 0.25f, 0.75f, 42f, 0f)
        val direct = ByteBuffer.allocateDirect(18).put(bytes)
        direct.flip()
        val a = InputProtocol.decode(bytes)
        val b = InputProtocol.decode(direct)
        assertEquals(a, b)
        assertEquals(0, direct.position())
        assertEquals(42, b!!.gen)
    }

    @Test fun rejectsBadPackets() {
        assertNull(InputProtocol.decode(ByteArray(17)))
        assertNull(InputProtocol.decode(packet(1, 10, 0f, 0f, 0f, 0f)))
        assertNull(InputProtocol.decode(packet(1, 1, Float.NaN, 0f, 0f, 0f)))
    }

    @Test fun capsJsonIsValid() {
        assertEquals("{\"type\":\"caps\",\"input\":2}", InputProtocol.CAPS_JSON)
    }

    @Test fun videoFrameFromByteBufferEqualsArrayVersion() {
        val data = ByteArray(300) { (it * 7).toByte() }
        val buf = ByteBuffer.allocateDirect(400)
        buf.position(50)
        buf.put(data)
        buf.position(50).limit(350)
        val fromBuf = UsbWire.encodeVideo(UsbWire.VIDEO_DELTA, 123_456L, buf)
        assertArrayEquals(UsbWire.encodeVideo(UsbWire.VIDEO_DELTA, 123_456L, data), fromBuf)
        assertEquals(50, buf.position())
    }
}
