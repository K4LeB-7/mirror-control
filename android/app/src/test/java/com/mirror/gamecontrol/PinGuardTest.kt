package com.mirror.gamecontrol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random

class PinGuardTest {
    private var now = 1_000_000L
    private fun guard() = PinGuard("123456", maxFailures = 5, baseLockoutMs = 60_000, clock = { now })
    private val ok = "123456".toByteArray()
    private val bad = "000000".toByteArray()

    @Test fun generatesSixDigits() {
        val r = Random(1)
        repeat(1000) { assertTrue(Regex("\\d{6}").matches(PinGuard.generate(r))) }
        assertEquals("000042", PinGuard.generate(object : Random() { override fun nextInt(bound: Int) = 42 }))
    }

    @Test fun constantTimeEquals() {
        assertTrue(PinGuard.constantTimeEquals(ok, "123456".toByteArray()))
        assertFalse(PinGuard.constantTimeEquals(ok, "123457".toByteArray()))
        assertFalse(PinGuard.constantTimeEquals(ok, "12345".toByteArray()))
        assertFalse(PinGuard.constantTimeEquals(ok, "1234560".toByteArray()))
        assertFalse(PinGuard.constantTimeEquals(ok, ByteArray(0)))
    }

    @Test fun correctPin() {
        assertEquals(PinGuard.Result.Ok, guard().check(ok))
    }

    @Test fun wrongCountsDown() {
        val g = guard()
        assertEquals(PinGuard.Result.Wrong(4), g.check(bad))
        assertEquals(PinGuard.Result.Wrong(3), g.check(bad))
    }

    @Test fun locksAfterFiveAndRejectsEvenCorrect() {
        val g = guard()
        repeat(4) { g.check(bad) }
        assertEquals(PinGuard.Result.Locked(60_000), g.check(bad))
        now += 30_000
        assertEquals(PinGuard.Result.Locked(30_000), g.check(ok)) // nem o PIN certo passa durante o bloqueio
        now += 30_000
        assertEquals(PinGuard.Result.Ok, g.check(ok))
    }

    @Test fun lockoutDoubles() {
        val g = guard()
        repeat(5) { g.check(bad) }
        now += 60_000
        repeat(4) { assertTrue(g.check(bad) is PinGuard.Result.Wrong) }
        assertEquals(PinGuard.Result.Locked(120_000), g.check(bad))
        now += 120_000
        repeat(4) { g.check(bad) }
        assertEquals(PinGuard.Result.Locked(240_000), g.check(bad))
    }

    @Test fun lockoutCapped() {
        val g = PinGuard("123456", maxFailures = 1, baseLockoutMs = 60_000, maxLockoutMs = 3_600_000, clock = { now })
        var last: PinGuard.Result = PinGuard.Result.Ok
        repeat(30) {
            last = g.check(bad)
            now += 4_000_000
        }
        assertEquals(PinGuard.Result.Locked(3_600_000), last)
    }

    @Test fun successResetsFailures() {
        val g = guard()
        repeat(4) { g.check(bad) }
        assertEquals(PinGuard.Result.Ok, g.check(ok))
        assertEquals(PinGuard.Result.Wrong(4), g.check(bad))
    }
}
