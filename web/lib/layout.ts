/** Mapeamento de teclas/mouse → toques. Posições em % (0.0-1.0) da tela do celular. */
export type TapButton = {
  id: string;
  label: string;
  /** KeyboardEvent.code (ex.: "Space"). Opcional. */
  key?: string;
  /** Botão do mouse: 0 esquerdo, 1 meio, 2 direito. Opcional. */
  mouse?: number;
  x: number;
  y: number;
};

export type Joystick = {
  x: number;
  y: number;
  /** Raio em fração da ALTURA da tela. */
  radius: number;
  up: string;
  down: string;
  left: string;
  right: string;
};

export type Look = {
  /** Âncora onde o dedo da "câmera" encosta. */
  x: number;
  y: number;
  sensitivity: number;
};

export type Layout = { buttons: TapButton[]; joystick: Joystick; look: Look };

export const MAX_BUTTONS = 7;

export const DEFAULT_LAYOUT: Layout = {
  joystick: { x: 0.14, y: 0.68, radius: 0.16, up: "KeyW", down: "KeyS", left: "KeyA", right: "KeyD" },
  look: { x: 0.7, y: 0.5, sensitivity: 1 },
  buttons: [
    { id: "fire", label: "Atirar", mouse: 0, x: 0.88, y: 0.62 },
    { id: "aim", label: "Mirar", mouse: 2, x: 0.8, y: 0.45 },
    { id: "jump", label: "Pular", key: "Space", x: 0.92, y: 0.8 },
    { id: "crouch", label: "Agachar", key: "KeyC", x: 0.8, y: 0.85 },
    { id: "reload", label: "Recarregar", key: "KeyR", x: 0.68, y: 0.85 },
  ],
};

const STORAGE_KEY = "mirror-control.layout.v1";

export function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_LAYOUT, ...JSON.parse(raw) };
  } catch {}
  return structuredClone(DEFAULT_LAYOUT);
}

export function saveLayout(l: Layout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(l));
  } catch {}
}

export function keyLabel(code?: string): string {
  if (!code) return "";
  return code.replace(/^Key/, "").replace(/^Digit/, "");
}
