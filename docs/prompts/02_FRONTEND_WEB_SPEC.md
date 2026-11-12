# ESPECIFICAÇÃO DO FRONTEND WEB (NEXT.JS + VERCEL)

## Tecnologias:
- Next.js 14+ (App Router), TypeScript, TailwindCSS, PeerJS (WebRTC), React Use-Gesture / Pointer Lock API.

## Funcionalidades Chave:
1. **Conexão PeerJS:** Geração de ID de sala e suporte a QR Code para pareamento rápido com o app Android.
2. **Canvas / Renderer de Vídeo:** Exibição do `RTCVideoTrack` do celular com ajuste dinâmico de aspect ratio.
3. **Captura de Periféricos:**
   - `requestPointerLock()` para conversão de deltas do mouse (`movementX`, `movementY`) em rotação de câmera 360°.
   - Mapeador visual em overlay para posicionar botões de ação (WASD, Atirar, Pular, Agachar).
4. **Envio de Eventos (DataChannel):**
   - Transmissão compacta de pacotes de dados de entrada: `[actionType, keyId, x, y, deltaX, deltaY]`.
