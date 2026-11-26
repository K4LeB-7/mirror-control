/**
 * Pacote binário de entrada (DataChannel "input", não confiável/não ordenado).
 *
 *  offset  tipo      campo
 *  0       uint8     actionType
 *  1       uint8     keyId   (id do ponteiro/dedo, 0..9)
 *  2       float32   x       (0.0-1.0, relativo à largura da tela)
 *  6       float32   y       (0.0-1.0, relativo à altura da tela)
 *  10      float32   deltaX  (LOOK: fração da altura da tela; DOWN/UP: geração do toque, ver abaixo)
 *  14      float32   deltaY
 *
 * Little-endian, 18 bytes. Mesma definição em InputProtocol.kt.
 *
 * Entrada v2 (site e app 0.3.1+, extensão compatível): em DOWN/UP o campo deltaX leva a GERAÇÃO do toque (inteiro
 * ≥ 1, crescente por sessão). Assim DOWN/UP podem ser repetidos (redundância contra perda no canal sem
 * retransmissão) e um DOWN repetido com a mesma geração é keepalive. App antigo ignora deltaX em DOWN/UP.
 */
export const Action = { DOWN: 1, MOVE: 2, UP: 3, LOOK: 4, RELEASE_ALL: 5 } as const;
export type ActionType = (typeof Action)[keyof typeof Action];

export const PACKET_SIZE = 18;

/**
 * Ponteiros: 0 joystick, 1..7 botões (atribuídos no aperto, ver pointerPool.ts: até 20 botões por layout, no máximo 7
 * pressionados ao mesmo tempo), 8 toque do mouse no modo livre (e rolagem), 9 câmera. O Android injeta até 10 dedos.
 */
export const POINTER_JOYSTICK = 0;
export const POINTER_MOUSE = 8;
export const POINTER_LOOK = 9;

const buffer = new ArrayBuffer(PACKET_SIZE);
const view = new DataView(buffer);

/** Reaproveita um único buffer: RTCDataChannel.send copia os bytes na chamada. */
export function encodePacket(
  action: ActionType,
  keyId: number,
  x = 0,
  y = 0,
  dx = 0,
  dy = 0
): ArrayBuffer {
  view.setUint8(0, action);
  view.setUint8(1, keyId);
  view.setFloat32(2, x, true);
  view.setFloat32(6, y, true);
  view.setFloat32(10, dx, true);
  view.setFloat32(14, dy, true);
  return buffer;
}

/**
 * Mensagens de controle navegador → celular (DataChannel "ctrl" no WebRTC; quadro CTRL no modo USB). JSON.
 * "keyframe" só é usada no modo USB (pede um quadro-chave ao encoder após perda/erro de decodificação).
 * "rotate"/"nav" (app 0.3.0+): girar a tela e botões Voltar/Início/Recentes do Android.
 */
export type RotateMode = "portrait" | "landscape" | "auto";
export type NavAction = "back" | "home" | "recents";
export type CtrlMessage =
  | { type: "quality"; height: number; fps: number }
  | { type: "keyframe" }
  | { type: "rotate"; mode: RotateMode }
  | { type: "nav"; action: NavAction }
  /**
   * Entrada v2 (app 0.3.1+, só depois do "caps"): deadmanMs liga (WebRTC, o site manda keepalive) ou desliga (0, USB:
   * canal confiável, sem keepalive) o deadman. Site 0.3.3: manda junto o perfil de fluidez (app 0.3.3+; os anteriores
   * leem só deadmanMs).
   */
  | { type: "input"; deadmanMs: number; profile?: FluidityProfile }
  /** Medição do enlace (app 0.3.3+ responde "pong" na hora; app antigo ignora). `t` = performance.now() do site. */
  | { type: "ping"; t: number }
  /**
   * Perfil de vídeo (app 0.3.4+; app/site antigos ignoram em silêncio): "lowlat" = Baixa latência (padrão do site novo),
   * "legacy" = Padrão (0.3.3). O app reconfigura o encoder sem derrubar a conexão (INFO+CONFIG+KEY novos).
   */
  | { type: "video"; mode: VideoMode }
  /** Teste de latência do vídeo (app 0.3.4+): o app pisca um quadrado preto/branco e responde `flashAck` por pulso. */
  | { type: "flash" };

/** Perfil de vídeo (app 0.3.4+). */
export type VideoMode = "lowlat" | "legacy";
export const VIDEO_MODES: readonly { id: VideoMode; label: string; hint: string }[] = [
  { id: "lowlat", label: "Baixa latência", hint: "Padrão novo: desenho direto no decodificador, fila curta, GOP de 4 s, bitrate 75 %, latency=1 no encoder" },
  { id: "legacy", label: "Padrão (0.3.3)", hint: "Comportamento da 0.3.3: desenho no rAF, GOP de 1 s, fila de 8 quadros, bitrate cheio" },
];
export const isVideoMode = (v: unknown): v is VideoMode => v === "lowlat" || v === "legacy";

/** Perfis de fluidez do celular (app 0.3.3+). Ver docs/USB_PROTOCOLO.md. */
export type FluidityProfile = "balanced" | "smooth" | "eco";
export const FLUIDITY_PROFILES: readonly { id: FluidityProfile; label: string; hint: string }[] = [
  { id: "balanced", label: "Equilibrado", hint: "Padrão: resposta rápida com ~60 renovações/s por dedo segurado" },
  { id: "smooth", label: "Máxima fluidez", hint: "Menor latência: renova os dedos a cada quadro do display (mais CPU/bateria)" },
  { id: "eco", label: "Economia", hint: "Menos gestures/s (dedo parado renovado a cada 50 ms); toques e movimentos continuam imediatos" },
];
export const isFluidityProfile = (v: unknown): v is FluidityProfile => v === "balanced" || v === "smooth" || v === "eco";

/**
 * Celular → navegador (app 0.3.0+): resultado de rotate/nav, ex.:
 * {"type":"status","scope":"rotate","ok":false,"text":"Ative o serviço de acessibilidade…"}.
 */
export type PhoneStatus = { type: "status"; scope: string; ok: boolean; text: string };

/**
 * Celular → navegador, ao abrir a conexão: `{"type":"caps","input":2}` (app 0.3.1+) = entende a entrada v2;
 * app 0.3.3+: `"profile":1` (perfis de fluidez) e `"ping":1` (responde ping).
 */
export type PhoneCaps = { type: "caps"; input: number; profile: number; ping: number };

/** Celular → navegador (app 0.3.3+): perfil aplicado (resposta ao CTRL input.profile). */
export type PhoneProfile = { type: "profile"; profile: FluidityProfile; frameMs: number; text: string };

/** Celular → navegador (app 0.3.3+): resposta ao ping. p = µs no app; d = mediana DOWN→dispatch (ms, -1 = sem dados). */
export type PhonePong = { type: "pong"; t: number; p: number; d: number; profile?: FluidityProfile; /** app 0.3.4+: relógio do celular (µs, a base do PTS do vídeo) na ida do pong ao socket. */ pm?: number; /** app 0.3.4+: µs entre o celular receber o ping e o pong ir ao socket (com `pm`). */ pq?: number };

/** [p50, p95, max] em ms (a mesma definição de índices do app e do site: p50 = s[(n-1)/2], p95 = s[(n-1)*95/100]). */
export type VstatPct = { p50: number; p95: number; max: number };

/**
 * Celular → navegador (app 0.3.4+, ~1 Hz): estatística do encoder. `enc` = captura+codificação no celular (null se o
 * relógio do PTS não foi confirmado, ver `clk`), `q` = espera na fila de saída do app, `wr` = write+flush no socket.
 */
export type PhoneVstat = {
  type: "vstat";
  seq: number;
  enc: VstatPct | null;
  q: VstatPct | null;
  wr: VstatPct | null;
  fps: number;
  kbps: number;
  keyMaxKB: number;
  queueDrops: number;
  queueOverflows: number;
  queuePeak: number;
  /** Base do PTS: "mono" | "boot" | "unk" (não confirmada: `enc` nulo e a idade do quadro fica "—"). */
  clk: string;
  mode: VideoMode | "";
  /** Nível de configuração que o encoder aceitou (3 = baixa latência completa). */
  tier: number;
  rej: string;
  width: number;
  height: number;
  capFps: number;
  targetKbps: number;
  gop: number;
  n: number;
  /** Versão do app (versionName), quando informada. */
  ver: string;
};

/** Celular → navegador (app 0.3.4+): pulso branco apresentado (`pm` µs, base do pong) ou fim do teste (`end`). */
export type PhoneFlashAck = { type: "flashAck"; n: number; pm: number; pm0?: number; vs?: number; end: boolean; pulses?: number };

const pct = (v: unknown): VstatPct | null => {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const p50 = Number(o.p50), p95 = Number(o.p95), max = Number(o.max);
  return Number.isFinite(p50) && Number.isFinite(p95) && Number.isFinite(max) ? { p50, p95, max } : null;
};
const num = (v: unknown, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function parsePhoneCtrl(text: string): PhoneStatus | PhoneCaps | PhoneProfile | PhonePong | PhoneVstat | PhoneFlashAck | null {
  try {
    const j = JSON.parse(text);
    if (j && j.type === "status" && j.scope === "profile" && isFluidityProfile(j.profile))
      return { type: "profile", profile: j.profile, frameMs: Number(j.frameMs) || 0, text: String(j.text ?? "").slice(0, 300) };
    if (j && j.type === "status" && typeof j.text === "string")
      return { type: "status", scope: String(j.scope ?? ""), ok: j.ok !== false, text: j.text.slice(0, 300) };
    if (j && j.type === "caps") return { type: "caps", input: Number(j.input) || 0, profile: Number(j.profile) || 0, ping: Number(j.ping) || 0 };
    if (j && j.type === "pong" && Number.isFinite(Number(j.t)))
      return {
        type: "pong", t: Number(j.t), p: Number(j.p) || 0, d: Number.isFinite(Number(j.d)) ? Number(j.d) : -1,
        profile: isFluidityProfile(j.profile) ? j.profile : undefined,
        ...(j.pm !== undefined && j.pm !== null && Number.isFinite(Number(j.pm)) ? { pm: Number(j.pm) } : {}),
        ...(j.pq !== undefined && j.pq !== null && Number.isFinite(Number(j.pq)) && Number(j.pq) >= 0 ? { pq: Number(j.pq) } : {}),
      };
    if (j && j.type === "vstat")
      return {
        type: "vstat", seq: num(j.seq), enc: pct(j.enc), q: pct(j.q), wr: pct(j.wr), fps: num(j.fps), kbps: num(j.kbps),
        keyMaxKB: num(j.keyMaxKB), queueDrops: num(j.queueDrops), queueOverflows: num(j.queueOverflows),
        queuePeak: num(j.queuePeak), clk: String(j.clk ?? "unk").slice(0, 8), mode: isVideoMode(j.mode) ? j.mode : "",
        tier: num(j.tier, -1), rej: String(j.rej ?? "").slice(0, 80), width: num(j.vw), height: num(j.vh),
        capFps: num(j.capFps), targetKbps: num(j.targetKbps), gop: num(j.gop), n: num(j.n),
        ver: String(j.ver ?? "").replace(/[^0-9A-Za-z.\-]/g, "").slice(0, 16),
      };
    if (j && j.type === "flashAck") {
      const end = j.end === 1 || j.end === true;
      if (end) return { type: "flashAck", n: 0, pm: 0, end: true, pulses: num(j.pulses) };
      if (Number.isFinite(Number(j.n)) && Number.isFinite(Number(j.pm)) && Number(j.n) >= 1)
        return { type: "flashAck", n: Number(j.n), pm: Number(j.pm), pm0: j.pm0 === undefined ? undefined : num(j.pm0), vs: j.vs === undefined ? undefined : num(j.vs), end: false };
    }
  } catch {}
  return null;
}

/** Tempos da entrada v2 (ms). Ver docs/USB_PROTOCOLO.md, "Entrada". */
export const INPUT_V2 = {
  /** DOWN/UP repetidos depois deste atraso (perda de um pacote isolado não perde a borda). */
  redundancyMs: [20, 60] as readonly number[],
  /** Enquanto um dedo está segurado, o site reenvia DOWN(gen) (e a posição) neste intervalo. */
  keepaliveMs: 100,
  /** Sem keepalive/MOVE por este tempo, o celular solta o dedo sozinho (UP perdido nunca prende). */
  deadmanMs: 500,
};
