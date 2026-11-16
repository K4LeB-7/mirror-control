package com.mirror.gamecontrol

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UsbNetTest {
    @Test fun tetherNames() {
        for (n in listOf("rndis0", "ncm0", "usb0", "eth0")) assertTrue(n, UsbNet.isTetherName(n))
    }

    @Test fun nonTetherNames() {
        for (n in listOf("wlan0", "lo", "rmnet_data0", "", "rndis", "tun0")) assertFalse(n, UsbNet.isTetherName(n))
    }

    @Test fun describeEmpty() {
        assertTrue(UsbNet.describe(emptyList()).contains("desligado"))
    }

    @Test fun describeWithIp() {
        assertTrue(UsbNet.describe(listOf("rndis0" to "192.168.42.129")).contains("192.168.42.129"))
    }

    @Test fun describeWaitingIp() {
        assertTrue(UsbNet.describe(listOf("rndis0" to null)).contains("aguardando IP"))
    }
}
