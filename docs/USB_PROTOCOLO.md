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
     falhou ou descartou quadros.
5. Ao desconectar: celular solta todos os dedos (`releaseAll`) e para o encoder (a VirtualDisplay fica sem surface,
   pronta para a próxima conexão).

Códigos de ERROR: `PIN_INVALID`, `LOCKED` e `REPLACED` (o navegador não reconecta sozinho); `TIMEOUT`, `PROTOCOL`,
`ENCODER` (o navegador tenta de novo).

## Vídeo
- H.264 (Baseline, ou o perfil padrão do encoder se o Baseline falhar), CBR, I-frame a cada 1 s,
  `repeat-previous-frame-after` 150 ms (tela parada continua gerando quadros), prioridade de tempo real e
  `low-latency` quando o aparelho aceitar.
- O navegador usa WebCodecs `VideoDecoder` com o `codec` do INFO, sem `description` (Annex B), `optimizeForLatency`, e
  junta o último VIDEO_CONFIG na frente de cada VIDEO_KEY. Só desenha o quadro mais novo no `<canvas>`.

## Contrapressão (celular)
Fila de saída limitada (8 quadros / 4 MiB). INFO, ERROR, VIDEO_CONFIG e VIDEO_KEY nunca são descartados; um
VIDEO_KEY novo torna obsoletos os quadros de vídeo ainda na fila. Se a fila encher, os VIDEO_DELTA pendentes são
descartados, os próximos deltas também, e o encoder recebe pedido de IDR — o navegador nunca recebe um delta cuja
referência foi descartada.
