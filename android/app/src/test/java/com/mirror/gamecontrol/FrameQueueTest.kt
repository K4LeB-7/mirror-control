package com.mirror.gamecontrol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.concurrent.thread

class FrameQueueTest {
    private fun item(type: Int, size: Int = 10) = FrameQueue.Item(type, ByteArray(size))
    private val K = UsbWire.VIDEO_KEY
    private val D = UsbWire.VIDEO_DELTA
    private val C = UsbWire.VIDEO_CONFIG
    private val I = UsbWire.INFO

    @Test fun fifoOrder() {
        val q = FrameQueue()
        for (t in listOf(I, C, K, D, D)) assertFalse(q.offer(item(t)))
        assertEquals(listOf(I, C, K, D, D), generateSequence { q.take(0) }.map { it.type }.toList())
    }

    @Test fun fullQueueDropsDeltasAndRequestsKey() {
        val q = FrameQueue(maxFrames = 4)
        q.offer(item(I)); q.offer(item(C)); q.offer(item(K))
        repeat(3) { assertFalse(q.offer(item(D))) }
        assertTrue(q.offer(item(D))) // 5º quadro de vídeo: cheia
        assertEquals(listOf(I, C, K), q.types()) // deltas pendentes descartados, IDR e config mantidos
        assertTrue(q.waitingKey)
        assertTrue(q.offer(item(D))) // continua descartando até o próximo IDR
        assertEquals(listOf(I, C, K), q.types())
        assertFalse(q.offer(item(K)))
        assertFalse(q.waitingKey)
        assertEquals(listOf(I, C, K), q.types()) // IDR novo substitui o antigo
        assertFalse(q.offer(item(D)))
        assertEquals(listOf(I, C, K, D), q.types())
    }

    @Test fun byteLimit() {
        val q = FrameQueue(maxFrames = 100, maxBytes = 100)
        q.offer(item(K, 60))
        assertTrue(q.offer(item(D, 50)))
        assertEquals(listOf(K), q.types())
    }

    @Test fun neverDropsConfigInfoOrKeyEvenIfHuge() {
        val q = FrameQueue(maxFrames = 1, maxBytes = 10)
        assertFalse(q.offer(item(C, 1000)))
        assertFalse(q.offer(item(I, 1000)))
        assertFalse(q.offer(item(K, 1000)))
        assertFalse(q.offer(item(UsbWire.ERROR, 1000)))
        assertEquals(listOf(C, I, K, UsbWire.ERROR), q.types())
    }

    @Test fun newKeyMakesQueuedVideoObsolete() {
        val q = FrameQueue()
        q.offer(item(K)); q.offer(item(D)); q.offer(item(I)); q.offer(item(C))
        q.offer(item(K))
        assertEquals(listOf(I, C, K), q.types())
    }

    @Test fun takeTimesOutAndCloseWakes() {
        val q = FrameQueue()
        assertNull(q.take(20))
        var got: FrameQueue.Item? = item(K)
        val t = thread { got = q.take(5_000) }
        Thread.sleep(50)
        q.close()
        t.join(1_000)
        assertFalse(t.isAlive)
        assertNull(got)
        assertFalse(q.offer(item(K)))
    }

    @Test fun producerConsumer() {
        val q = FrameQueue(maxFrames = 1000)
        val n = 500
        val got = ArrayList<Int>()
        val c = thread { repeat(n) { got.add(q.take(5_000)!!.bytes.size) } }
        for (i in 1..n) q.offer(FrameQueue.Item(if (i == 1) K else D, ByteArray(i)))
        c.join(5_000)
        assertEquals((1..n).toList(), got)
    }
}

class ScreenEncoderSizeTest {
    private val any: (Int, Int) -> Boolean = { _, _ -> true }

    @Test fun portrait720() {
        assertEquals(720 to 1600, ScreenEncoder.fitSize(1080, 2400, 720, any))
    }

    @Test fun landscape1080NotUpscaled() {
        assertEquals(2400 to 1080, ScreenEncoder.fitSize(2400, 1080, 1080, any))
        assertEquals(1280 to 720, ScreenEncoder.fitSize(1280, 720, 1080, any)) // tela menor que o pedido
    }

    @Test fun shrinksUntilEncoderAccepts() {
        val max1920: (Int, Int) -> Boolean = { w, h -> w <= 1920 && h <= 1920 }
        val (w, h) = ScreenEncoder.fitSize(2400, 1080, 1080, max1920)
        assertTrue("$w x $h", w <= 1920 && w % 8 == 0 && h % 8 == 0)
        assertEquals(2400f / 1080f, w.toFloat() / h, 0.02f)
    }

    @Test fun multipleOf8() {
        val (w, h) = ScreenEncoder.fitSize(1080, 2340, 720, any)
        assertEquals(0, w % 8); assertEquals(0, h % 8)
    }

    @Test fun bitrate() {
        assertEquals(8_000_000, ScreenEncoder.bitrateFor(720, 60))
        assertEquals(8_000_000, ScreenEncoder.bitrateFor(1080, 30))
    }
}
