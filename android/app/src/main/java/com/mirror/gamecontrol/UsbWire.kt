package com.mirror.gamecontrol

import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

/**
 * Protocolo do modo USB (ADB) — implementação de referência Kotlin. Espec: docs/USB_PROTOCOLO.md.
 * Mesma definição em web/lib/usbWire.ts; os dois testes usam docs/usb-protocol-vectors.txt.
 *
 * Quadro: [type u8][len u32 LE][payload]. Sem dependências Android (testável na JVM).
 */
object UsbWire {
    const val VIDEO_CONFIG = 0x01
    const val VIDEO_KEY = 0x02
    const val VIDEO_DELTA = 0x03
    const val INPUT = 0x10
    const val CTRL = 0x11
    const val HELLO = 0x20
    const val INFO = 0x21
    const val ERROR = 0x7F

    const val PORT = 27183
    const val HEADER_SIZE = 5
    const val INPUT_SIZE = 18
    const val MAX_VIDEO_PAYLOAD = 8 * 1024 * 1024
    const val MAX_CONTROL_PAYLOAD = 64 * 1024
    const val MAX_HELLO_PAYLOAD = 64

    class WireException(msg: String) : IOException(msg)

    class Frame(val type: Int, val payload: ByteArray)

    /** Valida `len` (sem sinal) para o tipo; lança [WireException] se estiver fora do limite. */
    fun checkLength(type: Int, len: Long) {
        val ok = when (type) {
            INPUT -> len == INPUT_SIZE.toLong()
            HELLO -> len in 1..MAX_HELLO_PAYLOAD
            VIDEO_CONFIG -> len in 0..MAX_VIDEO_PAYLOAD
            VIDEO_KEY, VIDEO_DELTA -> len in 8..MAX_VIDEO_PAYLOAD
            else -> len in 0..MAX_CONTROL_PAYLOAD // INFO, CTRL, ERROR e tipos desconhecidos (ignorados)
        }
        if (!ok) throw WireException("tamanho inválido $len para o tipo 0x${type.toString(16)}")
    }

    fun header(type: Int, len: Int): ByteArray {
        checkLength(type, len.toLong())
        return byteArrayOf(
            type.toByte(),
            len.toByte(), (len ushr 8).toByte(), (len ushr 16).toByte(), (len ushr 24).toByte(),
        )
    }

    fun encode(type: Int, payload: ByteArray): ByteArray = header(type, payload.size) + payload

    fun encodeText(type: Int, text: String): ByteArray = encode(type, text.toByteArray(Charsets.UTF_8))

    /** Quadro de vídeo: payload = u64 pts (µs, LE) + Annex B. [data] pode ser um trecho de um buffer maior. */
    fun encodeVideo(type: Int, ptsUs: Long, data: ByteArray, offset: Int = 0, length: Int = data.size): ByteArray {
        val len = 8 + length
        val out = ByteArray(HEADER_SIZE + len)
        header(type, len).copyInto(out, 0)
        val pts = if (ptsUs < 0) 0L else ptsUs
        for (i in 0 until 8) out[HEADER_SIZE + i] = (pts ushr (8 * i)).toByte()
        System.arraycopy(data, offset, out, HEADER_SIZE + 8, length)
        return out
    }

    /**
     * Mesmo quadro de [encodeVideo], lido direto do buffer de saída do MediaCodec (posição..limite): uma cópia só
     * (sem o ByteArray intermediário por quadro). Não altera a posição de [data].
     */
    fun encodeVideo(type: Int, ptsUs: Long, data: java.nio.ByteBuffer): ByteArray {
        val length = data.remaining()
        val len = 8 + length
        val out = ByteArray(HEADER_SIZE + len)
        header(type, len).copyInto(out, 0)
        val pts = if (ptsUs < 0) 0L else ptsUs
        for (i in 0 until 8) out[HEADER_SIZE + i] = (pts ushr (8 * i)).toByte()
        data.duplicate().get(out, HEADER_SIZE + 8, length)
        return out
    }

    fun videoPts(payload: ByteArray): Long {
        if (payload.size < 8) throw WireException("quadro de vídeo sem pts")
        var v = 0L
        for (i in 7 downTo 0) v = (v shl 8) or (payload[i].toLong() and 0xFF)
        return v
    }

    fun videoData(payload: ByteArray): ByteArray = payload.copyOfRange(8, payload.size)

    /**
     * Lê um quadro inteiro (o TCP entrega pedaços de qualquer tamanho; aqui juntamos até completar).
     * Retorna null em EOF limpo entre quadros; lança EOFException se a conexão cair no meio de um quadro.
     */
    fun read(input: InputStream): Frame? {
        val h = ByteArray(HEADER_SIZE)
        val first = input.read()
        if (first < 0) return null
        h[0] = first.toByte()
        readFully(input, h, 1, HEADER_SIZE - 1)
        val type = h[0].toInt() and 0xFF
        val len = (h[1].toLong() and 0xFF) or ((h[2].toLong() and 0xFF) shl 8) or
            ((h[3].toLong() and 0xFF) shl 16) or ((h[4].toLong() and 0xFF) shl 24)
        checkLength(type, len) // rejeita antes de alocar
        val payload = ByteArray(len.toInt())
        readFully(input, payload, 0, payload.size)
        return Frame(type, payload)
    }

    private fun readFully(input: InputStream, b: ByteArray, off: Int, len: Int) {
        var done = 0
        while (done < len) {
            val n = input.read(b, off + done, len - done)
            if (n < 0) throw EOFException("conexão fechada no meio do quadro")
            done += n
        }
    }

    fun write(out: OutputStream, type: Int, payload: ByteArray) {
        out.write(header(type, payload.size))
        out.write(payload)
    }

    /** "avc1.PPCCLL" a partir da SPS (nal_unit_type 7) em Annex B; null se não houver SPS. */
    fun codecFromAnnexB(b: ByteArray): String? {
        for ((start, end) in nalUnits(b)) {
            if ((b[start].toInt() and 0x1F) == 7 && end - start >= 4) {
                return String.format(
                    java.util.Locale.ROOT, "avc1.%02X%02X%02X",
                    b[start + 1].toInt() and 0xFF, b[start + 2].toInt() and 0xFF, b[start + 3].toInt() and 0xFF,
                )
            }
        }
        return null
    }

    /** Intervalos [início, fim) das NALs de um buffer Annex B (start code de 3 ou 4 bytes). */
    fun nalUnits(b: ByteArray): List<Pair<Int, Int>> {
        val out = ArrayList<Pair<Int, Int>>()
        var i = 0
        var start = -1
        while (i + 2 < b.size) {
            if (b[i].toInt() == 0 && b[i + 1].toInt() == 0 && b[i + 2].toInt() == 1) {
                if (start >= 0) {
                    var e = i
                    if (e > start && b[e - 1].toInt() == 0) e--
                    out.add(start to e)
                }
                i += 3
                start = i
            } else i++
        }
        if (start in 0 until b.size) out.add(start to b.size)
        return out
    }

    /** Só as NALs SPS (7) e PPS (8) de um buffer Annex B, com start codes; null se não houver SPS. */
    fun parameterSets(b: ByteArray): ByteArray? {
        val ps = nalUnits(b).filter { (s, _) -> (b[s].toInt() and 0x1F) in 7..8 }
        if (ps.none { (s, _) -> (b[s].toInt() and 0x1F) == 7 }) return null
        val out = java.io.ByteArrayOutputStream()
        for ((s, e) in ps) {
            out.write(byteArrayOf(0, 0, 0, 1))
            out.write(b, s, e - s)
        }
        return out.toByteArray()
    }

    /** JSON do INFO, montado à mão (org.json não existe nos testes JVM). */
    fun infoJson(width: Int, height: Int, fps: Int, codec: String): String =
        "{\"width\":$width,\"height\":$height,\"fps\":$fps,\"codec\":\"${codec.filter { it.isLetterOrDigit() || it == '.' }}\",\"version\":1}"
}
