/**
 * Modos do mouse (módulo PURO, testado em tests/ui.test.ts).
 *
 * - LIVRE (padrão ao conectar): cursor visível, sem Pointer Lock. O mouse age como a tela de toque:
 *   botão esquerdo = toque/arrasto (ponteiro 8), roda = rolagem (swipe curto), botão direito = "Voltar".
 * - TRAVADO: Pointer Lock; movimento = câmera (LOOK), botões/roda do mouse = controles mapeados.
 *
 * Alterna pelo botão da barra ou pelo atalho (padrão F8). Esc (ou perder o Pointer Lock por qualquer motivo) sempre
 * volta ao livre, e o site nunca trava de novo sozinho. Toda troca solta todos os dedos (RELEASE_ALL).
 */
export type MouseMode = "free" | "locked";

/** requesting: pedimos o Pointer Lock e o navegador ainda não respondeu (continua livre até lá). */
export type ModeState = { mode: MouseMode; requesting: boolean };

export type ModeEvent =
  | "toggle" // botão da barra / atalho
  | "lockAcquired" // pointerlockchange com o nosso elemento travado
  | "lockLost" // pointerlockchange sem trava (Esc do navegador, troca de aba…)
  | "lockError" // pointerlockerror / requestPointerLock rejeitado
  | "escape" // tecla Esc recebida pela página
  | "blur"; // janela perdeu o foco

export type ModeEffect = "requestLock" | "exitLock" | "releaseAll";

export const INITIAL_MODE: ModeState = { mode: "free", requesting: false };

export function nextMode(s: ModeState, ev: ModeEvent): { state: ModeState; effects: ModeEffect[] } {
  switch (ev) {
    case "toggle":
      if (s.mode === "locked") return { state: { mode: "free", requesting: false }, effects: ["exitLock", "releaseAll"] };
      if (s.requesting) return { state: s, effects: [] }; // já pedido; espera a resposta
      return { state: { mode: "free", requesting: true }, effects: ["requestLock"] };
    case "lockAcquired":
      return { state: { mode: "locked", requesting: false }, effects: ["releaseAll"] };
    case "lockLost":
      return {
        state: { mode: "free", requesting: false },
        effects: s.mode === "locked" ? ["releaseAll"] : [],
      };
    case "lockError":
      return { state: { mode: "free", requesting: false }, effects: [] };
    case "escape":
      if (s.mode === "locked") return { state: { mode: "free", requesting: false }, effects: ["exitLock", "releaseAll"] };
      return { state: { mode: "free", requesting: false }, effects: [] };
    case "blur":
      return { state: s, effects: ["releaseAll"] };
  }
}

// ---------------------------------------------------------------- roda do mouse → swipe

export type Point = { x: number; y: number };

export const WHEEL = {
  /** Distância de um "dente" da roda (100 px de deltaY), em fração da altura/largura da tela. */
  perNotch: 0.15,
  min: 0.08,
  max: 0.45,
  /** Pontos intermediários (um MOVE a cada ~16 ms) e quadros parados no fim (sem "fling"). */
  steps: 8,
  hold: 2,
  /** Margem das bordas: swipes que começam na borda abrem a barra de notificações/gestos do sistema. */
  edge: 0.06,
};

/** Converte deltaY/deltaX de WheelEvent para px (deltaMode 1 = linhas, 2 = páginas). */
export function wheelPixels(delta: number, deltaMode = 0): number {
  return deltaMode === 1 ? delta * 40 : deltaMode === 2 ? delta * 800 : delta;
}

/**
 * Swipe que rola o conteúdo como a roda do mouse: rolar para BAIXO (delta > 0) = dedo sobe.
 * Começa no ponto do cursor (deslocado para longe das bordas se preciso) e devolve todos os pontos, do DOWN ao UP.
 * Rolagem horizontal (deltaX dominante) gera swipe horizontal.
 */
export function wheelSwipe(at: Point, deltaX: number, deltaY: number, deltaMode = 0): Point[] {
  const px = wheelPixels(deltaX, deltaMode);
  const py = wheelPixels(deltaY, deltaMode);
  const horizontal = Math.abs(px) > Math.abs(py);
  const d = horizontal ? px : py;
  if (d === 0) return [];
  const dist = Math.min(WHEEL.max, Math.max(WHEEL.min, (Math.abs(d) / 100) * WHEEL.perNotch));
  const dir = d > 0 ? -1 : 1; // conteúdo desce → dedo sobe
  const lo = WHEEL.edge;
  const hi = 1 - WHEEL.edge;
  const span = Math.min(dist, hi - lo);
  const fit = (start: number) => {
    // garante que início e fim fiquem dentro de [lo, hi]
    const end = start + dir * span;
    if (end < lo) return lo + span;
    if (end > hi) return hi - span;
    return Math.min(hi, Math.max(lo, start));
  };
  const sx = horizontal ? fit(at.x) : Math.min(hi, Math.max(lo, at.x));
  const sy = horizontal ? Math.min(hi, Math.max(lo, at.y)) : fit(at.y);
  const pts: Point[] = [];
  for (let i = 0; i <= WHEEL.steps; i++) {
    const t = i / WHEEL.steps;
    const e = t * t * (3 - 2 * t); // suaviza início/fim
    pts.push(horizontal ? { x: sx + dir * span * e, y: sy } : { x: sx, y: sy + dir * span * e });
  }
  for (let i = 0; i < WHEEL.hold; i++) pts.push({ ...pts[pts.length - 1] });
  return pts;
}

/** Foco em campo de texto: teclas não viram toques nem atalhos. */
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as { tagName?: string; isContentEditable?: boolean; type?: string } | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName.toUpperCase();
  if (tag === "INPUT") return !["checkbox", "radio", "button", "submit", "reset", "color", "file"].includes(String(el.type));
  return tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}
