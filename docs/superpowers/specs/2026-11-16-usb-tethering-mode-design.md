# Modo cabo USB (tethering) — design curto

**Intenção:** o usuário não consegue conectar PC e celular pela rede (Wi-Fi/firewall/isolamento) e não quer instalar nada no PC.
**Meta:** conectar por cabo USB sem instalar software no PC; tornar óbvio se o cabo foi reconhecido.
**Não-metas:** novo protocolo de vídeo/entrada; ADB; WebUSB. **Anti-meta:** exigir instalação no PC.

## Abordagens consideradas
- A) Tethering USB (RNDIS nativo no Windows): rede privada ponto a ponto pelo cabo; o WebRTC atual já usa. **Escolhida** (única sem instalação).
- B) Túnel `adb forward` + H.264 sobre WebSocket (estilo scrcpy): independe de rede, mas exige `adb` e depuração USB no PC. Descartada pela restrição.
- C) ADB via WebUSB no navegador: exige driver WinUSB no Windows na prática. Descartada.

## Design
1. App Android: na tela principal, linha "Rede USB" que lista interfaces de rede ativas do tipo tethering (rndis*/usb*/ncm*/eth*) com seu IPv4, ou "tethering USB desligado".
2. Site: cartão "Modo cabo USB" (passos curtos) na tela inicial.
3. Guia `docs/INSTALAR_APK.md`: passo a passo Xiaomi/HyperOS + Windows (rede Privada).
4. Versão 0.1.6; publicar APK em `apk/`, site na Vercel.

## Decisões minhas (sinalizadas)
- Detecção por nome da interface via `NetworkInterface` (heurística; pode variar por fabricante).
- Sem mudanças no protocolo de sinalização/ICE.
