import { Action, CtrlMessage, INPUT_V2, POINTER_JOYSTICK, POINTER_LOOK, POINTER_MOUSE, encodePacket } from "./protocol.ts";
import { ButtonControl, ButtonMode, Layout, clamp01, joystickOffset, keyBind, mouseBind, wheelBind } from "./layout.ts";
import { MouseMode, Point, isEditableTarget, wheelSwipe } from "./mouseModes.ts";
import type { UiSettings } from "./profiles.ts";

/** O que o controlador precisa de uma sessão (WebRTC `RemoteSession` ou USB `UsbSession`). */
export type InputSink = {
  sendInput(buf: ArrayBuffer): void;
  sendCtrl?(msg: CtrlMessage): void;
  /** Canal congestionado: MOVE/LOOK esperam o próximo quadro (DOWN/UP/keepalive nunca esperam). */
  congested?(): boolean;
};

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

/** "Toque rápido": DOWN e, depois deste tempo FIXO, UP (não depende de quando a tecla é solta). */
export const TAP_MS = 60;
const STEP_MS = 16;
/** Bits de MouseEvent.buttons por MouseEvent.button (0 esquerdo, 1 meio, 2 direito). */
const BUTTON_BITS = [1, 4, 2];

type Active = { pointer: number; mode: ButtonMode; source: string };
/** Dedo pressionado: geração do DOWN, ponto do DOWN e posição atual (joystick/arrasto). */
type Held = { gen: number; x: number; y: number; mx: number; my: number };

/**
 * Converte teclado + mouse em pacotes de toque de 18 bytes.
 * Modo livre: mouse = dedo (ponteiro 8), roda = swipe, direito = Voltar. Modo travado: movimento = LOOK (9),
 * botões/roda = controles mapeados. Teclas mapeadas nos dois modos (no livre, se a opção estiver ligada).
 *
 * Garantias: todo DOWN tem um UP (soltar a tecla/botão, ou blur/aba escondida/menu de contexto/troca de modo/
 * detach → releaseAll); o UP vai para o ponteiro que foi pressionado, mesmo se o layout mudou no meio. Entrada v2
 * (celular avisa com "caps"): DOWN/UP levam a geração, são repetidos ([INPUT_V2.redundancyMs]) e dedos segurados
 * recebem keepalive; o celular solta sozinho um dedo sem keepalive (UP perdido no WebRTC nunca prende).
 */
export class InputController {
  private down = new Set<string>(); // KeyboardEvent.code pressionados (joystick)
  private active = new Map<string, Active>(); // id do botão -> dedo pressionado
  private timers = new Set<ReturnType<typeof setTimeout>>(); // toques rápidos e swipes
  private echoes = new Set<ReturnType<typeof setTimeout>>(); // cópias redundantes de DOWN/UP (v2)
  private held = new Map<number, Held>(); // ponteiro -> dedo pressionado
  private gen = 0;
  private v2 = false;
  private keepTimer: ReturnType<typeof setInterval> | null = null;
  private joyActive = false;
  private lookDx = 0;
  private lookDy = 0;
  private raf = 0;
  private attached = false;
  // Modo livre: arrasto do botão esquerdo e swipe da roda (ambos no ponteiro 8).
  private dragging = false;
  private dragPending: Point | null = null;
  private dragRaf = 0;
  private swipe: { pts: Point[]; i: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
  private wheelQueue: { at: Point; dx: number; dy: number; mode: number } | null = null;

  /** Contadores (diagnóstico/testes/medições). */
  readonly stats = { sent: 0, deferred: 0 };

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
    window.addEventListener("pagehide", this.releaseAll);
    window.addEventListener("contextmenu", this.onContext, true);
    window.addEventListener("pointercancel", this.onPointerCancel, true);
    document.addEventListener("visibilitychange", this.onVisibility);
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
    window.removeEventListener("pagehide", this.releaseAll);
    window.removeEventListener("contextmenu", this.onContext, true);
    window.removeEventListener("pointercancel", this.onPointerCancel, true);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.releaseAll();
    this.echoes.forEach(clearTimeout);
    this.echoes.clear();
  }

  /**
   * O celular anunciou a entrada v2 (`{"type":"caps","input":2}`, app 0.3.1+; a cada conexão). Liga o deadman lá e
   * a redundância/keepalive aqui. App antigo nunca manda caps: tudo continua como antes.
   */
  setPhoneCaps(input: number) {
    const v2 = input >= 2;
    this.v2 = v2;
    if (v2) this.session.sendCtrl?.({ type: "input", deadmanMs: INPUT_V2.deadmanMs });
    this.syncKeepalive();
  }

  get inputV2() {
    return this.v2;
  }

  /** Ponteiros pressionados agora (testes/diagnóstico). */
  heldPointers(): number[] {
    return [...this.held.keys()];
  }

  /** Solta todos os dedos (troca de modo, perda de foco, editor aberto, rotação…). */
  releaseAll = () => {
    this.down.clear();
    this.active.clear();
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.joyActive = false;
    this.lookDx = this.lookDy = 0;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.dragging = false;
    this.dragPending = null;
    if (this.dragRaf) cancelAnimationFrame(this.dragRaf);
    this.dragRaf = 0;
    this.swipe = null;
    this.wheelQueue = null;
    // UP com geração para cada dedo (idempotente e redundante no v2) + RELEASE_ALL: um pacote perdido não prende.
    for (const pointer of [...this.held.keys()]) this.lift(pointer);
    this.send(Action.RELEASE_ALL, 0);
    this.syncKeepalive();
  };

  // ---------------------------------------------------------------- envio

  private send(a: (typeof Action)[keyof typeof Action], k: number, x = 0, y = 0, dx = 0, dy = 0) {
    this.stats.sent++;
    this.session.sendInput(encodePacket(a, k, x, y, dx, dy));
  }

  /** DOWN/UP: geração no campo dx e, no v2, cópias atrasadas (o celular ignora repetições). */
  private edge(a: typeof Action.DOWN | typeof Action.UP, k: number, x: number, y: number, gen: number) {
    this.send(a, k, x, y, gen);
    if (!this.v2) return;
    for (const d of INPUT_V2.redundancyMs) {
      const t = setTimeout(() => {
        this.echoes.delete(t);
        this.send(a, k, x, y, gen);
      }, d);
      this.echoes.add(t);
    }
  }

  /** Encosta o dedo `pointer` em (x, y). Um ponteiro já pressionado é levantado antes (nunca DOWN sem UP). */
  private press(pointer: number, x: number, y: number) {
    if (this.held.has(pointer)) this.lift(pointer);
    const gen = ++this.gen;
    this.held.set(pointer, { gen, x, y, mx: x, my: y });
    this.edge(Action.DOWN, pointer, x, y, gen);
    this.syncKeepalive();
  }

  private lift(pointer: number) {
    const h = this.held.get(pointer);
    if (!h) return;
    this.held.delete(pointer);
    this.edge(Action.UP, pointer, 0, 0, h.gen);
    this.syncKeepalive();
  }

  private moveTo(pointer: number, x: number, y: number) {
    const h = this.held.get(pointer);
    if (!h) return;
    h.mx = x;
    h.my = y;
    this.send(Action.MOVE, pointer, x, y);
  }

  private congested() {
    return !!this.session.congested?.();
  }

  /**
   * Keepalive (v2): enquanto há dedo segurado, reenvia DOWN(gen) e a posição atual. Sem v2 (app antigo), só o
   * joystick tem a posição reenviada (o canal "input" não retransmite um MOVE perdido).
   */
  private syncKeepalive() {
    const need = this.v2 ? this.held.size > 0 : this.joyActive;
    if (need && !this.keepTimer) this.keepTimer = setInterval(this.keepalive, INPUT_V2.keepaliveMs);
    else if (!need && this.keepTimer) {
      clearInterval(this.keepTimer);
      this.keepTimer = null;
    }
  }

  private keepalive = () => {
    if (!this.v2) {
      const j = this.held.get(POINTER_JOYSTICK);
      if (this.joyActive && j) this.send(Action.MOVE, POINTER_JOYSTICK, j.mx, j.my);
      return;
    }
    this.held.forEach((h, pointer) => {
      this.send(Action.DOWN, pointer, h.x, h.y, h.gen);
      if (h.mx !== h.x || h.my !== h.y) this.send(Action.MOVE, pointer, h.mx, h.my);
    });
  };

  private locked() {
    return this.h.getMode() === "locked";
  }

  private onContext = (e: Event) => {
    if (this.locked() || this.h.pointAt(e as MouseEvent, false)) {
      e.preventDefault();
      return;
    }
    // O menu do navegador vai abrir e "engolir" o keyup/mouseup: nenhum dedo pode ficar preso.
    if (!e.defaultPrevented && (this.held.size || this.down.size)) this.releaseAll();
  };

  private onVisibility = () => {
    if (document.visibilityState === "hidden") this.releaseAll();
  };

  private onPointerCancel = (e: Event) => {
    if ((e as PointerEvent).pointerType === "mouse" || this.dragging) this.endDrag(null);
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
    if (j.enabled !== false && [j.up, j.down, j.left, j.right].includes(e.code)) {
      this.down.add(e.code);
      this.updateJoystick();
      handled = true;
    }
    const bind = keyBind(e.code);
    for (const b of layout.buttons) if (b.bind === bind) handled = this.pressBind(b, e.code) || handled;
    if (handled) e.preventDefault();
  };

  /** Sempre age (mesmo com o editor aberto/foco num campo): soltar nunca é ignorado. */
  private onKeyUp = (e: KeyboardEvent) => {
    if (this.down.delete(e.code)) this.updateJoystick();
    this.releaseSource(e.code);
  };

  private isMapped(code: string) {
    const l = this.h.getLayout();
    const j = l.joystick;
    return (j.enabled !== false && [j.up, j.down, j.left, j.right].includes(code)) || l.buttons.some((b) => b.bind === keyBind(code));
  }

  // ---------------------------------------------------------------- mouse

  private onMouseDown = (e: MouseEvent) => {
    if (this.locked()) {
      e.preventDefault();
      if (this.h.keysSuspended()) return;
      const bind = mouseBind(e.button);
      for (const b of this.h.getLayout().buttons) if (b.bind === bind) this.pressBind(b, bind);
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
      this.press(POINTER_MOUSE, p.x, p.y);
    } else if (e.button === 2) {
      e.preventDefault();
      this.session.sendCtrl?.({ type: "nav", action: "back" });
    } else {
      e.preventDefault(); // botão do meio: sem o "autoscroll" do navegador sobre o vídeo
    }
  };

  private onMouseUp = (e: MouseEvent) => {
    this.releaseSource(mouseBind(e.button));
    if (e.button === 0 && this.dragging) this.endDrag(this.h.pointAt(e, true));
  };

  private endDrag(p: Point | null) {
    if (!this.dragging) return;
    const last = p ?? this.dragPending;
    if (last) this.moveTo(POINTER_MOUSE, last.x, last.y);
    this.lift(POINTER_MOUSE);
    this.dragging = false;
    this.dragPending = null;
    if (this.dragRaf) cancelAnimationFrame(this.dragRaf);
    this.dragRaf = 0;
  }

  /** mouseup perdido (soltou fora da janela, menu, troca de foco): o próximo movimento mostra o botão solto. */
  private checkLostMouseUp(e: MouseEvent) {
    if (!e.isTrusted) return;
    if (this.dragging && !(e.buttons & 1)) this.endDrag(null);
    for (const [id, a] of this.active) {
      if (!a.source.startsWith("mouse:") || a.mode !== "hold") continue;
      const bit = BUTTON_BITS[Number(a.source.slice(6))] ?? 0;
      if (!(e.buttons & bit)) this.release(id);
    }
  }

  private onMouseMove = (e: MouseEvent) => {
    this.checkLostMouseUp(e);
    if (this.locked()) {
      if (this.h.getLayout().look.enabled === false) return; // câmera removida: o mouse travado não gera LOOK
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
    if (!p || !this.dragging) return;
    if (this.congested()) {
      this.stats.deferred++;
      this.dragRaf = requestAnimationFrame(this.flushDrag); // tenta no próximo quadro, com o ponto mais novo
      return;
    }
    this.dragPending = null;
    this.moveTo(POINTER_MOUSE, p.x, p.y);
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
    this.press(POINTER_MOUSE, pts[0].x, pts[0].y);
    this.swipe = { pts, i: 1, timer: null };
    this.stepSwipe();
  }

  private later(ms: number, f: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      f();
    }, ms);
    this.timers.add(t);
    return t;
  }

  private stepSwipe = () => {
    const s = this.swipe;
    if (!s) return;
    if (s.i < s.pts.length) {
      const p = s.pts[s.i++];
      this.moveTo(POINTER_MOUSE, p.x, p.y);
      s.timer = this.later(STEP_MS, this.stepSwipe);
      return;
    }
    this.lift(POINTER_MOUSE);
    this.swipe = null;
    const q = this.wheelQueue;
    this.wheelQueue = null;
    if (q) this.later(STEP_MS * 2, () => !this.swipe && !this.dragging && this.startSwipe(q.at, q.dx, q.dy, q.mode));
  };

  private cancelSwipe() {
    const s = this.swipe;
    if (!s) return;
    if (s.timer) {
      clearTimeout(s.timer);
      this.timers.delete(s.timer);
    }
    this.swipe = null;
    this.wheelQueue = null;
    this.lift(POINTER_MOUSE);
  }

  /** Agrupa deltas do mouse por frame para não inundar o canal (mouses 1000Hz). */
  private flushLook = () => {
    this.raf = 0;
    const { look } = this.h.getLayout();
    if (!(this.lookDx || this.lookDy) || look.enabled === false) {
      this.lookDx = this.lookDy = 0;
      return;
    }
    if (this.congested()) {
      // Canal engasgado: guarda o movimento e manda tudo junto no próximo quadro (nada se perde nem acumula fila).
      this.stats.deferred++;
      this.raf = requestAnimationFrame(this.flushLook);
      return;
    }
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
  };

  // ---------------------------------------------------------------- botões

  /** Aperto de uma tecla/botão do mouse (`source`) atribuído a `b`. Devolve true se tratou. */
  private pressBind(b: ButtonControl, source: string): boolean {
    if (!b.pointer) return false;
    if (b.mode === "tap" || b.bind?.startsWith("wheel:")) {
      this.tap(b);
      return true;
    }
    if (b.mode === "toggle") {
      if (this.active.has(b.id)) this.release(b.id);
      else this.pressButton(b, source);
      return true;
    }
    if (!this.active.has(b.id)) this.pressButton(b, source);
    return true;
  }

  /** Soltou a tecla/botão `source`: levanta os botões "segurar" que ela apertou (mesmo se o layout mudou). */
  private releaseSource(source: string) {
    for (const [id, a] of this.active) if (a.source === source && a.mode === "hold") this.release(id);
  }

  /** Toque rápido: DOWN agora e UP depois de TAP_MS fixos, não importa quando a tecla for solta. */
  private tap(b: ButtonControl) {
    if (!b.pointer || this.active.has(b.id)) return;
    this.pressButton(b, "tap");
    this.later(TAP_MS, () => this.release(b.id));
  }

  private pressButton(b: ButtonControl, source: string) {
    this.active.set(b.id, { pointer: b.pointer, mode: b.mode === "toggle" ? "toggle" : b.mode === "hold" && source !== "tap" ? "hold" : "tap", source });
    this.press(b.pointer, b.x, b.y);
  }

  private release(id: string) {
    const a = this.active.get(id);
    if (!a) return;
    this.active.delete(id);
    // Outro controle pode estar usando o mesmo dedo agora (layout trocado): só levanta se ainda é este.
    if (![...this.active.values()].some((x) => x.pointer === a.pointer)) this.lift(a.pointer);
  }

  // ---------------------------------------------------------------- joystick

  private updateJoystick() {
    const { joystick: j } = this.h.getLayout();
    let vx = (this.down.has(j.right) ? 1 : 0) - (this.down.has(j.left) ? 1 : 0);
    let vy = (this.down.has(j.down) ? 1 : 0) - (this.down.has(j.up) ? 1 : 0);
    if ((vx === 0 && vy === 0) || j.enabled === false) {
      if (this.joyActive) {
        this.joyActive = false;
        this.lift(POINTER_JOYSTICK);
        this.syncKeepalive();
      }
      return;
    }
    const len = Math.hypot(vx, vy);
    vx /= len;
    vy /= len;
    const off = joystickOffset(vx, vy, j.radius, this.h.getAspect());
    const x = clamp01(j.x + off.dx);
    const y = clamp01(j.y + off.dy);
    if (!this.joyActive || !this.held.has(POINTER_JOYSTICK)) {
      this.joyActive = true;
      // Encosta no centro e arrasta, como um joystick virtual real.
      this.press(POINTER_JOYSTICK, j.x, j.y);
    }
    // MOVE só quando a direção muda (o keepalive reenvia a posição; MOVE repetido é inofensivo no celular).
    this.moveTo(POINTER_JOYSTICK, x, y);
    this.syncKeepalive();
  }
}
