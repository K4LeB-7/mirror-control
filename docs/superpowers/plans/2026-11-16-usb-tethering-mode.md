# Modo cabo USB (tethering) Implementation Plan

**Goal:** mostrar no app se o tethering USB está ativo (e o IP) e guiar o usuário no site e no guia.
**Architecture:** utilitário puro `UsbNet` (testável na JVM) + linha de status na MainActivity + cartão no ConnectPanel + docs.
**Tech Stack:** Kotlin/Android (JUnit 4), Next.js/TS. **Spec:** docs/superpowers/specs/2026-11-16-usb-tethering-mode-design.md

## Global Constraints
- Sem instalação no PC. Sem mudanças no protocolo de sinalização, vídeo ou entrada. APK 0.1.6 / versionCode 7, mesma assinatura.

## Review Focus
- Nome de interface inesperado (`wlan0`, `lo`, `rmnet_data0`, `rndis0`, `ncm0`, `usb0`, `eth0`): só os de tethering contam; rede móvel/Wi-Fi nunca.
- Interface sem IPv4 ainda (cabo acabou de ligar): mostra "aguardando IP", sem travar.
- Nenhuma interface: "tethering USB desligado".

### Task 1: UsbNet (Android)
**Files:** Create `android/app/src/main/java/com/mirror/gamecontrol/UsbNet.kt`; Test `android/app/src/test/java/com/mirror/gamecontrol/UsbNetTest.kt`; Modify `android/app/build.gradle.kts` (testImplementation junit:4.13.2).
**Interfaces:** Produces `UsbNet.isTetherName(name: String): Boolean`, `UsbNet.describe(entries: List<Pair<String, String?>>): String`, `UsbNet.current(): String`.
- [ ] Test: `isTetherName` true p/ rndis0, ncm0, usb0, eth0; false p/ wlan0, lo, rmnet_data0, "". `describe` p/ vazio → "tethering USB desligado"; [("rndis0","192.168.42.129")] → contém "192.168.42.129"; [("rndis0",null)] → contém "aguardando IP".
- [ ] Implementar com `NetworkInterface` (up, não loopback, IPv4 não-link-local). Rodar `gradle testDebugUnitTest`.
### Task 2: Status na MainActivity
**Files:** Modify `activity_main.xml` (TextView `usbState`), `MainActivity.kt` (atualiza a cada 2 s em onResume, para em onPause).
- [ ] Compilar `gradle assembleDebug`.
### Task 3: Site + guia
**Files:** Modify `web/components/ConnectPanel.tsx` (cartão "Modo cabo USB"), `docs/INSTALAR_APK.md`.
- [ ] `cd web && npx tsc --noEmit && npx next build`.
### Task 4: Publicar
- [ ] Versão 0.1.6, copiar APK p/ `apk/`, commit, push, deploy Vercel (rootDirectory `web`), enviar APK no chat.
