# Mirror Control — espelhamento WebRTC + controles de teclado/mouse para Android

Notebook (site Next.js na Vercel) ⇄ celular Android (Kotlin). O celular transmite a tela;
o notebook devolve teclado/mouse como toques injetados via `AccessibilityService`.

```
web/       Next.js 14 (App Router) + TypeScript + Tailwind  → deploy na Vercel
android/   App Kotlin (MediaProjection + org.webrtc + AccessibilityService)
docs/      Prompts/especificações originais (orquestrador, frontend, android)
```

## Baixar o app Android
[**mirror-control.apk (última versão)**](https://github.com/maria190505d-jpg/mirror-control/releases/latest/download/mirror-control.apk) — passo a passo em [docs/INSTALAR_APK.md](docs/INSTALAR_APK.md).
Site: https://mirror-control.vercel.app

## Como funciona
1. O site gera um **ID de sala** (guardado no navegador) e mostra um **QR Code**.
2. O app Android lê o QR/ID, abre a captura de tela e faz a **OFFER** WebRTC.
   Sinalização: relay WebSocket do **PeerServer** (`0.peerjs.com` por padrão; configurável).
3. Dois DataChannels, criados pelo celular:
   - `input` — `ordered:false, maxRetransmits:0`, pacote binário de 18 bytes
     `[action u8, keyId u8, x f32, y f32, dx f32, dy f32]` (ver `web/lib/protocol.ts` ↔ `InputProtocol.kt`).
   - `ctrl` — confiável, JSON (resolução 720p/1080p, 30/60 fps).
4. Mapeamento por **percentual** (0.0–1.0) da tela → funciona em qualquer proporção.
   WASD vira um joystick virtual (um dedo que arrasta), mouse + Pointer Lock vira o dedo da câmera,
   teclas/botões do mouse viram toques fixos. Há editor visual ("Mapear teclas").

## Web (testado: `tsc` e `next build` passam)
```bash
cd web && npm install && npm run dev      # http://localhost:3000
```
Deploy: importe a pasta `web/` na Vercel (Root Directory = `web`). Pointer Lock exige HTTPS (a Vercel já dá).
Variáveis opcionais: `NEXT_PUBLIC_PEER_HOST/PORT/PATH/KEY/SECURE`, `NEXT_PUBLIC_TURN_URL/USER/PASS`.
Use Chrome/Edge (movimento de mouse sem aceleração).

## Android (compila com `gradle assembleDebug`, testado só até o build — não em aparelho)
Abra `android/` no Android Studio e rode no aparelho (minSdk 26), ou instale o APK acima.
1. "Ativar serviço de acessibilidade" → ligar **Mirror Control** (sem isso só há vídeo).
2. Colar/escanear o ID da sala → "Iniciar espelhamento" → aceitar a captura de tela.
Uma notificação fixa com botão **Parar** fica visível enquanto a tela é compartilhada.

## Limitações conhecidas
- A sinalização padrão é o servidor público do PeerJS; para uso sério, hospede o seu `peerjs-server`.
- Sem TURN, redes com NAT simétrico/4G podem não conectar (configure TURN no web e em `RtcClient.kt`).
- Injeção por `dispatchGesture` tem latência de dezenas de ms; jogos com anti-cheat podem bloquear toques injetados.
  O ID da sala é o único segredo de pareamento.
