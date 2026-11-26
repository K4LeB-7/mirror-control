# Protocolo do modo USB (ADB) — v1

Transporte: o navegador (Chrome/Edge) fala ADB direto pelo cabo via **WebUSB** (biblioteca Tango/ya-webadb) e abre o
serviço ADB `tcp:27183`; o `adbd` do celular conecta esse socket ao `ServerSocket` do app em **127.0.0.1:27183**.
Nada passa pela rede (Wi-Fi/firewall) nem por servidor de sinalização.

Implementações de referência (as únicas): `android/.../UsbWire.kt` e `web/lib/usbWire.ts`.
Vetores de teste compartilhados: [`usb-protocol-vectors.txt`](usb-protocol-vectors.txt) (lidos pelos dois conjuntos de testes).

## Quadro
Tudo little-endian. O TCP é um fluxo: o leitor acumula bytes até ter um quadro inteiro (leituras parciais são normais).

```
offset 0  u8   type
offset 1  u32  len      (tamanho do payload, sem contar estes 5 bytes)
offset 5  len  payload
```

| type | nome          | sentido            | payload                                                       | limite de `len`  |
|------|---------------|--------------------|---------------------------------------------------------------|------------------|
| 0x20 | HELLO         | navegador → celular| PIN em ASCII (6 dígitos)                                      | 1..64            |
| 0x21 | INFO          | celular → navegador| JSON `{"width","height","fps","codec":"avc1.PPCCLL"}`         | ≤ 64 KiB         |
| 0x01 | VIDEO_CONFIG  | celular → navegador| SPS/PPS em Annex B (`00 00 00 01 67 …`)                       | ≤ 8 MiB          |
| 0x02 | VIDEO_KEY     | celular → navegador| u64 pts (µs) + quadro IDR em Annex B                          | 8..8 MiB         |
| 0x03 | VIDEO_DELTA   | celular → navegador| u64 pts (µs) + quadro P em Annex B                            | 8..8 MiB         |
| 0x10 | INPUT         | navegador → celular| pacote de toque de 18 bytes (mesmo do WebRTC, `InputProtocol`) | exatamente 18    |
| 0x11 | CTRL          | ambos              | JSON                                                          | ≤ 64 KiB         |
| 0x7F | ERROR         | celular → navegador| texto UTF-8 `CÓDIGO: mensagem`                                | ≤ 64 KiB         |
| outro| (reservado)   | —                  | ignorado pelo receptor                                         | ≤ 64 KiB         |

Um `len` fora do limite é erro de protocolo: o receptor fecha a conexão (não tenta ressincronizar).

## Sessão
1. Navegador conecta e envia **HELLO** com o PIN mostrado no app (em até 5 s, senão o celular fecha).
2. PIN errado → celular envia `ERROR "PIN_INVALID: …"` e fecha. Após 5 erros seguidos, bloqueio de 60 s (dobra a
   cada novo bloqueio, até 1 h) com `ERROR "LOCKED: …"`. A comparação do PIN é em tempo constante.
3. PIN certo → esta conexão vira a única ativa (uma anterior é fechada com `ERROR "REPLACED: …"`). O navegador pode
   mandar **CTRL quality** logo em seguida. O celular (re)inicia o encoder e envia, nesta ordem,
   **INFO**, **VIDEO_CONFIG**, **VIDEO_KEY** e depois VIDEO_DELTA. Rotação/mudança de qualidade repetem INFO+CONFIG+KEY.
4. **INPUT** → `TouchInjector`. **CTRL**:
   - `{"type":"quality","height":720|1080,"fps":30|60}` → reinicia o encoder (só se mudou);
   - `{"type":"keyframe"}` → pede um IDR (`PARAMETER_KEY_REQUEST_SYNC_FRAME`); o navegador manda quando o decodificador
     falhou ou descartou quadros;
   - `{"type":"rotate","mode":"portrait"|"landscape"|"auto"}` (app 0.3.0+) → gira a tela (`RotationController`). Se o
     tamanho do vídeo mudar, o encoder reinicia e o celular manda **INFO + VIDEO_CONFIG + VIDEO_KEY** novos na MESMA
     conexão (o navegador reconfigura o decodificador e o `<canvas>` e troca o layout retrato/paisagem). Resposta
     sempre: CTRL `status` (abaixo);
   - `{"type":"nav","action":"back"|"home"|"recents"}` (app 0.3.0+) → `performGlobalAction` do serviço de
     acessibilidade. Resposta só em caso de falha (ex.: acessibilidade desligada).
   - `{"type":"input","deadmanMs":N,"profile":"balanced"|"smooth"|"eco"}` (site/app 0.3.1+, só depois do `caps`
     abaixo): `deadmanMs` > 0 liga o "deadman" da entrada v2 (WebRTC: 500), 0 desliga (USB, site 0.3.3+). `profile`
     (site/app 0.3.3+) = perfil de fluidez (ver "Perfis de fluidez" abaixo); o site sempre manda os dois campos
     juntos e o app 0.3.3 aplica só os presentes. App 0.3.1/0.3.2 lê só `deadmanMs` (ignora `profile`).
   - `{"type":"ping","t":T}` (site 0.3.3+, ~1/s enquanto conectado) → o app 0.3.3+ responde NA HORA
     `{"type":"pong","t":T,"p":µs,"d":ms,"profile":"…"}` (ver "Ping/pong"). App antigo ignora (o site mostra "—").
   - `{"type":"video","mode":"lowlat"|"legacy"}` (site/app 0.3.4+) → perfil de vídeo (ver "Latência do vídeo (0.3.4)");
     o app reconfigura o encoder na mesma conexão (INFO+CONFIG+KEY novos). App/site antigos ignoram em silêncio.
   - `{"type":"flash"}` (site/app 0.3.4+) → teste de latência do vídeo (ver "Latência do vídeo (0.3.4)").

   **CTRL celular → navegador** (app 0.3.0+): `{"type":"status","scope":"rotate"|"nav","ok":true|false,"text":"…"}`,
   texto em português para mostrar na barra do site. Os mesmos JSON `rotate`/`nav`/`status` passam pelo DataChannel
   `ctrl` no modo WebRTC. Um app antigo (≤ 0.2.0) ignora `rotate`/`nav` sem responder.
   **CTRL `vstat` e `flashAck`** (app 0.3.4+): estatística do encoder a ~1 Hz e respostas do teste de latência do vídeo
   (próxima seção). Site ≤ 0.3.3 ignora.
   **CTRL `{"type":"caps","input":2}`** (app 0.3.1+): enviado logo depois do PIN aceito (antes do INFO) e, no WebRTC,
   quando o canal `ctrl` abre. Anuncia a entrada v2 (próxima seção). Site antigo ignora. App 0.3.3+:
   `{"type":"caps","input":2,"profile":1,"ping":1}` (entende perfis de fluidez e ping).
   **CTRL `{"type":"status","scope":"profile","ok":true,"profile":"smooth","frameMs":8,"text":"…"}`** (app 0.3.3+):
   resposta ao `input.profile` com o perfil aplicado e o quadro do display usado (ms); o site mostra na barra.
5. Ao desconectar: celular solta todos os dedos (`releaseAll`) e para o encoder (a VirtualDisplay fica sem surface,
   pronta para a próxima conexão).

Códigos de ERROR: `PIN_INVALID`, `LOCKED` e `REPLACED` (o navegador não reconecta sozinho); `TIMEOUT`, `PROTOCOL`,
`ENCODER` (o navegador tenta de novo).

## Entrada (pacote de 18 bytes) — v2 (site e app 0.3.1+)
O formato do pacote NÃO muda (`[action u8, keyId u8, x f32, y f32, dx f32, dy f32]`, ver `web/lib/protocol.ts` ↔
`InputProtocol.kt`). Extensões compatíveis:

- **Geração do toque**: em DOWN/UP o campo `dx` (sem uso nessas ações) leva um inteiro ≥ 1, crescente por página/
  conexão. O UP leva a geração do DOWN que ele solta. `dx = 0` (site antigo) = sem geração = regra antiga.
- **Regras no celular** (`TouchPlanner`, por ponteiro): DOWN com geração menor que a última vista é ignorado (pacote
  atrasado); DOWN repetido com a mesma geração de um toque vivo só o renova (keepalive) e, depois que o UP/RELEASE_ALL
  dessa geração chegou, é ignorado; DOWN com geração nova solta o toque anterior (UP perdido) antes de começar o novo.
  UP com geração menor é ignorado (não solta um toque mais novo). Uma conexão nova zera as gerações.
- **Com `caps` (app 0.3.1+) o site**: manda `{"type":"input","deadmanMs":500}`; repete cada DOWN/UP 20 e 60 ms depois
  (mesma geração); enquanto um dedo está segurado reenvia DOWN(geração) a cada 100 ms e, se nenhum MOVE saiu nesse
  intervalo, a posição atual (MOVE). No RELEASE_ALL manda também UP(geração) de cada dedo.
- **Deadman** (celular, só para toques com geração): um dedo sem DOWN-keepalive/MOVE por `deadmanMs` é solto sozinho.
  Assim um UP perdido no canal WebRTC sem retransmissão prende o dedo no máximo ~0,5 s (e só se as 3 cópias se
  perderem). Um keepalive que chega depois do deadman (rede engasgou) volta a pressionar.
- **Ponteiros (site 0.3.3+)**: 0 joystick, 8 mouse no modo livre, 9 câmera; os BOTÕES (até 20 por layout) não têm
  ponteiro fixo: no aperto o site pega o menor ponteiro livre de 1..7 (preferindo um solto há ≥ 80 ms) e o devolve
  ao soltar; o UP vai sempre ao ponteiro do DOWN. Com 7 botões pressionados, o 8º é ignorado (nada é enviado). O
  mesmo ponteiro pode ser usado por botões diferentes em sequência; cada toque tem geração nova, então cópias/UP
  atrasados do toque anterior são ignorados pelas regras acima. O app não muda (continua tratando ids 0..9).
- **Sem `caps`** (app ≤ 0.3.0) o site manda como antes (sem cópias nem keepalive; o joystick reenvia a posição a cada
  100 ms). App 0.3.1 com site antigo: geração 0, sem deadman (comportamento antigo, já com a correção abaixo).

**Toques no Android** (`TouchPlanner` + `TouchInjector`; o pacote de 18 bytes e as regras acima NÃO mudaram na 0.3.2):
um dedo só levanta quando um segmento `willContinue=false` é despachado e completado (0.3.1: antes, um UP que chegava
com um gesture em voo removia o dedo sem esse segmento e ele ficava pressionado: "clique vira segurar"). Toque mínimo
de 50 ms (DOWN e UP quase juntos continuam sendo um clique). DOWN/UP/DOWN rápidos no mesmo ponteiro entram em fila
(nada é engolido). MOVE/UP com nada em voo saem na hora; MOVEs durante um gesture em voo são agrupados (vale o último).

App 0.3.2 (regras do `MotionEventInjector` do AOSP 14/15, modeladas em `AospTouchModel.kt` nos testes JVM):
- **Todo gesture gera pelo menos um MotionEvent.** Um gesture só de continuações paradas (caminho de comprimento zero)
  não gera evento e o Android o recusa (`onCancelled`); a 0.3.1 renovava o dedo parado assim a cada 250 ms, tratava a
  recusa como cancelamento e re-encostava os dedos, e o Android mandava ACTION_CANCEL (com um ponteiro só) + DOWN novo
  ao jogo. Agora um dedo parado faz um micro-movimento de 1 px (vai e volta) quando nada mais no gesture muda.
- **Dedo segurado = fluxo contínuo**: um segmento a cada `holdPeriodMs` = 16 ms (≈60 gestures/s; troca CPU x
  suavidade em `TouchPlanner.Config`; 250 volta ao modo econômico, agora sem recusa).
- **Toque novo encosta no ponto do DOWN e arrasta** até a posição atual (DOWN+MOVE que chegam juntos não viram um
  toque direto no destino). Depois de um cancelamento real (toque na tela), joystick/botões recomeçam do ponto do DOWN;
  a câmera recomeça onde estava. Strokes novos em ordem crescente de ponteiro (o joystick fica com o menor id).
- **Ids de ponteiro do sistema**: o Android só libera um id quando todos os dedos injetados levantam e, gastos 0..9, dá
  10 a todo dedo novo. O planejador prevê os ids e, antes de dois dedos colidirem, levanta e re-encosta todos
  ("reciclagem", ~10 ms).

### Entrada no site e no app 0.3.3 (fluidez de multiações e latência tecla → toque)
O pacote de 18 bytes e as regras de geração NÃO mudam. Medições ANTES × DEPOIS em `docs/INSTALAR_APK.md`
("Fluidez e latência (0.3.3)").

- **USB sem redundância** (site 0.3.3): o canal USB/ADB é TCP (ordenado, sem perda), então com `caps` o site NÃO repete
  DOWN/UP nem manda keepalive, e pede `deadmanMs: 0` (desligado). Um pacote por evento. Proteção contra dedo preso: ao
  cair o socket (cabo solto, aba fechada, PC dormindo) o app faz `releaseAll` (`UsbStreamServer.Session.close/finish`);
  aba escondida/sem foco/menu do navegador → o site manda UP + RELEASE_ALL. No **WebRTC** (canal `input` sem
  retransmissão) tudo continua como na 0.3.1 (cópias em 20/60 ms, keepalive 100 ms, deadman 500 ms).
  Compatibilidade: app 0.3.0 (sem caps) = comportamento antigo; app 0.3.1/0.3.2 = recebe `deadmanMs: 0` no USB
  (deadman desligado, como numa conexão sem keepalive) e ignora `profile`.
- **Escrita agrupada no USB** (site 0.3.3, `usbSession.ts`): um write por vez no canal ADB; com o canal livre o 1º
  quadro sai numa microtarefa (tudo o que o MESMO evento gerou — ex.: DOWN + MOVE do joystick — vai num write só, sem
  timer nem quadro de tela); o que chega durante um write em andamento sai TODO junto no próximo, assim que ele termina.
  Ordem estrita (uma fila só, entre todos os ponteiros: um DOWN nunca ultrapassa um MOVE enviado antes). MOVE/LOOK
  continuam agrupados por quadro (rAF) no controlador e podem ser descartados se a fila passar de 32 quadros; DOWN/UP
  nunca. Motivo: cada write do Tango = um pacote ADB WRTE (2 transferências USB) e, em adbd sem "delayed ack", uma
  espera do OKAY antes do próximo — com a cadeia de 0.3.2 os pacotes faziam fila atrás dessas esperas.
- **Ping/pong** (site e app 0.3.3): o site manda `{"type":"ping","t":performance.now()}` a cada 1 s pelo canal de
  controle (USB: CTRL no mesmo socket; WebRTC: canal `ctrl`); o app responde na thread que leu a mensagem
  `{"type":"pong","t":<o mesmo>,"p":<µs entre receber o ping e mandar o pong>,"d":<mediana DOWN→dispatchGesture medida
  no celular, ms, -1 = sem dados>,"profile":"…","pm":<relógio monotônico do celular em µs, app 0.3.4+>}`. O site mostra na barra: RTT (mediana/p95/máx dos últimos 20),
  "tecla→celular ≈ RTT/2 + p" e "celular→toque" (= d). Observação: no USB o pong volta pela fila de saída do celular,
  atrás de quadros de vídeo já enfileirados, então o RTT/2 tende a SUPERestimar a ida da entrada.
- **Perfis de fluidez** (app 0.3.3, `FluidityProfile.kt`; escolhidos na barra do site, salvos no navegador e enviados a
  cada conexão; trocáveis a qualquer momento, sem soltar dedos). Q = 1 quadro do display (1000/Hz, inteiro: 8 ms em
  120 Hz, 11 em 90, 16 em 60; relido a cada 0,5 s porque o HyperOS alterna a taxa):

  | perfil | renovação do dedo parado | 1º arrasto (joystick) | movimento | 1º segmento de botão | final | toque mínimo |
  |---|---|---|---|---|---|---|
  | Equilibrado (padrão) | máx(16 ms, Q) | Q | 4 ms | 2 ms | 2 ms | 50 ms |
  | Máxima fluidez | Q | Q | 2 ms | 1 ms | 1 ms | 40 ms |
  | Economia | 50 ms | Q | 8 ms | 4 ms | 4 ms | 50 ms |

**Toques no Android, app 0.3.3** (`TouchPlanner` + `TouchInjector`; o que mudou em relação à 0.3.2):
- **Segmentos curtos**: o planejador só pode despachar um gesture novo quando o anterior termina (um em voo por vez).
  Na 0.3.2 todo segmento durava 16 ms, então uma tecla nova esperava até ~18 ms e um MOVE chegava interpolado ao longo
  de 16 ms. Agora o movimento de um dedo já no chão vai direto ao destino num segmento de 2–8 ms, a renovação de um dedo
  parado dura 1–4 ms (o gesture fica em voo pouco tempo; na maior parte do tempo nada está em voo e a próxima tecla sai
  na hora) e o UP final sai 1–4 ms depois do despacho (era 8). O 1º arrasto de um toque novo que se move (joystick)
  dura 1 quadro: o 1º MOVE depois do DOWN chega no mesmo instante que na 0.3.2 (joystick "flutuante" continua lendo o
  DOWN no centro antes do movimento), mas já no destino.
- **Toque mínimo sem gesture em voo**: um clique curto (DOWN+UP antes do mínimo) faz o DOWN num segmento curto e o UP
  perto do fim do mínimo; no meio nada fica em voo por causa dele (na 0.3.2 o toque inteiro era um segmento de 50 ms e
  outra tecla apertada nesse intervalo esperava até 50 ms).
- **Fila de entrada com "drain"**: pacotes que chegam juntos (mesmo read do socket) são todos aplicados antes de
  planejar (A + Espaço no mesmo quadro = um gesture com os dois strokes). Anel sem alocação por pacote.
- **Índice de POINTER_DOWN do AOSP**: o Android usa a posição do stroke no PASSO como índice da ação; um stroke que
  termina no mesmo instante em que outro começa deixaria o índice errado (evento descartado). Com segmentos curtos isso
  passou a ser possível; o planejador estende o que terminaria nesse instante em 1 ms (teste no modelo do AOSP).
- **Reciclagem de ids**: um toque re-encostado cujo UP chegou antes de voltar ao chão e que já durou um quadro de 30 fps
  não é re-pressionado (a 0.3.2 o re-pressionava por mais 50 ms: um "toque duplo" e um UP atrasado); o toque mínimo de
  um toque re-encostado conta do 1º DOWN.
- **Avaliado e NÃO adotado**: (1) "pipelining" (despachar o próximo gesture antes do fim do anterior): o
  `MotionEventInjector` do AOSP aceita uma CONTINUAÇÃO enfileirada atrás da anterior, mas um gesture que não continua
  (todos os dedos levantaram) cancela o anterior com CANCEL, e o app não sabe com precisão quando o sistema termina o
  gesture em voo; no modelo, 2–4 ms de antecedência já geraram 15–19 CANCELs em 20 s e 1 ms ganhou só ~2 ms no p95.
  (2) Reciclagem antecipada de ids (re-encostar quando só a câmera está no chão): nenhuma piscada a menos na carga
  medida. (3) Janela de espera para juntar teclas: o "drain" já junta o que chega junto; esperar custaria em todo DOWN.

## Vídeo
- H.264 (Baseline, ou o perfil padrão do encoder se o Baseline falhar), CBR, I-frame a cada 1 s (perfil "Padrão 0.3.3";
  4 s em "Baixa latência", abaixo), `repeat-previous-frame-after` 150 ms (tela parada continua gerando quadros),
  prioridade de tempo real e `low-latency` quando o aparelho aceitar.
- O navegador usa WebCodecs `VideoDecoder` com o `codec` do INFO, sem `description` (Annex B), `optimizeForLatency`, e
  junta o último VIDEO_CONFIG na frente de cada VIDEO_KEY. Só desenha o quadro mais novo no `<canvas>`.
- **PTS** (µs, u64): o MediaCodec com entrada por Surface usa o timestamp do buffer (BufferQueue do VirtualDisplay, ns,
  base CLOCK_MONOTONIC = `System.nanoTime()`) dividido por 1000 — ou seja, ≈ o instante em que o SurfaceFlinger entregou
  o quadro composto ao encoder (captura). Isso foi **lido** (docs/AOSP), não verificado em aparelho; por isso o app
  confere em tempo de execução (`PtsClock`): compara `agora − pts` na base MONOTONIC e na BOOTTIME e adota a que dá uma
  idade plausível (−50 ms … 5 s); se nenhuma serve, o `vstat` informa `clk:"unk"` e `enc:null` e o site não calcula idade.
  O formato dos quadros de vídeo NÃO mudou.

## Latência do vídeo (0.3.4)
Medir e reduzir a volta do vídeo (captura → codificação → cabo/ADB → decodificação → desenho), que a linha "Enlace"
(só a ENTRADA) não mostra. Tudo compatível com site/app antigos: CTRL desconhecidos são ignorados.

### Relógio: `pm` e offset
O `pong` ganha `pm` = relógio do celular (µs) na MESMA base do PTS dos quadros (`PtsClock.nowUs()`). O site estima
`offset = (t_envio + t_recv)/2 + p/2 − pm/1000` (browser = celular + offset) a cada pong e usa o de **menor RTT** dos
últimos 20 (filtro de mínimo: pings que ficaram atrás de quadros de vídeo na fila de saída do celular, ou num engasgo do
USB, têm RTT e assimetria maiores). Incerteza: o erro é (atraso de ida − atraso de volta)/2; no pior caso (todo o atraso
de um lado só) ≈ (RTT_mín − p)/2, que o site expõe como `incertezaMs` no diagnóstico (com RTT ~10 ms, ±5 ms).

### CTRL `vstat` (celular → navegador, ~1 Hz, app 0.3.4+)
`{"type":"vstat","seq":N,"enc":{"p50":8.2,"p95":12.0,"max":20.1},"q":{…},"wr":{…},"fps":59.8,"kbps":7900,
"keyMaxKB":123.4,"queueDrops":0,"queueOverflows":0,"queuePeak":1,"clk":"mono","mode":"lowlat","tier":3,"rej":"",
"vw":1280,"vh":576,"capFps":60,"targetKbps":6000,"gop":4,"n":60,"ver":"0.3.4"}` (ms com 1 casa; percentis = `s[(n-1)/2]`
e `s[(n-1)*95/100]` sobre as amostras do intervalo):
- `enc`: `agora − pts` no instante em que o quadro codificado sai do MediaCodec = captura + codificação no celular
  (`null` se `clk` = `"unk"`). Para quadros REPETIDOS pelo encoder (`repeat-previous-frame-after`, tela parada) o valor
  não representa a latência de uma mudança — por isso existe o teste de 1 clique abaixo.
- `q`: espera do quadro na fila de saída do app (oferta → thread de escrita pegar); `wr`: duração do write+flush no
  socket loopback (copia para o kernel; não inclui o cabo). `fps`/`kbps`: do intervalo; `keyMaxKB`: maior IDR da conexão.
- `queueDrops` (cumulativo): quadros descartados pela `FrameQueue` (inclui os superados por um IDR novo);
  `queueOverflows`: vezes em que a fila CHEIA descartou deltas (o USB não acompanhou o encoder); `queuePeak`: pico de
  quadros de vídeo esperando no intervalo.
- `clk`: base do PTS (`mono`/`boot`/`unk`); `mode`: perfil de vídeo aplicado; `tier`/`rej`: nível de configuração que o
  encoder aceitou (3 = baixa latência completa) e o motivo se `latency`/`operating-rate` foram recusados.

### Teste de latência com 1 clique: `flash` / `flashAck`
O site manda `{"type":"flash"}`. O app (`FlashController`, na main thread) desenha um quadrado opaco no canto superior
esquerdo (lado = 10 % do menor lado da tela) numa janela `TYPE_ACCESSIBILITY_OVERLAY` do serviço de acessibilidade
(mesmo padrão do `RotationController`: não focável, não tocável) e, em 3 s, alterna preto (300 ms antes) → 5 pulsos
brancos de 300 ms separados por 300 ms de preto. A cada pulso branco responde
`{"type":"flashAck","n":1..5,"pm":µs,"pm0":µs,"vs":µs}` e no fim `{"type":"flashAck","n":0,"end":1,"pulses":5}`;
o overlay é removido ao terminar, ao desconectar e quando o serviço de acessibilidade é desligado. Sem acessibilidade
(ou se o Android recusar a janela) o app responde `{"type":"status","scope":"flash","ok":false,"text":"…"}` + o `end`.
- `pm` = instante de apresentação estimado (base do pong/PTS): depois de `setBackgroundColor`, o pulso é desenhado no
  próximo quadro do Choreographer; `pm0` = `frameTimeNanos` desse quadro (vsync em que ele começou) e `pm = pm0 + 1 vsync`
  (o SurfaceFlinger apresenta ~1 vsync depois; `vs` = período do vsync). Incerteza ≈ ±1 vsync (8 ms a 120 Hz) — NÃO
  verificado em aparelho.
- No site (`UsbSession.startFlashTest`): a cada quadro DESENHADO durante o teste, amostra-se o miolo (20–80 %) do quadrado
  (coordenadas do vídeo; `drawImage` do `VideoFrame` numa canvas 8×8 + `getImageData`, ~1 ms) e a luminância (Rec. 709)
  alimenta um detector de borda de subida com histerese (<64 → >160). `latência(n) = t_desenho_da_borda − (pm_n/1000 +
  offset)`; o resultado mostra mediana/mín/máx dos pulsos. Inclui captura (até 1 vsync) + codificação + cabo/fila +
  decodificação + espera de desenho; NÃO inclui compositor do Chrome e o monitor (≈ 1 quadro do monitor).

### CTRL `video` (perfil) e o que muda em cada perfil
`{"type":"video","mode":"lowlat"|"legacy"}`. O site novo manda a cada (re)conexão (padrão "Baixa latência", escolha salva
no navegador); sem o CTRL (site ≤ 0.3.3) o app fica em `legacy` = comportamento exato da 0.3.3.

| | Padrão (0.3.3) `legacy` | Baixa latência `lowlat` |
|---|---|---|
| Encoder: I-frame | a cada 1 s | a cada 4 s (recuperação = IDR sob demanda, `PARAMETER_KEY_REQUEST_SYNC_FRAME`) |
| Encoder: chaves extras | — | `latency=1`, `operating-rate=fps` (se recusadas: cai para o nível 2, `vstat.rej`) |
| Bitrate (CBR) | 8 Mbps em 720p60 / 16 Mbps em 1080p60 (proporcional ao fps) | 75 % disso (6 / 12 Mbps) |
| Fila de saída do app | 8 quadros / 4 MiB | 4 quadros / 2 MiB (descarta deltas + pede IDR em vez de acumular) |
| Navegador: desenho | `requestAnimationFrame` (um por quadro do monitor) | direto no microtask do callback `output` do decoder (só o último se vários no mesmo tick; `desynchronized`) |
| Navegador: contrapressão | `decodeQueueSize > 6` | `> 2` E o quadro mais velho esperando ≥ 24 ms (ou `> 6`); sem progresso desde o último descarte só reinicia com fila > 12 |

Resolução/fps continuam os escolhidos no site (720p60 já é o padrão). No site, o perfil também vale com app antigo (o
lado do navegador independe do app).

### Diagnóstico do decodificador (`?dec=`)
`?dec=lat0|lat1`, `hw|nopref|sw` (vírgula): `optimizeForLatency` (padrão `lat1`) e `hardwareAcceleration`
(`prefer-hardware` | `no-preference` (padrão) | `prefer-software`). Só para comparar com "Medir latência do vídeo"; o padrão
não muda sem medição no aparelho.

### O que o ADB/Tango faz (@yume-chan/adb 2.6.4)
O transporte direto (`AdbDaemonTransport`) anuncia `delayed_ack` com janela inicial de 32 MiB (só vale se o adbd do
celular também o anunciar; Android 14+ costuma anunciar — o diagnóstico copiável mostra `adb.delayedAck`) e payload
máximo de 1 MiB (negociado com o `CNXN` do adbd: `adb.maxPayloadSize`). Sem delayed ack cada WRTE espera o OKAY. Nada a
configurar: já é o padrão da biblioteca. O laço de leitura do site (`reader.read()` → `FrameDecoder`) usa vistas sem cópia
(`zeroCopy`) quando o pedaço começa num limite de quadro.

O celular monta cada VIDEO_KEY/VIDEO_DELTA direto do buffer de saída do MediaCodec (uma cópia por quadro, app 0.3.1).

## Contrapressão (celular)
Fila de saída limitada (8 quadros / 4 MiB; 4 quadros / 2 MiB no perfil "Baixa latência" da 0.3.4). INFO, ERROR, VIDEO_CONFIG e VIDEO_KEY nunca são descartados; um
VIDEO_KEY novo torna obsoletos os quadros de vídeo ainda na fila. Se a fila encher, os VIDEO_DELTA pendentes são
descartados, os próximos deltas também, e o encoder recebe pedido de IDR — o navegador nunca recebe um delta cuja
referência foi descartada.
