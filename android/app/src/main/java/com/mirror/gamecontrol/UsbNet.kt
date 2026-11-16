package com.mirror.gamecontrol

import java.net.Inet4Address
import java.net.NetworkInterface

/** Detecta se o tethering USB (rede por cabo) está ativo neste celular. */
object UsbNet {
    // Interfaces de tethering por cabo: rndis0 (Windows), ncm0/usb0 (Linux/Mac), eth0 (alguns aparelhos).
    private val TETHER = Regex("^(rndis|usb|ncm|eth)\\d+$")

    fun isTetherName(name: String): Boolean = TETHER.matches(name)

    /** [entries] = (nome da interface, IPv4 ou null). */
    fun describe(entries: List<Pair<String, String?>>): String {
        if (entries.isEmpty()) return "Cabo USB: tethering desligado (ative \"Tethering USB\" nas configurações)"
        return "Cabo USB: " + entries.joinToString("; ") { (name, ip) ->
            if (ip == null) "$name aguardando IP…" else "$name ✔ $ip"
        }
    }

    fun current(): String {
        val entries = try {
            NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp && !it.isLoopback && isTetherName(it.name) }
                .map { nif ->
                    val ip = nif.inetAddresses.toList()
                        .filterIsInstance<Inet4Address>()
                        .firstOrNull { !it.isLinkLocalAddress }?.hostAddress
                    nif.name to ip
                }
        } catch (_: Exception) {
            emptyList()
        }
        return describe(entries)
    }
}
