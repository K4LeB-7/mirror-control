package com.mirror.gamecontrol

import java.util.ArrayDeque
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Fila de saída do modo USB com contrapressão (produtor: encoder; consumidor: thread que escreve no socket).
 *
 * Regras (docs/USB_PROTOCOLO.md):
 * - INFO, ERROR, CTRL e VIDEO_CONFIG nunca são descartados;
 * - um VIDEO_KEY novo torna obsoletos os VIDEO_KEY/VIDEO_DELTA ainda na fila (descarta-os) e encerra a espera por IDR;
 * - VIDEO_DELTA com a fila cheia ([maxFrames] quadros ou [maxBytes]): descarta TODOS os deltas pendentes e este,
 *   e os seguintes até o próximo VIDEO_KEY (um delta sem a referência quebraria a decodificação). Nesse caso
 *   [offer] devolve true: quem chamou deve pedir um IDR ao encoder.
 */
class FrameQueue(private val maxFrames: Int = 8, private val maxBytes: Int = 4 * 1024 * 1024) {
    class Item(val type: Int, val bytes: ByteArray)

    private val lock = ReentrantLock()
    private val notEmpty = lock.newCondition()
    private val items = ArrayDeque<Item>()
    private var bytes = 0
    private var closed = false

    /** true enquanto deltas estão sendo descartados à espera de um VIDEO_KEY. */
    var waitingKey = false
        private set
    var dropped = 0L
        private set

    /** @return true se é preciso pedir um quadro-chave ao encoder. */
    fun offer(item: Item): Boolean = lock.withLock {
        if (closed) return false
        when (item.type) {
            UsbWire.VIDEO_KEY -> {
                removeIf { it.type == UsbWire.VIDEO_KEY || it.type == UsbWire.VIDEO_DELTA }
                waitingKey = false
                add(item)
                false
            }
            UsbWire.VIDEO_DELTA -> {
                if (waitingKey) {
                    dropped++
                    return true
                }
                val videoCount = items.count { it.type == UsbWire.VIDEO_KEY || it.type == UsbWire.VIDEO_DELTA }
                if (videoCount >= maxFrames || bytes + item.bytes.size > maxBytes) {
                    removeIf { it.type == UsbWire.VIDEO_DELTA }
                    dropped++
                    waitingKey = true
                    return true
                }
                add(item)
                false
            }
            else -> {
                add(item)
                false
            }
        }
    }

    /** Próximo item, ou null se o tempo acabou / a fila foi fechada. */
    fun take(timeoutMs: Long): Item? = lock.withLock {
        var nanos = TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (items.isEmpty() && !closed) {
            if (nanos <= 0) return null
            nanos = notEmpty.awaitNanos(nanos)
        }
        if (closed) return null
        val it = items.poll() ?: return null
        bytes -= it.bytes.size
        it
    }

    fun close() = lock.withLock {
        closed = true
        items.clear()
        bytes = 0
        notEmpty.signalAll()
    }

    val size: Int get() = lock.withLock { items.size }

    fun types(): List<Int> = lock.withLock { items.map { it.type } }

    private fun add(item: Item) {
        items.add(item)
        bytes += item.bytes.size
        notEmpty.signal()
    }

    private fun removeIf(pred: (Item) -> Boolean) {
        val it = items.iterator()
        while (it.hasNext()) {
            val x = it.next()
            if (pred(x)) {
                it.remove()
                bytes -= x.bytes.size
                dropped++
            }
        }
    }
}
