# Mirror Control — espelhamento WebRTC + controles de teclado/mouse para Android

Notebook (site Next.js na Vercel) ⇄ celular Android (Kotlin). O celular transmite a tela;
o notebook devolve teclado/mouse como toques injetados via `AccessibilityService`.

```
web/       Next.js 14 (App Router) + TypeScript + Tailwind  → deploy na Vercel
android/   App Kotlin (MediaProjection + org.webrtc + AccessibilityService)
docs/      Prompts/especificações originais (orquestrador, frontend, android)
```

## Baixar o app Android
[**mirror-control.apk (última versão)**](https://github.com/K4LeB-7/mirror-control/raw/main/apk/mirror-control.apk) — passo a passo em [docs/INSTALAR_APK.md](docs/INSTALAR_APK.md).
Site: https://mirror-control.vercel.app

## Como funciona
1. O site gera um **ID de sala** (guardado no navegador) e mostra um **QR Code**.
2. O app Android lê o QR/ID, abre a captura de tela e faz a **OFFER** WebRTC.
   Sinalização: relay WebSocket do **PeerServer** (`0.peerjs.com` por padrão; configurável).
3. Dois DataChannels, criados pelo celular:
   - `input` — `ordered:false, maxRetransmits:0`, pacote binário de 18 bytes
     `[action u8, keyId u8, x f32, y f32, dx f32, dy f32]` (ver `web/lib/protocol.ts` ↔ `InputProtocol.kt`).
   - `ctrl` — confiável, JSON (resolução 720p/1080p, 30/60 fps).
   **Modo USB (ADB, app 0.2.0+)**: sem rede nem servidor — o navegador fala ADB pelo cabo via WebUSB (Chrome/Edge),
   abre `tcp:27183` no celular e recebe H.264 (WebCodecs → `<canvas>`); entrada no mesmo pacote de 18 bytes.
   Protocolo em [docs/USB_PROTOCOLO.md](docs/USB_PROTOCOLO.md), passo a passo em [docs/INSTALAR_APK.md](docs/INSTALAR_APK.md).
4. Mapeamento por **percentual** (0.0–1.0) da tela → funciona em qualquer proporção.
   WASD vira um joystick virtual (um dedo que arrasta), teclas/botões do mouse viram toques fixos (até 20 botões por
   layout; no máximo 7 apertados ao mesmo tempo, limite de dedos do Android — site 0.3.3).
   **Mouse livre** (padrão): clique/arraste = toque, roda = rolar, botão direito = Voltar. **Mouse travado** (F8;
   Esc solta): Pointer Lock vira o dedo da câmera. Perfis com layout de retrato e de paisagem, editor em painel
   lateral, rotação (Retrato/Paisagem/Auto) e Voltar/Início/Recentes pela barra (app 0.3.0+). Todos os controles
   (inclusive joystick, câmera e botões padrão) podem ser excluídos, com Desfazer, Limpar tudo e Restaurar padrão.
5. **Toques confiáveis (app 0.3.1+)**: as decisões de toque ficam no `TouchPlanner.kt` (puro, testado na JVM): todo
   dedo termina com o "levantar" do Android (clique nunca vira "segurar") e toque mínimo de 50 ms. App 0.3.2: todo
   gesto gera evento (o Android recusava as renovações de dedo parado e mandava CANCEL ao jogo: "anda, para" e
   "A + Espaço anda para a direita"), dedos segurados com fluxo contínuo (~60 gestos/s), ids de ponteiro sem
   colisão e a linha **Diagnóstico de toque** no app. Modelo do injetor do AOSP nos testes JVM (`AospTouchModel.kt`). No WebRTC, DOWN/UP levam uma geração, são repetidos e há keepalive + "deadman" no celular
   (soltar perdido nunca prende o dedo). Detalhes em [docs/USB_PROTOCOLO.md](docs/USB_PROTOCOLO.md#entrada-pacote-de-18-bytes--v2-site-e-app-031).
   Guia de uso em [docs/INSTALAR_APK.md](docs/INSTALAR_APK.md#usando-o-site-app-e-site-030).
6. **Fluidez de multiações e latência tecla→toque (site e app 0.3.3)**: segmentos de toque curtos (a próxima tecla quase
   nunca espera o gesture anterior), perfis **Equilibrado / Máxima fluidez / Economia** escolhidos na barra do site,
   USB sem pacotes redundantes e com escrita agrupada, ping/pong do enlace na barra e latências medidas no celular no
   **Diagnóstico de toque**. Medições (modelo do AOSP e navegador) em
   [docs/INSTALAR_APK.md](docs/INSTALAR_APK.md#fluidez-e-latência-033-perfis-e-como-comparar-no-aparelho).

7. **Latência do vídeo (site e app 0.3.4, modo USB)**: instrumentação ponta a ponta (PTS = captura, offset de relógio por
   ping/pong, `vstat` do encoder, idade do quadro no desenho), botão **Medir latência do vídeo** (quadrado branco/preto no
   canto da tela pelo serviço de acessibilidade, detectado nos quadros decodificados), **Copiar diagnóstico**, e o
   perfil de vídeo **Baixa latência** (padrão) × **Padrão (0.3.3)** para comparar no aparelho. Guia em
   [docs/INSTALAR_APK.md](docs/INSTALAR_APK.md#latência-do-vídeo-034-medir-copiar-o-diagnóstico-e-comparar-baixa-latência--padrão),
   protocolo em [docs/USB_PROTOCOLO.md](docs/USB_PROTOCOLO.md#latência-do-vídeo-034).

## Web (testado: `tsc` e `next build` passam)
```bash
cd web && npm install && npm run dev      # http://localhost:3000
npm test                                  # testes unitários (protocolo USB, perfis/modos do mouse/geometria, teclado/mouse → toques)
```
Deploy: importe a pasta `web/` na Vercel (Root Directory = `web`). Pointer Lock exige HTTPS (a Vercel já dá).
Variáveis opcionais: `NEXT_PUBLIC_PEER_HOST/PORT/PATH/KEY/SECURE`, `NEXT_PUBLIC_TURN_URL/USER/PASS`.
Use Chrome/Edge (movimento de mouse sem aceleração).

## Android (compila com `gradle assembleDebug`, testado só até o build e testes JVM — não em aparelho)
`gradle testDebugUnitTest` roda os testes JVM (protocolo USB, PIN, fila de vídeo, comandos, planejador de toques).
Abra `android/` no Android Studio e rode no aparelho (minSdk 26), ou instale o APK acima.
1. "Ativar serviço de acessibilidade" → ligar **Mirror Control** (sem isso só há vídeo).
2. Colar/escanear o ID da sala → "Iniciar espelhamento" → aceitar a captura de tela.
Uma notificação fixa com botão **Parar** fica visível enquanto a tela é compartilhada.

## Limitações conhecidas
- A sinalização padrão é o servidor público do PeerJS; para uso sério, hospede o seu `peerjs-server`.
- Sem TURN, redes com NAT simétrico/4G podem não conectar (configure TURN no web e em `RtcClient.kt`).
- Injeção por `dispatchGesture` tem latência de dezenas de ms; jogos com anti-cheat podem bloquear toques injetados.
  O ID da sala é o único segredo de pareamento.

Versão do app no código: 0.3.4 (versionCode 13). O APK publicado em `apk/` (ver `apk/version.json`) é trocado na publicação.
