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
class FrameQueue(maxFrames: Int = 8, maxBytes: Int = 4 * 1024 * 1024) {
    /** [tNs] = System.nanoTime() da oferta (0 = não medido): a thread de escrita calcula a espera na fila (vstat `q`). */
    class Item(val type: Int, val bytes: ByteArray, val tNs: Long = 0L)

    /**
     * Política de latência (app 0.3.4): os limites podem mudar com o perfil de vídeo ([VideoTuning]). Em baixa latência
     * a fila é curta (4 quadros): preferimos descartar os deltas e pedir um IDR a acumular atraso.
     */
    @Volatile var maxFrames: Int = maxFrames
    @Volatile var maxBytes: Int = maxBytes

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
    /** Vezes em que a fila CHEIA descartou deltas (o USB não acompanhou o encoder); não conta os superados por um IDR novo. */
    var overflows = 0L
        private set
    private var peak = 0

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
                    overflows++
                    waitingKey = true
                    return true
                }
                add(item)
                if (videoCount + 1 > peak) peak = videoCount + 1
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

    /** Maior número de quadros de vídeo esperando desde a última chamada (zera). */
    fun takePeak(): Int = lock.withLock {
        val p = maxOf(peak, items.count { it.type == UsbWire.VIDEO_KEY || it.type == UsbWire.VIDEO_DELTA })
        peak = 0
        p
    }

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
