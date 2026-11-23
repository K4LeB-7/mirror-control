/**
 * Mapeamento de teclas/mouse → toques. Módulo PURO (sem DOM): tipos, layouts padrão e geometria.
 *
 * Posições (x, y) em fração (0.0-1.0) da largura/altura da tela do celular → valem para qualquer resolução.
 * Tamanhos (size, radius) em fração do LADO MENOR da tela → o joystick e os botões são sempre círculos, em retrato
 * ou paisagem, e escalam com o tamanho do vídeo na página.
 */

export type Orientation = "portrait" | "landscape";

/** Como um botão reage: segurar (DOWN enquanto pressionado), alternar (1º aperto DOWN, 2º UP), toque rápido. */
export type ButtonMode = "hold" | "toggle" | "tap";

/**
 * Atribuição de entrada, como texto: "key:<KeyboardEvent.code>", "mouse:0|1|2" (esquerdo/meio/direito),
 * "wheel:up" | "wheel:down" (roda do mouse; sempre age como toque rápido).
 */
export type Bind = string;

export type ButtonControl = {
  id: string;
  label: string;
  bind?: Bind;
  mode: ButtonMode;
  /**
   * OBSOLETO (site até 0.3.2: ponteiro fixo 1..7 por botão). Ignorado: o ponteiro agora é pego de um pool quando o
   * botão é pressionado (lib/pointerPool.ts). Perfis antigos que ainda o têm abrem normalmente; o saneamento o remove.
   */
  pointer?: number;
  x: number;
  y: number;
  /** Diâmetro em fração do lado menor da tela. */
  size: number;
};

export type Joystick = {
  /** false = removido do layout (WASD não age). Fica guardado para "adicionar de volta" com as mesmas teclas. */
  enabled: boolean;
  x: number;
  y: number;
  /** Quanto o dedo virtual arrasta a partir do centro, em fração do lado menor da tela. */
  radius: number;
  /** Diâmetro do círculo desenhado no overlay, em fração do lado menor da tela. */
  size: number;
  /** KeyboardEvent.code das 4 direções. */
  up: string;
  down: string;
  left: string;
  right: string;
};

export type Look = {
  /** false = removida do layout (o mouse travado não gera LOOK). */
  enabled: boolean;
  /** Âncora onde o dedo da "câmera" encosta (modo travado). */
  x: number;
  y: number;
  sensX: number;
  sensY: number;
  invertY: boolean;
};

export type Layout = {
  joystick: Joystick;
  look: Look;
  buttons: ButtonControl[];
  /** true depois que o usuário editou ou confirmou este layout (o mapeador não abre mais sozinho). */
  confirmed?: boolean;
};

/**
 * Botões por layout (por perfil e orientação). Não confundir com os botões pressionados AO MESMO TEMPO: no máximo 7
 * (ponteiros 1..7, atribuídos na hora do aperto; 0 joystick, 8 mouse livre, 9 câmera — ver lib/pointerPool.ts).
 */
export const MAX_BUTTONS = 20;
export const POINTER_MOUSE = 8;

export const BUTTON_SIZE = { min: 0.06, max: 0.35, default: 0.15 };
export const JOY_RADIUS = { min: 0.05, max: 0.35 };
export const JOY_SIZE = { min: 0.12, max: 0.7 };

const btn = (id: string, label: string, bind: Bind, x: number, y: number, size: number): ButtonControl => ({
  id,
  label,
  bind,
  mode: "hold",
  x,
  y,
  size,
});

/** Paisagem: joystick à esquerda, ações à direita. Sem sobreposição de 16:9 a 21:9 (ver tests/ui.test.ts). */
export const DEFAULT_LANDSCAPE: Layout = {
  joystick: { enabled: true, x: 0.14, y: 0.68, radius: 0.16, size: 0.36, up: "KeyW", down: "KeyS", left: "KeyA", right: "KeyD" },
  look: { enabled: true, x: 0.62, y: 0.45, sensX: 1, sensY: 1, invertY: false },
  buttons: [
    btn("fire", "Atirar", "mouse:0", 0.86, 0.6, 0.15),
    btn("aim", "Mirar", "mouse:2", 0.76, 0.42, 0.15),
    btn("jump", "Pular", "key:Space", 0.93, 0.8, 0.15),
    btn("crouch", "Agachar", "key:KeyC", 0.82, 0.84, 0.15),
    btn("reload", "Recarregar", "key:KeyR", 0.7, 0.84, 0.15),
  ],
};

/** Retrato: joystick embaixo à esquerda, ações embaixo à direita. Sem sobreposição de 9:16 a 9:21. */
export const DEFAULT_PORTRAIT: Layout = {
  joystick: { enabled: true, x: 0.25, y: 0.8, radius: 0.16, size: 0.36, up: "KeyW", down: "KeyS", left: "KeyA", right: "KeyD" },
  look: { enabled: true, x: 0.5, y: 0.45, sensX: 1, sensY: 1, invertY: false },
  buttons: [
    btn("fire", "Atirar", "mouse:0", 0.8, 0.74, 0.17),
    btn("aim", "Mirar", "mouse:2", 0.62, 0.66, 0.17),
    btn("jump", "Pular", "key:Space", 0.86, 0.86, 0.17),
    btn("crouch", "Agachar", "key:KeyC", 0.66, 0.92, 0.17),
    btn("reload", "Recarregar", "key:KeyR", 0.86, 0.62, 0.17),
  ],
};

export const defaultLayout = (o: Orientation): Layout =>
  structuredClone(o === "portrait" ? DEFAULT_PORTRAIT : DEFAULT_LANDSCAPE);

/** Proporção largura/altura do vídeo → layout usado. Quadrado conta como paisagem. */
export const orientationFor = (aspect: number): Orientation => (aspect >= 1 ? "landscape" : "portrait");

// ---------------------------------------------------------------- rótulos

const KEY_NAMES: Record<string, string> = {
  Space: "Espaço",
  ShiftLeft: "Shift",
  ShiftRight: "Shift D",
  ControlLeft: "Ctrl",
  ControlRight: "Ctrl D",
  AltLeft: "Alt",
  AltRight: "Alt Gr",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "⌫",
  CapsLock: "Caps",
};

export function keyLabel(code?: string): string {
  if (!code) return "";
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  return code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "Num ");
}

const MOUSE_NAMES = ["Mouse E", "Mouse M", "Mouse D"];

export function bindLabel(bind?: Bind): string {
  if (!bind) return "—";
  const [kind, v] = splitBind(bind);
  if (kind === "key") return keyLabel(v);
  if (kind === "mouse") return MOUSE_NAMES[Number(v)] ?? `Mouse ${v}`;
  if (kind === "wheel") return v === "up" ? "Roda ↑" : "Roda ↓";
  return bind;
}

export function splitBind(bind: Bind): [string, string] {
  const i = bind.indexOf(":");
  return i < 0 ? ["", bind] : [bind.slice(0, i), bind.slice(i + 1)];
}

export const keyBind = (code: string): Bind => `key:${code}`;
export const mouseBind = (button: number): Bind => `mouse:${button}`;
export const wheelBind = (dir: "up" | "down"): Bind => `wheel:${dir}`;

// ---------------------------------------------------------------- geometria

export type Rect = { left: number; top: number; width: number; height: number };

/** Maior retângulo com a proporção `aspect` que cabe centralizado em boxW×boxH ("object-fit: contain"). */
export function fitContain(boxW: number, boxH: number, aspect: number): Rect {
  if (!(boxW > 0 && boxH > 0 && aspect > 0)) return { left: 0, top: 0, width: 0, height: 0 };
  let width = boxW;
  let height = boxW / aspect;
  if (height > boxH) {
    height = boxH;
    width = boxH * aspect;
  }
  return { left: (boxW - width) / 2, top: (boxH - height) / 2, width, height };
}

/**
 * Ponto da tela do navegador → coordenada normalizada (0..1) do vídeo cujo conteúdo ocupa `content`.
 * Fora do conteúdo (faixa preta/letterbox) devolve null, a menos que `clamp` (arrasto que sai da imagem).
 * `tolerancePx`: aceita (e limita a 0..1) pontos até essa distância fora da borda — clientX/Y do mouse são inteiros
 * no Chrome e a borda da imagem pode cair entre dois pixels.
 */
export function toNormalized(content: Rect, clientX: number, clientY: number, clamp = false, tolerancePx = 0) {
  if (!(content.width > 0 && content.height > 0)) return null;
  const x = (clientX - content.left) / content.width;
  const y = (clientY - content.top) / content.height;
  const tx = tolerancePx / content.width;
  const ty = tolerancePx / content.height;
  if (!clamp && (x < -tx || x > 1 + tx || y < -ty || y > 1 + ty)) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

/** Deslocamento do dedo do joystick (vetor unitário vx,vy) em frações de largura/altura da tela. */
export function joystickOffset(vx: number, vy: number, radius: number, aspect: number) {
  // radius é fração do lado menor: em paisagem (aspect>=1) o menor é a altura; em retrato, a largura.
  const fx = aspect >= 1 ? radius / aspect : radius;
  const fy = aspect >= 1 ? radius : radius * aspect;
  return { dx: vx * fx, dy: vy * fy };
}

export type ControlBox = { id: string; kind: "joy" | "look" | "btn"; rect: Rect };

/** Tamanho visual mínimo em px (legibilidade em vídeos pequenos). */
export const MIN_CONTROL_PX = 22;
export const LOOK_SIZE = 0.12;

/** Retângulos em px de cada controle (só os habilitados), para um vídeo de w×h px. Círculos: largura = altura. */
export function controlBoxes(layout: Layout, w: number, h: number): ControlBox[] {
  const short = Math.min(w, h);
  const box = (id: string, kind: ControlBox["kind"], x: number, y: number, size: number): ControlBox => {
    const d = Math.max(MIN_CONTROL_PX, size * short);
    return { id, kind, rect: { left: x * w - d / 2, top: y * h - d / 2, width: d, height: d } };
  };
  const j = layout.joystick;
  const out: ControlBox[] = [];
  if (j.enabled) out.push(box("joystick", "joy", j.x, j.y, j.size));
  if (layout.look.enabled) out.push(box("look", "look", layout.look.x, layout.look.y, LOOK_SIZE));
  for (const b of layout.buttons) out.push(box(b.id, "btn", b.x, b.y, b.size));
  return out;
}

/** Controles que existem no layout (para a lista do editor e para "layout vazio"). */
export function controlCount(layout: Layout): number {
  return (layout.joystick.enabled ? 1 : 0) + (layout.look.enabled ? 1 : 0) + layout.buttons.length;
}

export function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  return (
    a.left < b.left + b.width + margin &&
    b.left < a.left + a.width + margin &&
    a.top < b.top + b.height + margin &&
    b.top < a.top + a.height + margin
  );
}

/** Pares de controles sobrepostos (ids), para avisos e testes. */
export function overlappingControls(layout: Layout, w: number, h: number): [string, string][] {
  const boxes = controlBoxes(layout, w, h);
  const out: [string, string][] = [];
  for (let i = 0; i < boxes.length; i++)
    for (let k = i + 1; k < boxes.length; k++)
      if (rectsOverlap(boxes[i].rect, boxes[k].rect)) out.push([boxes[i].id, boxes[k].id]);
  return out;
}

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------- posição de um botão novo

/** Tamanho de referência (px) de um vídeo com a proporção `aspect`: lado menor = 1000. */
function refSize(aspect: number) {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9;
  return a >= 1 ? { w: 1000 * a, h: 1000 } : { w: 1000, h: 1000 / a };
}

/**
 * Onde um botão novo (diâmetro `size`) deve nascer, para botões criados em sequência não ficarem empilhados:
 * - o ponto pedido (`want`, o clique no vídeo), se ali o botão não encosta em nenhum controle;
 * - senão (ou sem ponto pedido), o centro livre mais próximo numa grade que cobre a tela (dentro da tela);
 * - tela sem espaço livre: o ponto pedido (ou o centro) com um deslocamento escalonado pelo número de botões.
 */
export function freeSpot(layout: Layout, aspect: number, size = BUTTON_SIZE.default, want?: { x: number; y: number }) {
  const { w, h } = refSize(aspect);
  const d = size * Math.min(w, h);
  const gap = d * 0.08;
  const boxes = controlBoxes(layout, w, h).map((b) => b.rect);
  const rectAt = (cx: number, cy: number): Rect => ({ left: cx - d / 2, top: cy - d / 2, width: d, height: d });
  const free = (r: Rect) => !boxes.some((b) => rectsOverlap(r, b, gap));
  const tx = (want ? clamp01(want.x) : 0.5) * w;
  const ty = (want ? clamp01(want.y) : 0.5) * h;
  if (want && free(rectAt(tx, ty))) return { x: clamp01(want.x), y: clamp01(want.y) };
  const step = d + gap;
  const cols = Math.max(1, Math.floor(w / step));
  const rows = Math.max(1, Math.floor(h / step));
  const ox = (w - cols * step) / 2 + step / 2;
  const oy = (h - rows * step) / 2 + step / 2;
  const cells: { x: number; y: number; dist: number }[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const x = ox + c * step;
      const y = oy + r * step;
      cells.push({ x, y, dist: Math.hypot(x - tx, y - ty) });
    }
  cells.sort((a, b) => a.dist - b.dist || a.y - b.y || a.x - b.x);
  for (const c of cells) if (free(rectAt(c.x, c.y))) return { x: c.x / w, y: c.y / h };
  const k = (layout.buttons.length % 8) + 1;
  return { x: clampTo(tx / w + 0.04 * k, 0.05, 0.95), y: clampTo(ty / h + 0.04 * k, 0.05, 0.95) };
}
