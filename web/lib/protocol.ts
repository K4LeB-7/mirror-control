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
  | { type: "ping"; t: number };

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
export type PhonePong = { type: "pong"; t: number; p: number; d: number; profile?: FluidityProfile };

export function parsePhoneCtrl(text: string): PhoneStatus | PhoneCaps | PhoneProfile | PhonePong | null {
  try {
    const j = JSON.parse(text);
    if (j && j.type === "status" && j.scope === "profile" && isFluidityProfile(j.profile))
      return { type: "profile", profile: j.profile, frameMs: Number(j.frameMs) || 0, text: String(j.text ?? "").slice(0, 300) };
    if (j && j.type === "status" && typeof j.text === "string")
      return { type: "status", scope: String(j.scope ?? ""), ok: j.ok !== false, text: j.text.slice(0, 300) };
    if (j && j.type === "caps") return { type: "caps", input: Number(j.input) || 0, profile: Number(j.profile) || 0, ping: Number(j.ping) || 0 };
    if (j && j.type === "pong" && Number.isFinite(Number(j.t)))
      return { type: "pong", t: Number(j.t), p: Number(j.p) || 0, d: Number.isFinite(Number(j.d)) ? Number(j.d) : -1, profile: isFluidityProfile(j.profile) ? j.profile : undefined };
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
