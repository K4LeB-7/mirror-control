package com.mirror.gamecontrol

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.File
import java.io.InputStream

/** Mesmos vetores de web/tests/usbWire.test.ts: docs/usb-protocol-vectors.txt. */
class UsbWireTest {
    private class Vec(val name: String, val type: Int, val pts: Long?, val data: ByteArray, val frame: ByteArray)

    private val lines: List<List<String>> by lazy {
        var dir: File? = File("").absoluteFile
        var f: File? = null
        while (dir != null && f == null) {
            File(dir, "docs/usb-protocol-vectors.txt").takeIf { it.exists() }?.let { f = it }
            dir = dir.parentFile
        }
        val file = f ?: error("docs/usb-protocol-vectors.txt não encontrado")
        file.readLines().filter { it.isNotBlank() && !it.startsWith("#") }.map { l -> l.split("|").map { it.trim() } }
    }

    private fun unhex(h: String) = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it.toInt() and 0xFF) }

    private val frames by lazy {
        lines.filter { it[0] == "frame" }.map {
            Vec(it[1], it[2].toInt(16), if (it[3] == "-") null else it[3].toLong(), unhex(it[4]), unhex(it[5]))
        }
    }

    /** Entrega no máximo [step] bytes por read(): simula o TCP fragmentado. */
    private class Trickle(private val b: ByteArray, private val step: Int) : InputStream() {
        private var pos = 0
        override fun read(): Int = if (pos < b.size) b[pos++].toInt() and 0xFF else -1
        override fun read(dst: ByteArray, off: Int, len: Int): Int {
            if (pos >= b.size) return -1
            val n = minOf(len, step, b.size - pos)
            System.arraycopy(b, pos, dst, off, n)
            pos += n
            return n
        }
    }

    @Test fun vectorsCoverEveryType() {
        val types = frames.map { it.type }.toSet()
        for (t in listOf(UsbWire.VIDEO_CONFIG, UsbWire.VIDEO_KEY, UsbWire.VIDEO_DELTA, UsbWire.INPUT, UsbWire.CTRL,
            UsbWire.HELLO, UsbWire.INFO, UsbWire.ERROR)) assertTrue("tipo $t", t in types)
        assertTrue(lines.count { it[0] == "invalid" } >= 8)
    }

    @Test fun encodeMatchesVectors() {
        for (v in frames) {
            val out = if (v.pts == null) UsbWire.encode(v.type, v.data) else UsbWire.encodeVideo(v.type, v.pts, v.data)
            assertEquals(v.name, hex(v.frame), hex(out))
        }
    }

    @Test fun encodeVideoFromSlice() {
        val v = frames.first { it.name == "video_key" }
        val padded = byteArrayOf(9, 9) + v.data + byteArrayOf(9)
        assertEquals(hex(v.frame), hex(UsbWire.encodeVideo(v.type, v.pts!!, padded, 2, v.data.size)))
    }

    @Test fun decodeEachVector() {
        for (v in frames) {
            val input = ByteArrayInputStream(v.frame)
            val f = UsbWire.read(input)!!
            assertEquals(v.name, v.type, f.type)
            if (v.pts == null) assertArrayEquals(v.name, v.data, f.payload)
            else {
                assertEquals(v.name, v.pts, UsbWire.videoPts(f.payload))
                assertArrayEquals(v.name, v.data, UsbWire.videoData(f.payload))
            }
            assertNull(UsbWire.read(input)) // EOF limpo
        }
    }

    @Test fun fragmentedStream() {
        val all = frames.fold(ByteArray(0)) { acc, v -> acc + v.frame }
        for (step in listOf(1, 2, 3, 7, 64, all.size)) {
            val input = Trickle(all, step)
            val got = generateSequence { UsbWire.read(input) }.toList()
            assertEquals("passo $step", frames.map { it.type }, got.map { it.type })
            assertEquals(frames.map { hex(it.frame) }, got.map { hex(UsbWire.encode(it.type, it.payload)) })
        }
    }

    @Test fun eofMidFrameThrows() {
        val v = frames.first { it.name == "info" }
        try {
            UsbWire.read(ByteArrayInputStream(v.frame.copyOf(v.frame.size - 1)))
            fail("devia lançar EOFException")
        } catch (_: EOFException) {
        }
    }

    @Test fun invalidVectorsRejectedAtHeader() {
        for (l in lines.filter { it[0] == "invalid" }) {
            val bytes = unhex(l[2])
            for (b in listOf(bytes, bytes.copyOf(5))) {
                try {
                    UsbWire.read(ByteArrayInputStream(b))
                    fail("${l[1]} devia ser rejeitado")
                } catch (_: UsbWire.WireException) {
                }
            }
        }
    }

    @Test fun encodeRejectsBadSizes() {
        for (bad in listOf({ UsbWire.encode(UsbWire.INPUT, ByteArray(17)) },
            { UsbWire.encode(UsbWire.HELLO, ByteArray(0)) },
            { UsbWire.encode(UsbWire.VIDEO_CONFIG, ByteArray(UsbWire.MAX_VIDEO_PAYLOAD + 1)) })) {
            try { bad(); fail() } catch (_: UsbWire.WireException) {}
        }
    }

    @Test fun unknownSmallTypeAccepted() {
        assertEquals(0x55, UsbWire.read(ByteArrayInputStream(unhex("5502000000abcd")))!!.type)
    }

    @Test fun writeEqualsEncode() {
        val o = ByteArrayOutputStream()
        UsbWire.write(o, UsbWire.HELLO, "123456".toByteArray())
        assertEquals(hex(frames.first { it.name == "hello" }.frame), hex(o.toByteArray()))
    }

    @Test fun codecFromSps() {
        for (l in lines.filter { it[0] == "codec" }) assertEquals(l[2], UsbWire.codecFromAnnexB(unhex(l[1])))
        assertNull(UsbWire.codecFromAnnexB(unhex("0000000168ce3c80")))
    }

    @Test fun inputPayloadDecodesWithInputProtocol() {
        val v = frames.first { it.name == "input" }
        val p = InputProtocol.decode(v.data)!!
        assertEquals(InputProtocol.DOWN, p.action)
        assertEquals(3, p.pointer)
        assertEquals(0.5f, p.x)
        assertEquals(0.25f, p.y)
        assertEquals(-0.125f, p.dx)
        assertEquals(0.0625f, p.dy)
    }

    @Test fun infoJsonShape() {
        assertEquals("{\"width\":1280,\"height\":576,\"fps\":60,\"codec\":\"avc1.42C01F\",\"version\":1}",
            UsbWire.infoJson(1280, 576, 60, "avc1.42C01F"))
    }
}

class UsbWireParameterSetsTest {
    private fun unhex(h: String) = ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    @Test fun extractsSpsPpsFromIdr() {
        val idr = unhex("00000001" + "0910" + "000000016742c01f" + "00000168ce3c80" + "0000000165888400")
        assertArrayEquals(unhex("000000016742c01f0000000168ce3c80"), UsbWire.parameterSets(idr))
        assertNull(UsbWire.parameterSets(unhex("0000000165888400")))
    }
}
