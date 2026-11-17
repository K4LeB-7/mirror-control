import { Action, CtrlMessage, POINTER_JOYSTICK, POINTER_LOOK, POINTER_MOUSE, encodePacket } from "./protocol";
import { ButtonControl, Layout, clamp01, joystickOffset, keyBind, mouseBind, wheelBind } from "./layout";
import { MouseMode, Point, isEditableTarget, wheelSwipe } from "./mouseModes";
import type { UiSettings } from "./profiles";

/** O que o controlador precisa de uma sessão (WebRTC `RemoteSession` ou USB `UsbSession`). */
export type InputSink = { sendInput(buf: ArrayBuffer): void; sendCtrl?(msg: CtrlMessage): void };

export type InputHooks = {
  /** Layout da orientação atual (retrato/paisagem). */
  getLayout(): Layout;
  /** Largura/altura do vídeo. */
  getAspect(): number;
  getMode(): MouseMode;
  getSettings(): UiSettings;
  /** Editor aberto: teclas mapeadas não viram toques (setas/Delete/captura são do editor). */
  keysSuspended(): boolean;
  /** Esperando "pressione uma tecla" no editor: nem o atalho de travar vale. */
  capturing(): boolean;
  /** Capturando atalho ou posicionando um controle: o mouse não vira toque. */
  mouseSuspended(): boolean;
  /**
   * Ponto normalizado (0..1) da imagem do celular sob o evento, ou null se o evento não é sobre o vídeo
   * (barra, painel, controle sendo editado, faixa preta). Com clamp, sempre devolve um ponto (arrasto em andamento).
   */
  pointAt(e: MouseEvent, clamp: boolean): Point | null;
  onToggleMode(): void;
  onEscape(): void;
};

const TAP_MS = 60;
const STEP_MS = 16;

/**
 * Converte teclado + mouse em pacotes de toque de 18 bytes.
 * Modo livre: mouse = dedo (ponteiro 8), roda = swipe, direito = Voltar. Modo travado: movimento = LOOK (9),
 * botões/roda = controles mapeados. Teclas mapeadas nos dois modos (no livre, se a opção estiver ligada).
 */
export class InputController {
  private down = new Set<string>(); // KeyboardEvent.code pressionados (joystick)
  private active = new Map<string, number>(); // id do botão -> ponteiro pressionado
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private joyActive = false;
  private lookDx = 0;
  private lookDy = 0;
  private raf = 0;
  private attached = false;
  /** O canal "input" não retransmite: reenvia a posição do joystick enquanto ele estiver ativo. */
  private joyTimer: ReturnType<typeof setInterval> | null = null;
  private joyPos = { x: 0, y: 0 };
  // Modo livre: arrasto do botão esquerdo e swipe da roda (ambos no ponteiro 8).
  private dragging = false;
  private dragPending: Point | null = null;
  private dragRaf = 0;
  private swipe: { pts: Point[]; i: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
  private wheelQueue: { at: Point; dx: number; dy: number; mode: number } | null = null;

  constructor(private session: InputSink, private h: InputHooks) {}

  attach() {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    window.addEventListener("mousedown", this.onMouseDown, true);
    window.addEventListener("mouseup", this.onMouseUp, true);
    window.addEventListener("mousemove", this.onMouseMove, true);
    window.addEventListener("wheel", this.onWheel, { capture: true, passive: false });
    window.addEventListener("blur", this.releaseAll);
    window.addEventListener("contextmenu", this.onContext, true);
  }

  detach() {
    if (!this.attached) return;
    this.attached = false;
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    window.removeEventListener("mousedown", this.onMouseDown, true);
    window.removeEventListener("mouseup", this.onMouseUp, true);
    window.removeEventListener("mousemove", this.onMouseMove, true);
    window.removeEventListener("wheel", this.onWheel, true);
    window.removeEventListener("blur", this.releaseAll);
    window.removeEventListener("contextmenu", this.onContext, true);
    this.releaseAll();
  }

  /** Solta todos os dedos (troca de modo, perda de foco, editor aberto, rotação…). */
  releaseAll = () => {
    this.down.clear();
    this.active.clear();
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.joyActive = false;
    this.stopJoyRepeat();
    this.lookDx = this.lookDy = 0;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.dragging = false;
    this.dragPending = null;
    if (this.dragRaf) cancelAnimationFrame(this.dragRaf);
    this.dragRaf = 0;
    if (this.swipe?.timer) clearTimeout(this.swipe.timer);
    this.swipe = null;
    this.wheelQueue = null;
    this.send(Action.RELEASE_ALL, 0);
  };

  private send(a: (typeof Action)[keyof typeof Action], k: number, x = 0, y = 0, dx = 0, dy = 0) {
    this.session.sendInput(encodePacket(a, k, x, y, dx, dy));
  }

  private locked() {
    return this.h.getMode() === "locked";
  }

  private onContext = (e: Event) => {
    if (this.locked() || this.h.pointAt(e as MouseEvent, false)) e.preventDefault();
  };

  // ---------------------------------------------------------------- teclado

  private keysActive() {
    if (this.h.keysSuspended()) return false;
    return this.locked() || this.h.getSettings().keysInFree;
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (isEditableTarget(e.target)) return;
    if (e.code === "Escape") {
      if (this.locked()) this.h.onEscape();
      return;
    }
    if (this.h.capturing()) return; // o painel está capturando esta tecla
    if (e.code === this.h.getSettings().toggleKey) {
      e.preventDefault();
      if (!e.repeat) this.h.onToggleMode(); // com o editor aberto, fecha o painel e trava
      return;
    }
    if (this.h.keysSuspended()) return; // editor: setas/Delete são do painel
    if (e.repeat || !this.keysActive()) {
      if (e.repeat && this.isMapped(e.code)) e.preventDefault();
      return;
    }
    const layout = this.h.getLayout();
    let handled = false;
    const j = layout.joystick;
    if ([j.up, j.down, j.left, j.right].includes(e.code)) {
      this.down.add(e.code);
      this.updateJoystick();
      handled = true;
    }
    const bind = keyBind(e.code);
    for (const b of layout.buttons) if (b.bind === bind) handled = this.pressBind(b) || handled;
    if (handled) e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (this.down.delete(e.code)) this.updateJoystick();
    const bind = keyBind(e.code);
    for (const b of this.h.getLayout().buttons) if (b.bind === bind) this.releaseHold(b);
  };

  private isMapped(code: string) {
    const l = this.h.getLayout();
    const j = l.joystick;
    return [j.up, j.down, j.left, j.right].includes(code) || l.buttons.some((b) => b.bind === keyBind(code));
  }

  // ---------------------------------------------------------------- mouse

  private onMouseDown = (e: MouseEvent) => {
    if (this.locked()) {
      e.preventDefault();
      if (this.h.keysSuspended()) return;
      const bind = mouseBind(e.button);
      for (const b of this.h.getLayout().buttons) if (b.bind === bind) this.pressBind(b);
      return;
    }
    if (this.h.mouseSuspended()) return;
    const p = this.h.pointAt(e, false);
    if (!p) return;
    if (e.button === 0) {
      e.preventDefault();
      this.cancelSwipe();
      this.dragging = true;
      this.dragPending = null;
      this.send(Action.DOWN, POINTER_MOUSE, p.x, p.y);
    } else if (e.button === 2) {
      e.preventDefault();
      this.session.sendCtrl?.({ type: "nav", action: "back" });
    } else {
      e.preventDefault(); // botão do meio: sem o "autoscroll" do navegador sobre o vídeo
    }
  };

  private onMouseUp = (e: MouseEvent) => {
    const bind = mouseBind(e.button);
    for (const b of this.h.getLayout().buttons) if (b.bind === bind) this.releaseHold(b);
    if (e.button === 0 && this.dragging) {
      const p = this.h.pointAt(e, true) ?? this.dragPending;
      if (p) this.send(Action.MOVE, POINTER_MOUSE, p.x, p.y);
      this.send(Action.UP, POINTER_MOUSE);
      this.dragging = false;
      this.dragPending = null;
      if (this.dragRaf) cancelAnimationFrame(this.dragRaf);
      this.dragRaf = 0;
    }
  };

  private onMouseMove = (e: MouseEvent) => {
    if (this.locked()) {
      this.lookDx += e.movementX;
      this.lookDy += e.movementY;
      if (!this.raf) this.raf = requestAnimationFrame(this.flushLook);
      return;
    }
    if (!this.dragging) return;
    const p = this.h.pointAt(e, true);
    if (!p) return;
    this.dragPending = p;
    // Agrupa por quadro: mouses de 1000 Hz não inundam o canal.
    if (!this.dragRaf) this.dragRaf = requestAnimationFrame(this.flushDrag);
  };

  private flushDrag = () => {
    this.dragRaf = 0;
    const p = this.dragPending;
    this.dragPending = null;
    if (p && this.dragging) this.send(Action.MOVE, POINTER_MOUSE, p.x, p.y);
  };

  private onWheel = (e: WheelEvent) => {
    if (this.locked()) {
      e.preventDefault();
      if (this.h.keysSuspended() || e.deltaY === 0) return;
      const bind = wheelBind(e.deltaY < 0 ? "up" : "down");
      for (const b of this.h.getLayout().buttons) if (b.bind === bind) this.tap(b);
      return;
    }
    if (this.h.mouseSuspended()) return;
    const at = this.h.pointAt(e, false);
    if (!at) return;
    e.preventDefault();
    if (this.dragging) return;
    if (this.swipe) {
      // Um swipe por vez; os dentes que chegam no meio viram o próximo (somados).
      const q = this.wheelQueue;
      this.wheelQueue = { at, dx: (q?.dx ?? 0) + e.deltaX, dy: (q?.dy ?? 0) + e.deltaY, mode: e.deltaMode };
      return;
    }
    this.startSwipe(at, e.deltaX, e.deltaY, e.deltaMode);
  };

  private startSwipe(at: Point, dx: number, dy: number, mode: number) {
    const pts = wheelSwipe(at, dx, dy, mode);
    if (pts.length < 2) return;
    this.send(Action.DOWN, POINTER_MOUSE, pts[0].x, pts[0].y);
    this.swipe = { pts, i: 1, timer: null };
    this.stepSwipe();
  }

  private stepSwipe = () => {
    const s = this.swipe;
    if (!s) return;
    if (s.i < s.pts.length) {
      const p = s.pts[s.i++];
      this.send(Action.MOVE, POINTER_MOUSE, p.x, p.y);
      s.timer = setTimeout(this.stepSwipe, STEP_MS);
      return;
    }
    this.send(Action.UP, POINTER_MOUSE);
    this.swipe = null;
    const q = this.wheelQueue;
    this.wheelQueue = null;
    if (q) s.timer = setTimeout(() => !this.swipe && !this.dragging && this.startSwipe(q.at, q.dx, q.dy, q.mode), STEP_MS * 2);
  };

  private cancelSwipe() {
    const s = this.swipe;
    if (!s) return;
    if (s.timer) clearTimeout(s.timer);
    this.swipe = null;
    this.wheelQueue = null;
    this.send(Action.UP, POINTER_MOUSE);
  }

  /** Agrupa deltas do mouse por frame para não inundar o canal (mouses 1000Hz). */
  private flushLook = () => {
    this.raf = 0;
    const { look } = this.h.getLayout();
    if (this.lookDx || this.lookDy) {
      const k = 0.001;
      this.send(
        Action.LOOK,
        POINTER_LOOK,
        look.x,
        look.y,
        this.lookDx * k * look.sensX,
        this.lookDy * k * look.sensY * (look.invertY ? -1 : 1)
      );
      this.lookDx = this.lookDy = 0;
    }
  };

  // ---------------------------------------------------------------- botões

  /** Aperto de uma tecla/botão do mouse atribuído a `b`. Devolve true se tratou. */
  private pressBind(b: ButtonControl): boolean {
    if (!b.pointer) return false;
    if (b.mode === "tap" || b.bind?.startsWith("wheel:")) {
      this.tap(b);
      return true;
    }
    if (b.mode === "toggle") {
      if (this.active.has(b.id)) this.release(b.id);
      else this.press(b);
      return true;
    }
    if (!this.active.has(b.id)) this.press(b);
    return true;
  }

  /** Soltar a tecla: só "segurar" levanta o dedo (alternar/toque rápido ignoram). */
  private releaseHold(b: ButtonControl) {
    if (b.mode === "hold") this.release(b.id);
  }

  private tap(b: ButtonControl) {
    if (!b.pointer || this.active.has(b.id)) return;
    this.press(b);
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.release(b.id);
    }, TAP_MS);
    this.timers.add(t);
  }

  private press(b: ButtonControl) {
    this.active.set(b.id, b.pointer);
    this.send(Action.DOWN, b.pointer, b.x, b.y);
  }

  private release(id: string) {
    const pointer = this.active.get(id);
    if (pointer === undefined) return;
    this.active.delete(id);
    this.send(Action.UP, pointer);
  }

  // ---------------------------------------------------------------- joystick

  private updateJoystick() {
    const { joystick: j } = this.h.getLayout();
    let vx = (this.down.has(j.right) ? 1 : 0) - (this.down.has(j.left) ? 1 : 0);
    let vy = (this.down.has(j.down) ? 1 : 0) - (this.down.has(j.up) ? 1 : 0);
    if (vx === 0 && vy === 0) {
      if (this.joyActive) {
        this.joyActive = false;
        this.stopJoyRepeat();
        this.send(Action.UP, POINTER_JOYSTICK);
      }
      return;
    }
    const len = Math.hypot(vx, vy);
    vx /= len;
    vy /= len;
    const off = joystickOffset(vx, vy, j.radius, this.h.getAspect());
    const x = clamp01(j.x + off.dx);
    const y = clamp01(j.y + off.dy);
    if (!this.joyActive) {
      this.joyActive = true;
      // Encosta no centro e arrasta, como um joystick virtual real.
      this.send(Action.DOWN, POINTER_JOYSTICK, j.x, j.y);
    }
    this.joyPos = { x, y };
    this.send(Action.MOVE, POINTER_JOYSTICK, x, y);
    // MOVE repetido é inofensivo no celular (mesma posição); MOVE depois do UP é ignorado lá.
    if (!this.joyTimer)
      this.joyTimer = setInterval(() => {
        if (this.joyActive) this.send(Action.MOVE, POINTER_JOYSTICK, this.joyPos.x, this.joyPos.y);
      }, 100);
  }

  private stopJoyRepeat() {
    if (this.joyTimer) clearInterval(this.joyTimer);
    this.joyTimer = null;
  }
}
