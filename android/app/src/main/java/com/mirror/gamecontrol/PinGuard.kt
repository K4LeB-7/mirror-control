package com.mirror.gamecontrol

import java.security.SecureRandom
import java.util.Locale

/**
 * PIN do modo USB: 6 dígitos aleatórios, comparação em tempo constante e bloqueio após [maxFailures] erros
 * seguidos. Cada bloqueio dura o dobro do anterior (de [baseLockoutMs] até [maxLockoutMs]); um acerto zera tudo.
 * Thread-safe. Sem dependências Android (testável na JVM).
 */
class PinGuard(
    val pin: String = generate(),
    private val maxFailures: Int = 5,
    private val baseLockoutMs: Long = 60_000,
    private val maxLockoutMs: Long = 3_600_000,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    sealed class Result {
        object Ok : Result()
        data class Wrong(val remaining: Int) : Result()
        data class Locked(val remainingMs: Long) : Result()
    }

    private val expected = pin.toByteArray(Charsets.US_ASCII)
    private var failures = 0
    private var lockouts = 0
    private var lockedUntil = 0L

    @Synchronized
    fun check(attempt: ByteArray): Result {
        val now = clock()
        if (now < lockedUntil) return Result.Locked(lockedUntil - now)
        if (constantTimeEquals(attempt, expected)) {
            failures = 0
            lockouts = 0
            return Result.Ok
        }
        failures++
        if (failures >= maxFailures) {
            failures = 0
            val ms = (baseLockoutMs shl minOf(lockouts, 16)).coerceAtMost(maxLockoutMs)
            lockouts++
            lockedUntil = now + ms
            return Result.Locked(ms)
        }
        return Result.Wrong(maxFailures - failures)
    }

    companion object {
        private val random = SecureRandom()

        fun generate(rnd: java.util.Random = random): String =
            String.format(Locale.ROOT, "%06d", rnd.nextInt(1_000_000))

        /** Tempo independente de ONDE os bytes diferem (o tamanho do PIN não é segredo). */
        fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean {
            var diff = a.size xor b.size
            val n = maxOf(a.size, b.size)
            for (i in 0 until n) {
                val x = if (i < a.size) a[i].toInt() else 0
                val y = if (i < b.size) b[i].toInt() else 0
                diff = diff or (x xor y)
            }
            return diff == 0
        }
    }
}
