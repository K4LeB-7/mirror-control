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
   - `{"type":"input","deadmanMs":500}` (site/app 0.3.1+, só depois do `caps` abaixo) → liga o "deadman" da entrada v2.

   **CTRL celular → navegador** (app 0.3.0+): `{"type":"status","scope":"rotate"|"nav","ok":true|false,"text":"…"}`,
   texto em português para mostrar na barra do site. Os mesmos JSON `rotate`/`nav`/`status` passam pelo DataChannel
   `ctrl` no modo WebRTC. Um app antigo (≤ 0.2.0) ignora `rotate`/`nav` sem responder.
   **CTRL `{"type":"caps","input":2}`** (app 0.3.1+): enviado logo depois do PIN aceito (antes do INFO) e, no WebRTC,
   quando o canal `ctrl` abre. Anuncia a entrada v2 (próxima seção). Site antigo ignora.
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
- **Sem `caps`** (app ≤ 0.3.0) o site manda como antes (sem cópias nem keepalive; o joystick reenvia a posição a cada
  100 ms). App 0.3.1 com site antigo: geração 0, sem deadman (comportamento antigo, já com a correção abaixo).

**Toques no Android** (`TouchPlanner` + `TouchInjector`, app 0.3.1): um dedo só levanta quando um segmento
`willContinue=false` é despachado e completado (antes, um UP que chegava com um gesture em voo removia o dedo sem esse
segmento e ele ficava pressionado: "clique vira segurar"). Toque mínimo de 50 ms (DOWN e UP quase juntos continuam
sendo um clique). DOWN/UP/DOWN rápidos no mesmo ponteiro entram em fila (nada é engolido). Dedo parado não gera
gestures (só uma renovação de 8 ms a cada 250 ms); MOVE/UP com nada em voo saem na hora; MOVEs durante um gesture em
voo são agrupados (vale o último).

## Vídeo
- H.264 (Baseline, ou o perfil padrão do encoder se o Baseline falhar), CBR, I-frame a cada 1 s,
  `repeat-previous-frame-after` 150 ms (tela parada continua gerando quadros), prioridade de tempo real e
  `low-latency` quando o aparelho aceitar.
- O navegador usa WebCodecs `VideoDecoder` com o `codec` do INFO, sem `description` (Annex B), `optimizeForLatency`, e
  junta o último VIDEO_CONFIG na frente de cada VIDEO_KEY. Só desenha o quadro mais novo no `<canvas>`.

O celular monta cada VIDEO_KEY/VIDEO_DELTA direto do buffer de saída do MediaCodec (uma cópia por quadro, app 0.3.1).

## Contrapressão (celular)
Fila de saída limitada (8 quadros / 4 MiB). INFO, ERROR, VIDEO_CONFIG e VIDEO_KEY nunca são descartados; um
VIDEO_KEY novo torna obsoletos os quadros de vídeo ainda na fila. Se a fila encher, os VIDEO_DELTA pendentes são
descartados, os próximos deltas também, e o encoder recebe pedido de IDR — o navegador nunca recebe um delta cuja
referência foi descartada.
