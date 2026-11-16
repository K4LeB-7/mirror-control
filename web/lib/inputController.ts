import { Action, POINTER_JOYSTICK, POINTER_LOOK, encodePacket } from "./protocol";
import { Layout } from "./layout";

/** O que o controlador precisa de uma sessão (WebRTC `RemoteSession` ou USB `UsbSession`). */
export type InputSink = { sendInput(buf: ArrayBuffer): void };

/** Converte teclado + mouse (Pointer Lock) em pacotes binários de toque. */
export class InputController {
  private down = new Set<string>(); // KeyboardEvent.code pressionados
  private activeButtons = new Map<string, number>(); // button.id -> pointer
  private joyActive = false;
  private lookDx = 0;
  private lookDy = 0;
  private raf = 0;
  private attached = false;
  /** O canal "input" não retransmite: reenvia a posição do joystick enquanto ele estiver ativo. */
  private joyTimer: ReturnType<typeof setInterval> | null = null;
  private joyPos = { x: 0, y: 0 };

  constructor(
    private session: InputSink,
    private getLayout: () => Layout,
    private getAspect: () => number, // largura/altura do vídeo
    private isLocked: () => boolean
  ) {}

  attach() {
    if (this.attached) return;
    this.attached = true;
    window.addEventListener("keydown", this.onKeyDown, true);
    window.addEventListener("keyup", this.onKeyUp, true);
    window.addEventListener("mousedown", this.onMouseDown, true);
    window.addEventListener("mouseup", this.onMouseUp, true);
    window.addEventListener("mousemove", this.onMouseMove, true);
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
    window.removeEventListener("blur", this.releaseAll);
    window.removeEventListener("contextmenu", this.onContext, true);
    cancelAnimationFrame(this.raf);
    this.releaseAll();
  }

  /** Chamado quando o Pointer Lock é perdido (ESC) ou o modo de edição abre. */
  releaseAll = () => {
    this.down.clear();
    this.activeButtons.clear();
    this.joyActive = false;
    this.stopJoyRepeat();
    this.lookDx = this.lookDy = 0;
    this.session.sendInput(encodePacket(Action.RELEASE_ALL, 0));
  };

  private onContext = (e: Event) => {
    if (this.isLocked()) e.preventDefault();
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.isLocked() || e.repeat) return;
    const layout = this.getLayout();
    let handled = false;
    const j = layout.joystick;
    if ([j.up, j.down, j.left, j.right].includes(e.code)) {
      this.down.add(e.code);
      this.updateJoystick();
      handled = true;
    }
    layout.buttons.forEach((b, i) => {
      if (b.key === e.code && !this.activeButtons.has(b.id)) {
        this.press(b.id, i + 1, b.x, b.y);
        handled = true;
      }
    });
    if (handled) e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    const layout = this.getLayout();
    const j = layout.joystick;
    if (this.down.delete(e.code)) this.updateJoystick();
    void j;
    layout.buttons.forEach((b) => {
      if (b.key === e.code) this.release(b.id);
    });
  };

  private onMouseDown = (e: MouseEvent) => {
    if (!this.isLocked()) return;
    const layout = this.getLayout();
    layout.buttons.forEach((b, i) => {
      if (b.mouse === e.button && !this.activeButtons.has(b.id)) this.press(b.id, i + 1, b.x, b.y);
    });
    e.preventDefault();
  };

  private onMouseUp = (e: MouseEvent) => {
    this.getLayout().buttons.forEach((b) => {
      if (b.mouse === e.button) this.release(b.id);
    });
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.isLocked()) return;
    this.lookDx += e.movementX;
    this.lookDy += e.movementY;
    if (!this.raf) this.raf = requestAnimationFrame(this.flushLook);
  };

  /** Agrupa deltas do mouse por frame para não inundar o canal (mouses 1000Hz). */
  private flushLook = () => {
    this.raf = 0;
    const { look } = this.getLayout();
    const k = 0.001 * look.sensitivity;
    if (this.lookDx || this.lookDy) {
      this.session.sendInput(
        encodePacket(Action.LOOK, POINTER_LOOK, look.x, look.y, this.lookDx * k, this.lookDy * k)
      );
      this.lookDx = this.lookDy = 0;
    }
  };

  private press(id: string, pointer: number, x: number, y: number) {
    this.activeButtons.set(id, pointer);
    this.session.sendInput(encodePacket(Action.DOWN, pointer, x, y));
  }

  private release(id: string) {
    const pointer = this.activeButtons.get(id);
    if (pointer === undefined) return;
    this.activeButtons.delete(id);
    this.session.sendInput(encodePacket(Action.UP, pointer));
  }

  private updateJoystick() {
    const { joystick: j } = this.getLayout();
    let vx = (this.down.has(j.right) ? 1 : 0) - (this.down.has(j.left) ? 1 : 0);
    let vy = (this.down.has(j.down) ? 1 : 0) - (this.down.has(j.up) ? 1 : 0);
    if (vx === 0 && vy === 0) {
      if (this.joyActive) {
        this.joyActive = false;
        this.stopJoyRepeat();
        this.session.sendInput(encodePacket(Action.UP, POINTER_JOYSTICK));
      }
      return;
    }
    const len = Math.hypot(vx, vy);
    vx /= len;
    vy /= len;
    // radius é fração da altura; converte o eixo X para fração da largura.
    const x = j.x + vx * j.radius * (1 / this.getAspect());
    const y = j.y + vy * j.radius;
    if (!this.joyActive) {
      this.joyActive = true;
      // Encosta no centro e arrasta, como um joystick virtual real.
      this.session.sendInput(encodePacket(Action.DOWN, POINTER_JOYSTICK, j.x, j.y));
    }
    this.joyPos = { x, y };
    this.session.sendInput(encodePacket(Action.MOVE, POINTER_JOYSTICK, x, y));
    // MOVE repetido é inofensivo no celular (mesma posição); MOVE depois do UP é ignorado lá.
    if (!this.joyTimer)
      this.joyTimer = setInterval(() => {
        if (this.joyActive)
          this.session.sendInput(encodePacket(Action.MOVE, POINTER_JOYSTICK, this.joyPos.x, this.joyPos.y));
      }, 100);
  }

  private stopJoyRepeat() {
    if (this.joyTimer) clearInterval(this.joyTimer);
    this.joyTimer = null;
  }
}
