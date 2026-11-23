// Testes do InputController (teclado/mouse → pacotes) com janela/timers falsos. Rodar: `npm test`.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { Action, INPUT_V2, POINTER_JOYSTICK, POINTER_LOOK, POINTER_MOUSE } from "../lib/protocol.ts";
import { DEFAULT_LANDSCAPE, type Layout } from "../lib/layout.ts";
import { DEFAULT_SETTINGS } from "../lib/profiles.ts";
import { removeControl, clearLayout } from "../lib/profiles.ts";
import type { MouseMode } from "../lib/mouseModes.ts";

// ---------------------------------------------------------------- ambiente de navegador mínimo

type Listener = (e: any) => void;
class FakeTarget {
  private l = new Map<string, Set<Listener>>();
  addEventListener(t: string, f: Listener) {
    if (!this.l.has(t)) this.l.set(t, new Set());
    this.l.get(t)!.add(f);
  }
  removeEventListener(t: string, f: Listener) {
    this.l.get(t)?.delete(f);
  }
  fire(t: string, props: Record<string, unknown> = {}) {
    const e: any = { type: t, isTrusted: true, defaultPrevented: false, target: null, buttons: 0, button: 0, repeat: false, ...props };
    e.preventDefault = () => (e.defaultPrevented = true);
    for (const f of [...(this.l.get(t) ?? [])]) f(e);
    return e;
  }
  count() {
    let n = 0;
    this.l.forEach((s) => (n += s.size));
    return n;
  }
}

const g = globalThis as any;
const win = new FakeTarget();
const doc = Object.assign(new FakeTarget(), { visibilityState: "visible" });
g.window = win;
g.document = doc;
let rafs = new Map<number, () => void>();
let rafId = 0;
g.requestAnimationFrame = (cb: () => void) => (rafs.set(++rafId, cb), rafId);
g.cancelAnimationFrame = (id: number) => rafs.delete(id);
const frame = () => {
  const list = [...rafs.values()];
  rafs = new Map();
  list.forEach((f) => f());
};

const { InputController, TAP_MS } = await import("../lib/inputController.ts");

type Pkt = { a: number; k: number; x: number; y: number; dx: number; dy: number; t: number };

function setup(opts: { layout?: Layout; mode?: MouseMode; congested?: () => boolean } = {}) {
  let now = 0;
  const sent: Pkt[] = [];
  const ctrls: unknown[] = [];
  const limits: number[] = [];
  const state = { layout: structuredClone(opts.layout ?? DEFAULT_LANDSCAPE) as Layout, mode: (opts.mode ?? "free") as MouseMode, editing: false };
  const sink = {
    sendInput(buf: ArrayBuffer) {
      const v = new DataView(buf); // o buffer é reaproveitado: copia já (como o RTCDataChannel.send)
      sent.push({ a: v.getUint8(0), k: v.getUint8(1), x: v.getFloat32(2, true), y: v.getFloat32(6, true), dx: v.getFloat32(10, true), dy: v.getFloat32(14, true), t: now });
    },
    sendCtrl(m: unknown) {
      ctrls.push(m);
    },
    congested: opts.congested,
  };
  const ic = new InputController(sink, {
    getLayout: () => state.layout,
    getAspect: () => 20 / 9,
    getMode: () => state.mode,
    getSettings: () => DEFAULT_SETTINGS,
    keysSuspended: () => state.editing,
    capturing: () => false,
    mouseSuspended: () => false,
    pointAt: (e: any) => (e.nx === undefined ? null : { x: e.nx, y: e.ny }),
    onToggleMode: () => {},
    onEscape: () => {},
    onTouchLimit: () => void limits.push(now),
    now: () => now,
  });
  ic.attach();
  const tick = (ms: number) => {
    now += ms;
    mock.timers.tick(ms);
  };
  return { ic, sent, ctrls, limits, state, tick, now: () => now, key: (t: "keydown" | "keyup", code: string, extra = {}) => win.fire(t, { code, ...extra }) };
}

const edges = (sent: Pkt[], k?: number) => sent.filter((p) => (p.a === Action.DOWN || p.a === Action.UP) && (k === undefined || p.k === k));
const seq = (sent: Pkt[], k?: number) => edges(sent, k).map((p) => `${p.a === Action.DOWN ? "D" : "U"}${p.k}`).join(" ");

/** Todo DOWN (geração) tem UP com a mesma geração, e o UP vem depois. */
function assertBalanced(sent: Pkt[]) {
  const open = new Map<number, number>();
  for (const p of sent) {
    if (p.a === Action.DOWN && !open.has(p.dx)) open.set(p.dx, p.k);
    if (p.a === Action.UP) {
      assert.ok(open.has(p.dx) || [...sent].some((q) => q.a === Action.DOWN && q.dx === p.dx), `UP sem DOWN gen=${p.dx}`);
      open.delete(p.dx);
    }
  }
  assert.deepEqual([...open.entries()], [], "DOWN sem UP");
}

test.beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  rafs = new Map();
});
test.afterEach(() => mock.timers.reset());

test("tecla com clique curto (keydown+keyup no mesmo quadro) → exatamente DOWN e UP do ponteiro certo", () => {
  const { ic, sent, key } = setup();
  key("keydown", "Space");
  key("keyup", "Space");
  assert.equal(seq(sent), "D1 U1", "botão sem ponteiro fixo: recebe o menor livre (1)");
  assert.ok(edges(sent)[0].dx >= 1, "DOWN leva a geração");
  assert.equal(edges(sent)[0].dx, edges(sent)[1].dx, "UP com a mesma geração");
  ic.detach();
});

test("mouse: clique curto no modo livre → DOWN(8)/UP(8); travado → DOWN(1)/UP(1)", () => {
  const a = setup();
  win.fire("mousedown", { button: 0, nx: 0.3, ny: 0.4 });
  win.fire("mouseup", { button: 0, nx: 0.3, ny: 0.4 });
  assert.equal(seq(a.sent), "D8 U8");
  const d = edges(a.sent)[0];
  assert.ok(Math.abs(d.x - 0.3) < 1e-6 && Math.abs(d.y - 0.4) < 1e-6);
  a.ic.detach();
  const b = setup({ mode: "locked" });
  win.fire("mousedown", { button: 0 });
  win.fire("mouseup", { button: 0 });
  assert.equal(seq(b.sent), "D1 U1");
  b.ic.detach();
});

test("toque rápido: UP depois de um tempo FIXO, não importa quando a tecla é solta", () => {
  const { ic, sent, state, key, tick } = setup();
  state.layout.buttons.find((b) => b.id === "jump")!.mode = "tap";
  key("keydown", "Space");
  tick(TAP_MS - 1);
  assert.equal(seq(sent), "D1");
  tick(1);
  assert.equal(seq(sent), "D1 U1");
  key("keyup", "Space"); // soltar depois não manda nada
  assert.equal(seq(sent), "D1 U1");
  // soltar ANTES do tempo não encurta (o 1 acabou de soltar: o pool prefere um ponteiro descansado, o 2)
  key("keydown", "Space");
  key("keyup", "Space");
  assert.equal(seq(sent), "D1 U1 D2");
  tick(TAP_MS);
  assert.equal(seq(sent), "D1 U1 D2 U2");
  ic.detach();
});

test("auto-repeat não gera DOWN extra; segurar alternar: 1º aperto DOWN, 2º UP", () => {
  const { ic, sent, state, key } = setup();
  key("keydown", "KeyC");
  key("keydown", "KeyC", { repeat: true });
  key("keydown", "KeyC", { repeat: true });
  key("keyup", "KeyC");
  assert.equal(seq(sent), "D1 U1");
  state.layout.buttons.find((b) => b.id === "crouch")!.mode = "toggle";
  key("keydown", "KeyC");
  key("keyup", "KeyC");
  assert.equal(seq(sent), "D1 U1 D2");
  assert.deepEqual(ic.activeButtons(), { crouch: 2 }, "alternar ligado ocupa um ponteiro");
  key("keydown", "KeyC");
  key("keyup", "KeyC");
  assert.equal(seq(sent), "D1 U1 D2 U2");
  assert.deepEqual(ic.activeButtons(), {}, "alternar desligado devolve o ponteiro");
  ic.detach();
});

test("blur / aba escondida / pagehide com teclas e mouse segurados → UP de cada dedo + RELEASE_ALL", () => {
  for (const ev of ["blur", "visibilitychange", "pagehide"]) {
    const { ic, sent, key } = setup();
    key("keydown", "KeyW");
    key("keydown", "Space");
    win.fire("mousedown", { button: 0, nx: 0.5, ny: 0.5 });
    assert.deepEqual(ic.heldPointers().sort(), [0, 1, 8]);
    if (ev === "visibilitychange") {
      doc.visibilityState = "hidden";
      doc.fire("visibilitychange");
      doc.visibilityState = "visible";
    } else win.fire(ev);
    assert.deepEqual(ic.heldPointers(), [], ev);
    assert.ok(sent.some((p) => p.a === Action.RELEASE_ALL), ev);
    assertBalanced(sent);
    // o keyup que chega depois não manda nada novo
    const n = sent.length;
    key("keyup", "KeyW");
    key("keyup", "Space");
    win.fire("mouseup", { button: 0 });
    assert.equal(edges(sent.slice(n)).length, 0, ev);
    ic.detach();
  }
});

test("menu de contexto do navegador (fora do vídeo) solta as teclas; sobre o vídeo é bloqueado", () => {
  const { ic, sent, key } = setup();
  key("keydown", "KeyW");
  const e1 = win.fire("contextmenu", { nx: 0.5, ny: 0.5 });
  assert.ok(e1.defaultPrevented);
  assert.deepEqual(ic.heldPointers(), [0]);
  win.fire("contextmenu", {});
  assert.deepEqual(ic.heldPointers(), []);
  assertBalanced(sent);
  ic.detach();
});

test("mouseup perdido (soltou fora da janela): o próximo movimento sem botão levanta o dedo", () => {
  const free = setup();
  win.fire("mousedown", { button: 0, nx: 0.2, ny: 0.2 });
  win.fire("mousemove", { buttons: 1, nx: 0.3, ny: 0.3 });
  assert.deepEqual(free.ic.heldPointers(), [8]);
  win.fire("mousemove", { buttons: 0, nx: 0.9, ny: 0.9 });
  assert.deepEqual(free.ic.heldPointers(), []);
  assertBalanced(free.sent);
  free.ic.detach();
  const locked = setup({ mode: "locked" });
  win.fire("mousedown", { button: 2 });
  win.fire("mousemove", { buttons: 2, movementX: 1, movementY: 0 });
  assert.deepEqual(locked.ic.heldPointers(), [1]);
  win.fire("mousemove", { buttons: 0, movementX: 1, movementY: 0 });
  assert.deepEqual(locked.ic.heldPointers(), []);
  assertBalanced(locked.sent);
  locked.ic.detach();
});

test("layout trocado com a tecla segurada: o UP vai para o dedo que foi pressionado", () => {
  const { ic, sent, state, key } = setup();
  key("keydown", "KeyC");
  key("keydown", "Space");
  state.layout = removeControl(state.layout, "jump"); // botão apagado no meio
  // um botão novo com a mesma tecla, no layout novo, não "herda" o dedo nem recebe UP
  state.layout = { ...state.layout, buttons: [...state.layout.buttons, { id: "novo", label: "Novo", bind: "key:Space", mode: "hold", x: 0.1, y: 0.1, size: 0.15 }] };
  key("keyup", "Space");
  assert.equal(seq(sent), "D1 D2 U2", "UP no ponteiro que o Pular recebeu no DOWN (2)");
  key("keyup", "KeyC");
  assert.equal(seq(sent), "D1 D2 U2 U1");
  ic.detach();
});

test("joystick removido: WASD não age; câmera removida: mouse travado não gera LOOK", () => {
  const { ic, sent, state, key } = setup({ mode: "locked" });
  state.layout = removeControl(removeControl(state.layout, "joystick"), "look");
  key("keydown", "KeyW");
  key("keyup", "KeyW");
  win.fire("mousemove", { movementX: 30, movementY: 5 });
  frame();
  assert.equal(sent.filter((p) => p.k === POINTER_JOYSTICK || p.k === POINTER_LOOK).length, 0);
  // layout vazio: nenhuma tecla/botão gera toque
  state.layout = clearLayout(state.layout);
  key("keydown", "Space");
  win.fire("mousedown", { button: 0 });
  win.fire("mouseup", { button: 0 });
  key("keyup", "Space");
  assert.equal(edges(sent).length, 0);
  ic.detach();
});

test("legado (app sem caps): sem cópias; joystick reenvia a posição a cada 100 ms", () => {
  const { ic, sent, key, tick } = setup();
  key("keydown", "KeyW");
  tick(1000);
  key("keyup", "KeyW");
  tick(500);
  assert.equal(seq(sent), "D0 U0");
  const moves = sent.filter((p) => p.a === Action.MOVE && p.k === 0);
  assert.ok(moves.length >= 10 && moves.length <= 12, `MOVEs=${moves.length}`);
  ic.detach();
});

test("entrada v2: CTRL input, DOWN/UP repetidos com a mesma geração e keepalive enquanto segura", () => {
  const { ic, sent, ctrls, key, tick } = setup();
  ic.setPhoneCaps(2);
  assert.deepEqual(ctrls, [{ type: "input", deadmanMs: INPUT_V2.deadmanMs }]);
  key("keydown", "KeyW");
  tick(3000); // anda 3 s
  const downs = sent.filter((p) => p.a === Action.DOWN && p.k === 0);
  assert.ok(downs.every((p) => p.dx === downs[0].dx), "mesma geração");
  // 1 + 2 cópias + keepalive a cada 100 ms
  assert.ok(downs.length >= 30 && downs.length <= 34, `DOWNs=${downs.length}`);
  const gap = Math.max(...downs.slice(3).map((p, i, a) => (i ? p.t - a[i - 1].t : 0)));
  assert.ok(gap <= INPUT_V2.keepaliveMs, `maior intervalo entre keepalives ${gap} ms`);
  const n = sent.length;
  key("keyup", "KeyW");
  tick(500);
  const after = sent.slice(n);
  assert.equal(after.filter((p) => p.a === Action.UP).length, 1 + INPUT_V2.redundancyMs.length);
  assert.equal(after.filter((p) => p.a === Action.DOWN).length, 0, "nenhum keepalive depois do UP");
  // pacotes por segundo segurando W (para o relatório): ~10 DOWN + ~10 MOVE
  const perSec = sent.filter((p) => p.t >= 1000 && p.t < 2000).length;
  assert.ok(perSec <= 22, `pacotes/s segurando W: ${perSec}`);
  ic.detach();
});

test("canal congestionado: LOOK espera e soma o movimento (nada se perde); DOWN/UP saem na hora", () => {
  let busy = true;
  const { ic, sent } = setup({ mode: "locked", congested: () => busy });
  for (let i = 0; i < 50; i++) win.fire("mousemove", { movementX: 2, movementY: 1 });
  frame();
  frame();
  assert.equal(sent.filter((p) => p.a === Action.LOOK).length, 0);
  assert.ok(ic.stats.deferred >= 2);
  win.fire("mousedown", { button: 0 });
  win.fire("mouseup", { button: 0 });
  assert.equal(seq(sent), "D1 U1", "bordas não esperam");
  busy = false;
  frame();
  const looks = sent.filter((p) => p.a === Action.LOOK);
  assert.equal(looks.length, 1);
  assert.ok(Math.abs(looks[0].dx - 100 * 0.001) < 1e-6 && Math.abs(looks[0].dy - 50 * 0.001) < 1e-6);
  ic.detach();
});

test("mouse de 1000 Hz: 1 LOOK por quadro (travado) e 1 MOVE por quadro (arrasto livre)", () => {
  const a = setup({ mode: "locked" });
  for (let f = 0; f < 60; f++) {
    for (let i = 0; i < 16; i++) win.fire("mousemove", { movementX: 1, movementY: 0 });
    frame();
  }
  assert.equal(a.sent.filter((p) => p.a === Action.LOOK).length, 60);
  a.ic.detach();
  const b = setup();
  win.fire("mousedown", { button: 0, nx: 0.1, ny: 0.1 });
  for (let f = 0; f < 60; f++) {
    for (let i = 0; i < 16; i++) win.fire("mousemove", { buttons: 1, nx: 0.1 + f * 0.01, ny: 0.1 });
    frame();
  }
  win.fire("mouseup", { button: 0, nx: 0.7, ny: 0.1 });
  assert.ok(b.sent.filter((p) => p.a === Action.MOVE && p.k === POINTER_MOUSE).length <= 61);
  b.ic.detach();
});

test("detach remove todos os listeners e solta tudo", () => {
  const before = win.count() + doc.count();
  const { ic, sent, key } = setup();
  key("keydown", "KeyD");
  ic.detach();
  assert.equal(win.count() + doc.count(), before);
  assertBalanced(sent);
});

test("fuzz: qualquer sequência de teclas/mouse/blur termina com todo DOWN tendo UP", () => {
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
  for (let round = 0; round < 200; round++) {
    const { ic, sent, state, key, tick } = setup({ mode: round % 2 ? "locked" : "free" });
    if (round % 3 === 0) ic.setPhoneCaps(2);
    state.layout.buttons[0].mode = (["hold", "toggle", "tap"] as const)[round % 3];
    const codes = ["KeyW", "KeyA", "KeyS", "KeyD", "Space", "KeyC", "KeyR", "KeyX"];
    for (let i = 0; i < 60; i++) {
      const r = rnd(12);
      if (r < 4) key("keydown", codes[rnd(codes.length)], { repeat: rnd(4) === 0 });
      else if (r < 7) key("keyup", codes[rnd(codes.length)]);
      else if (r === 7) win.fire("mousedown", { button: rnd(3), nx: 0.5, ny: 0.5 });
      else if (r === 8) win.fire("mouseup", { button: rnd(3), nx: 0.5, ny: 0.5 });
      else if (r === 9) win.fire("mousemove", { buttons: rnd(4), movementX: 3, movementY: 1, nx: 0.4, ny: 0.4 });
      else if (r === 10) win.fire("wheel", { deltaY: 100, deltaX: 0, deltaMode: 0, nx: 0.5, ny: 0.5 });
      else if (rnd(5) === 0) win.fire("blur");
      tick(rnd(40));
      if (rnd(3) === 0) frame();
    }
    ic.releaseAll();
    tick(1000);
    frame();
    assert.deepEqual(ic.heldPointers(), [], `rodada ${round}`);
    assertBalanced(sent);
    ic.detach();
  }
});

// ---------------------------------------------------------------- bug A: combinações de teclas (A + Espaço etc.)

/** Celular: aplica os pacotes com as regras de geração do TouchPlanner (v2) ou do app antigo (gen 0). */
class PhoneModel {
  held = new Map<number, { gen: number; x: number; y: number }>();
  lastGen = new Map<number, number>();
  ended = new Map<number, boolean>();
  apply(p: Pkt) {
    const k = p.k;
    if (p.a === Action.RELEASE_ALL) {
      for (const id of this.held.keys()) this.ended.set(id, true);
      this.held.clear();
      return;
    }
    const gen = p.a === Action.DOWN || p.a === Action.UP ? p.dx : 0;
    const live = this.held.get(k);
    if (p.a === Action.DOWN) {
      if (gen > 0) {
        const last = this.lastGen.get(k) ?? 0;
        if (gen < last) return;
        if (gen === last) {
          if (this.ended.get(k)) return;
          if (live && live.gen === gen) return; // keepalive: NÃO reposiciona
        } else {
          this.lastGen.set(k, gen);
          this.ended.set(k, false);
        }
      } else if (live) return;
      this.held.set(k, { gen, x: p.x, y: p.y });
    } else if (p.a === Action.UP) {
      if (gen > 0) {
        if (gen < (this.lastGen.get(k) ?? 0)) return;
        this.lastGen.set(k, gen);
        this.ended.set(k, true);
      }
      this.held.delete(k);
    } else if (p.a === Action.MOVE && live) {
      live.x = p.x;
      live.y = p.y;
    }
  }
}

test("A + Espaço e combinações: o dedo do joystick nunca vai para a direita com A e o pulo nunca mexe nele (v2 e app antigo)", () => {
  const J = DEFAULT_LANDSCAPE.joystick;
  for (const v2 of [true, false]) {
    const { ic, sent, key, tick } = setup({ mode: "locked" });
    if (v2) ic.setPhoneCaps(2);
    const phone = new PhoneModel();
    const pressed = new Set<string>();
    let seen = 0;
    const label = v2 ? "v2" : "app antigo";
    /** Aplica os pacotes novos no celular e confere as invariantes depois de cada pacote. */
    const check = (what: string) => {
      for (; seen < sent.length; seen++) {
        const p = sent[seen];
        phone.apply(p);
        const vx = (pressed.has("KeyD") ? 1 : 0) - (pressed.has("KeyA") ? 1 : 0);
        if (p.k === POINTER_JOYSTICK && (p.a === Action.DOWN || p.a === Action.MOVE)) {
          if (vx < 0) assert.ok(p.x <= J.x + 1e-6, `${label} ${what}: pacote do joystick à direita com A: ${JSON.stringify(p)}`);
          if (vx > 0) assert.ok(p.x >= J.x - 1e-6, `${label} ${what}: pacote do joystick à esquerda com D: ${JSON.stringify(p)}`);
        }
        const j = phone.held.get(POINTER_JOYSTICK);
        if (j && vx < 0) assert.ok(j.x <= J.x + 1e-6, `${label} ${what}: celular com o joystick à direita (${j.x})`);
      }
    };
    const down = (code: string, extra = {}) => { pressed.add(code); key("keydown", code, extra); check(`keydown ${code}`); };
    const up = (code: string) => { pressed.delete(code); key("keyup", code); check(`keyup ${code}`); };
    const wait = (ms: number) => { for (let t = 0; t < ms; t += 10) { tick(Math.min(10, ms - t)); check(`+${t}ms`); } };
    const expectState = (what: string) => {
      const vx = (pressed.has("KeyD") ? 1 : 0) - (pressed.has("KeyA") ? 1 : 0);
      const vy = (pressed.has("KeyS") ? 1 : 0) - (pressed.has("KeyW") ? 1 : 0);
      const j = phone.held.get(POINTER_JOYSTICK);
      if (vx === 0 && vy === 0) assert.equal(j, undefined, `${label} ${what}: joystick deveria estar solto`);
      else {
        assert.ok(j, `${label} ${what}: joystick deveria estar pressionado`);
        assert.equal(Math.sign(Math.round((j!.x - J.x) * 1e4)), vx, `${label} ${what}: direção x`);
        assert.equal(Math.sign(Math.round((j!.y - J.y) * 1e4)), vy, `${label} ${what}: direção y`);
      }
      // botões (ponteiros 1..7, atribuídos no aperto): no celular, só o pulo, e no ponteiro que ele recebeu
      const btns = [...phone.held.keys()].filter((k) => k >= 1 && k <= 7);
      const jp = ic.activeButtons().jump;
      assert.deepEqual(btns, pressed.has("Space") ? [jp] : [], `${label} ${what}: pulo`);
    };

    // 1) A segurado + Espaço curto/longo/rapidíssimo, repetido
    down("KeyA"); wait(50); expectState("A");
    for (const hold of [0, 10, 40, 120, 300, 5]) {
      const before = sent.length;
      down("Space");
      const atDown = sent.slice(before);
      const jp = ic.activeButtons().jump;
      assert.ok(jp >= 1 && jp <= 7);
      assert.ok(atDown.every((p) => p.k === jp), `${label}: DOWN do pulo não gera pacote do joystick: ${JSON.stringify(atDown)}`);
      wait(hold);
      const b2 = sent.length;
      up("Space");
      assert.ok(sent.slice(b2).every((p) => p.k === jp), `${label}: UP do pulo não gera pacote do joystick`);
      wait(70); expectState(`A + Espaço ${hold} ms`);
    }
    // 2) A → D (rollover: D antes de soltar A), A+D juntos (centro = solta), D sozinho
    down("KeyD"); wait(30); expectState("A+D");
    up("KeyA"); wait(30); expectState("D");
    down("Space"); wait(30); up("Space"); wait(70); expectState("D + Espaço");
    down("KeyA"); wait(10); up("KeyD"); wait(30); expectState("D→A");
    // 3) diagonal W+A+Espaço, auto-repeat, Shift/Ctrl
    down("KeyW"); wait(30); expectState("W+A");
    down("Space"); wait(20);
    for (let i = 0; i < 10; i++) { key("keydown", "KeyA", { repeat: true }); key("keydown", "Space", { repeat: true }); wait(30); }
    expectState("W+A+Espaço com repetição automática");
    down("ShiftLeft"); down("Space", { shiftKey: true }); wait(30); expectState("Shift");
    up("Space"); down("ControlLeft"); wait(30); expectState("Ctrl"); up("ControlLeft"); up("ShiftLeft");
    up("KeyW"); wait(30); expectState("A");
    // 4) keepalive/redundância por 3 s com A segurado e pulos a cada 250 ms
    for (let i = 0; i < 12; i++) { down("Space"); wait(60); up("Space"); wait(190); }
    expectState("A após 3 s de pulos");
    // 5) keyup perdido: a janela perde o foco (Alt+Tab) com A segurado → solta tudo; o keyup que chega depois não age
    win.fire("blur"); pressed.clear(); wait(100); expectState("blur");
    key("keyup", "KeyA"); wait(100); expectState("keyup atrasado");
    // 6) gerações: cada toque novo tem geração maior; as cópias repetem a mesma
    if (v2) {
      const gens = sent.filter((p) => p.a === Action.DOWN).map((p) => p.dx);
      let max = 0;
      for (const gn of gens) { assert.ok(gn >= max || gens.includes(gn), "geração"); max = Math.max(max, gn); }
      const firstOf = new Map<number, number>();
      sent.forEach((p, i) => { if (p.a === Action.DOWN && !firstOf.has(p.dx)) firstOf.set(p.dx, i); });
      const order = [...firstOf.keys()];
      assert.deepEqual(order, [...order].sort((a, b) => a - b), "1º DOWN de cada geração sai em ordem crescente");
    }
    assertBalanced(sent);
    ic.detach();
  }
});

test("joystick: o MOVE sai na hora mesmo com o canal congestionado", () => {
  const { ic, sent, key } = setup({ mode: "locked", congested: () => true });
  ic.setPhoneCaps(2);
  key("keydown", "KeyA");
  key("keydown", "KeyW");
  const moves = sent.filter((p) => p.a === Action.MOVE && p.k === POINTER_JOYSTICK);
  assert.equal(moves.length, 2);
  assert.ok(moves[1].x < DEFAULT_LANDSCAPE.joystick.x && moves[1].y < DEFAULT_LANDSCAPE.joystick.y);
  ic.detach();
});

test("fuzz de combinações: o celular (regras de geração) termina igual às teclas e nunca vê o joystick do lado errado", () => {
  let seed = 99;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
  const J = DEFAULT_LANDSCAPE.joystick;
  for (let round = 0; round < 150; round++) {
    const { ic, sent, key, tick } = setup({ mode: "locked" });
    if (round % 2 === 0) ic.setPhoneCaps(2);
    const phone = new PhoneModel();
    const pressed = new Set<string>();
    let seen = 0;
    const codes = ["KeyW", "KeyA", "KeyS", "KeyD", "Space", "KeyC", "ShiftLeft"];
    for (let i = 0; i < 80; i++) {
      const c = codes[rnd(codes.length)];
      if (rnd(2)) { key("keydown", c, { repeat: pressed.has(c) }); pressed.add(c); } else { key("keyup", c); pressed.delete(c); }
      tick(rnd(4) === 0 ? 100 + rnd(300) : rnd(30));
      for (; seen < sent.length; seen++) phone.apply(sent[seen]);
      const vx = (pressed.has("KeyD") ? 1 : 0) - (pressed.has("KeyA") ? 1 : 0);
      const vy = (pressed.has("KeyS") ? 1 : 0) - (pressed.has("KeyW") ? 1 : 0);
      const j = phone.held.get(POINTER_JOYSTICK);
      if (vx === 0 && vy === 0) assert.equal(j, undefined, `rodada ${round}: joystick solto`);
      else {
        assert.ok(j, `rodada ${round}: joystick pressionado`);
        assert.equal(Math.sign(Math.round((j!.x - J.x) * 1e4)), vx, `rodada ${round} passo ${i}: direção x`);
        assert.equal(Math.sign(Math.round((j!.y - J.y) * 1e4)), vy, `rodada ${round} passo ${i}: direção y`);
      }
      const act = ic.activeButtons();
      assert.equal("jump" in act, pressed.has("Space"), `rodada ${round}: pulo`);
      assert.equal("crouch" in act, pressed.has("KeyC"), `rodada ${round}: agachar`);
      const btns = [...phone.held.keys()].filter((k) => k >= 1 && k <= 7).sort();
      assert.deepEqual(btns, Object.values(act).sort(), `rodada ${round}: celular com os mesmos dedos dos botões`);
    }
    ic.releaseAll();
    tick(500);
    for (; seen < sent.length; seen++) phone.apply(sent[seen]);
    assert.equal(phone.held.size, 0);
    assertBalanced(sent);
    ic.detach();
  }
});

// ---------------------------------------------------------------- 20 botões: pool de ponteiros 1..7 (site 0.3.3)

const { PointerPool, MAX_SIMULTANEOUS_BUTTONS, POINTER_REST_MS } = await import("../lib/pointerPool.ts");
const { MAX_BUTTONS } = await import("../lib/layout.ts");

/** Layout com `n` botões "segurar" (teclas Digit1..9, KeyE.., sem as do joystick), joystick e câmera opcionais. */
function bigLayout(n = MAX_BUTTONS, opts: { joystick?: boolean; look?: boolean; modes?: ("hold" | "toggle" | "tap")[] } = {}): Layout {
  const codes = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9", "Digit0", "KeyE", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "KeyM", "KeyN", "KeyB"];
  const l = structuredClone(DEFAULT_LANDSCAPE) as Layout;
  l.joystick.enabled = opts.joystick ?? true;
  l.look.enabled = opts.look ?? true;
  l.buttons = Array.from({ length: n }, (_, i) => ({
    id: `b${i + 1}`,
    label: `Botão ${i + 1}`,
    bind: i < codes.length ? `key:${codes[i]}` : undefined,
    mode: opts.modes ? opts.modes[i % opts.modes.length] : "hold",
    x: 0.3 + (i % 5) * 0.1,
    y: 0.2 + Math.floor(i / 5) * 0.15,
    size: 0.1,
  }));
  return l;
}

/**
 * Invariantes do fluxo de pacotes dos BOTÕES (ponteiros 1..7): cada geração (toque) usa um ponteiro só; todo DOWN tem
 * exatamente um UP no MESMO ponteiro (as cópias repetem a mesma geração); nenhum UP sem DOWN; nunca dois toques
 * abertos no mesmo ponteiro; no máximo 7 abertos.
 */
function assertButtonStream(sent: Pkt[], buttonPointers = [1, 2, 3, 4, 5, 6, 7]) {
  const genPointer = new Map<number, number>();
  const open = new Map<number, number>(); // ponteiro -> gen aberta
  const closed = new Set<number>();
  for (const p of sent) {
    if (p.a !== Action.DOWN && p.a !== Action.UP) continue;
    if (!buttonPointers.includes(p.k)) continue;
    const gen = p.dx;
    assert.ok(gen >= 1, "botão sem geração");
    const k0 = genPointer.get(gen);
    if (k0 === undefined) genPointer.set(gen, p.k);
    else assert.equal(p.k, k0, `geração ${gen} em dois ponteiros (${k0} e ${p.k})`);
    if (p.a === Action.DOWN) {
      if (closed.has(gen)) continue; // cópia atrasada de um toque já terminado (o celular ignora)
      const o = open.get(p.k);
      if (o === gen) continue; // cópia/keepalive
      assert.equal(o, undefined, `ponteiro ${p.k}: DOWN gen ${gen} com o toque gen ${o} ainda aberto`);
      open.set(p.k, gen);
      assert.ok(open.size <= MAX_SIMULTANEOUS_BUTTONS, "mais de 7 botões abertos");
    } else {
      if (closed.has(gen)) continue; // cópia do UP
      assert.equal(open.get(p.k), gen, `UP gen ${gen} no ponteiro ${p.k} sem DOWN aberto`);
      open.delete(p.k);
      closed.add(gen);
    }
  }
  assert.deepEqual([...open.entries()], [], "toque de botão sem UP");
  return { touches: closed.size };
}

test("pool: menor livre, esgota no 8º, devolve, reusa, nunca 0/8/9, descanso de 80 ms", () => {
  const pool = new PointerPool();
  assert.equal(MAX_SIMULTANEOUS_BUTTONS, 7);
  const got = Array.from({ length: 7 }, () => pool.acquire(0));
  assert.deepEqual(got, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(pool.acquire(0), null, "8º: sem ponteiro");
  assert.equal(pool.freeCount, 0);
  assert.equal(pool.release(3, 10), true);
  assert.equal(pool.release(3, 10), false, "soltar duas vezes não faz nada");
  for (const r of [0, 8, 9, 42]) assert.equal(pool.release(r, 10), false, `ponteiro ${r} não é do pool`);
  assert.equal(pool.acquire(11), 3, "só o 3 está livre: reusa mesmo sem descanso");
  pool.release(5, 100);
  pool.release(2, 100);
  assert.equal(pool.acquire(100 + POINTER_REST_MS), 2, "menor livre");
  assert.equal(pool.acquire(100 + POINTER_REST_MS), 5);
  pool.releaseAll(200);
  assert.deepEqual(pool.inUse(), []);
  // descanso: soltos agora há pouco ficam para depois, se houver outro livre
  const q = new PointerPool();
  assert.equal(q.acquire(0), 1);
  q.release(1, 0);
  assert.equal(q.acquire(10), 2, "o 1 acabou de soltar: prefere o 2");
  q.release(2, 10);
  assert.equal(q.acquire(POINTER_REST_MS), 1, "o 1 descansou");
  // 1000 operações aleatórias: nunca 0/8/9, nunca repetido em uso
  let seed = 3;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
  const r = new PointerPool();
  const mine = new Set<number>();
  for (let t = 0; t < 1000; t++) {
    if (rnd(2)) {
      const p = r.acquire(t);
      if (p === null) assert.equal(mine.size, 7);
      else {
        assert.ok(p >= 1 && p <= 7 && !mine.has(p), `ponteiro ${p}`);
        mine.add(p);
      }
    } else if (mine.size) {
      const p = [...mine][rnd(mine.size)];
      mine.delete(p);
      assert.equal(r.release(p, t), true);
    }
    assert.deepEqual(r.inUse(), [...mine].sort((a, b) => a - b));
  }
});

test("20 botões: 8 teclas ao mesmo tempo → 7 DOWN em 1..7, a 8ª é ignorada (aviso único), sem UP sem DOWN e sem disparo atrasado", () => {
  const { ic, sent, limits, key, tick } = setup({ layout: bigLayout(), mode: "locked" });
  ic.setPhoneCaps(2);
  const keys = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8"];
  for (const k of keys) key("keydown", k);
  const downs = edges(sent).filter((p) => p.a === Action.DOWN);
  assert.deepEqual(downs.map((p) => p.k), [1, 2, 3, 4, 5, 6, 7], "7 DOWN, ponteiros únicos 1..7");
  assert.equal(Object.keys(ic.activeButtons()).length, 7);
  assert.ok(!("b8" in ic.activeButtons()), "a 8ª tecla não apertou nada");
  assert.deepEqual(limits, [0], "um aviso");
  // insistir na 8ª (e numa 9ª) logo depois não repete o aviso
  key("keyup", "Digit8");
  key("keydown", "Digit8");
  key("keydown", "Digit9");
  tick(500);
  assert.equal(limits.length, 1, "aviso não repetitivo");
  assert.equal(ic.stats.limitHits, 3);
  // solta a 3ª: o ponteiro 3 volta ao pool, mas a 8ª/9ª (ainda seguradas) NÃO são disparadas depois
  const n = sent.length;
  key("keyup", "Digit3");
  tick(300);
  const after = edges(sent.slice(n));
  assert.equal(seq(after.filter((p) => p.a === Action.UP)), "U3 U3 U3", "só o UP (e as cópias) do 3");
  const oldGens = new Set(edges(sent.slice(0, n)).map((p) => p.dx));
  assert.ok(after.every((p) => oldGens.has(p.dx)), "nenhum toque novo (só keepalive dos 6 segurados)");
  assert.equal(Object.keys(ic.activeButtons()).length, 6);
  // soltar as teclas ignoradas não manda nada
  const m = sent.length;
  key("keyup", "Digit8");
  key("keyup", "Digit9");
  tick(100);
  assert.equal(edges(sent.slice(m)).filter((p) => p.a === Action.UP).length, 0, "nenhum UP sem DOWN");
  // agora uma tecla nova pega o 3 (menor livre)
  key("keydown", "Digit9");
  assert.equal(ic.activeButtons().b9, 3);
  for (const k of keys.concat("Digit9")) key("keyup", k);
  tick(500);
  assert.deepEqual(ic.activeButtons(), {});
  assert.deepEqual(ic.heldPointers(), []);
  assertButtonStream(sent);
  // depois de 4 s, um novo excesso avisa de novo
  for (const k of keys) key("keydown", k);
  tick(4000);
  for (const k of keys) key("keyup", k);
  for (const k of keys) key("keydown", k);
  assert.equal(limits.length, 2);
  ic.releaseAll();
  tick(500);
  assertButtonStream(sent);
  ic.detach();
});

test("toggle ligado ocupa um dos 7; blur/visibilidade/troca de layout devolvem todos os ponteiros", () => {
  const { ic, sent, state, key, tick } = setup({ layout: bigLayout(20, { modes: ["toggle"] }), mode: "locked" });
  ic.setPhoneCaps(2);
  for (const k of ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7"]) {
    key("keydown", k);
    key("keyup", k);
  }
  assert.equal(Object.keys(ic.activeButtons()).length, 7, "7 alternar ligados");
  key("keydown", "Digit8");
  key("keyup", "Digit8");
  assert.ok(!("b8" in ic.activeButtons()), "8º alternar não liga");
  // desliga o 2º: o 8º agora liga no ponteiro 2
  key("keydown", "Digit2");
  key("keyup", "Digit2");
  tick(100);
  key("keydown", "Digit8");
  key("keyup", "Digit8");
  assert.equal(ic.activeButtons().b8, 2);
  win.fire("blur");
  assert.deepEqual(ic.activeButtons(), {});
  // depois do blur, os 7 ponteiros estão livres de novo
  tick(100);
  for (const k of ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7"]) key("keydown", k);
  assert.deepEqual(Object.values(ic.activeButtons()).sort(), [1, 2, 3, 4, 5, 6, 7]);
  doc.visibilityState = "hidden";
  doc.fire("visibilitychange");
  doc.visibilityState = "visible";
  assert.deepEqual(ic.activeButtons(), {});
  // troca de layout com a tecla segurada (sem releaseAll): o UP vai para o ponteiro do DOWN
  state.layout = bigLayout(20, { modes: ["hold"] });
  tick(100);
  key("keydown", "Digit5");
  const p5 = ic.activeButtons().b5;
  state.layout = bigLayout(3);
  const n = sent.length;
  key("keyup", "Digit5");
  assert.deepEqual(edges(sent.slice(n)).map((p) => `${p.a === Action.UP ? "U" : "D"}${p.k}`), [`U${p5}`]);
  ic.releaseAll();
  tick(500);
  assertButtonStream(sent);
  ic.detach();
});

/** Celular com rede: cada pacote chega com atraso aleatório (fora de ordem). */
function deliverWithDelay(sent: Pkt[], phone: PhoneModel, delays: number[], now: number, from: { i: number }, pending: { at: number; p: Pkt }[]) {
  for (; from.i < sent.length; from.i++) pending.push({ at: sent[from.i].t + delays[from.i % delays.length], p: sent[from.i] });
  pending.sort((a, b) => a.at - b.at);
  while (pending.length && pending[0].at <= now) phone.apply(pending.shift()!.p);
}

test("reuso rápido do mesmo ponteiro (< 60 ms, com toque rápido): DOWN/UP atrasados ou repetidos do botão anterior não afetam o seguinte", () => {
  for (const second of ["hold", "tap"] as const) {
    for (const gapMs of [0, 1, 10, 30, 59]) {
      const layout = bigLayout(9, { modes: ["hold", "hold", "hold", "hold", "hold", "hold", "tap", "tap", second] });
      const { ic, sent, key, tick } = setup({ layout, mode: "locked" });
      ic.setPhoneCaps(2);
      const phone = new PhoneModel();
      let seen = 0;
      const sync = () => { for (; seen < sent.length; seen++) phone.apply(sent[seen]); };
      // 6 seguradas (1..6): só o 7 sobra para os outros
      for (const k of ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6"]) key("keydown", k);
      tick(10);
      key("keydown", "Digit7"); // toque rápido no 7
      assert.equal(ic.activeButtons().b7, 7);
      const genA = edges(sent).at(-1)!.dx;
      tick(TAP_MS); // termina; o 7 volta ao pool agora (cópias do UP em +20 e +60 ainda vão sair)
      sync();
      assert.equal(phone.held.has(7), false);
      tick(gapMs);
      key("keydown", "Digit9"); // reusa o 7 antes das cópias do botão anterior
      const b = ic.activeButtons().b9;
      assert.equal(b, 7, `reuso do 7 (gap ${gapMs} ms)`);
      const genB = edges(sent).at(-1)!.dx;
      assert.ok(genB > genA);
      // anda o relógio em passos de 1 ms aplicando os pacotes: o 7 do celular é SEMPRE o toque B enquanto ele dura
      const endB = second === "tap" ? TAP_MS : 400;
      for (let t = 0; t < endB - 1; t++) {
        tick(1);
        sync();
        assert.equal(phone.held.get(7)?.gen, genB, `${second} gap ${gapMs} t+${t}: o celular perdeu o toque B`);
      }
      if (second === "hold") key("keyup", "Digit9");
      tick(200);
      sync();
      assert.equal(phone.held.has(7), false, "B terminou");
      // sem o 8 e o 9 do mouse/câmera; nada em 0/8/9
      assert.ok(sent.every((p) => (p.a !== Action.DOWN && p.a !== Action.UP) || (p.k >= 1 && p.k <= 7)));
      ic.releaseAll();
      tick(200);
      sync();
      assert.equal(phone.held.size, 0);
      assertButtonStream(sent);
      ic.detach();
    }
  }
});

test("reuso com a rede embaralhando os pacotes (atrasos de 0 a 50 ms): o celular termina sem dedo preso e o toque novo vale", () => {
  let seed = 11;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
  for (let round = 0; round < 60; round++) {
    const { ic, sent, key, tick } = setup({ layout: bigLayout(20, { modes: ["tap", "hold"] }), mode: "locked" });
    ic.setPhoneCaps(2);
    const phone = new PhoneModel();
    const delays = Array.from({ length: 97 }, () => rnd(51));
    const from = { i: 0 };
    const pending: { at: number; p: Pkt }[] = [];
    let now = 0;
    const step = (ms: number) => { for (let t = 0; t < ms; t++) { tick(1); now++; deliverWithDelay(sent, phone, delays, now, from, pending); } };
    const codes = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9", "Digit0", "KeyE", "KeyF"];
    const pressed = new Set<string>();
    for (let i = 0; i < 80; i++) {
      const c = codes[rnd(codes.length)];
      if (pressed.has(c) && rnd(2)) { key("keyup", c); pressed.delete(c); } else if (!pressed.has(c)) { key("keydown", c); pressed.add(c); }
      step(rnd(25));
    }
    // segura um botão "segurar" depois de tudo e espera a rede assentar: ele tem de estar no celular
    for (const c of pressed) key("keyup", c);
    pressed.clear();
    step(150);
    key("keydown", "Digit2"); // b2 = segurar
    const p = ic.activeButtons().b2;
    const gen = edges(sent).at(-1)!.dx;
    step(150);
    assert.equal(phone.held.get(p)?.gen, gen, `rodada ${round}: toque novo no ponteiro ${p}`);
    key("keyup", "Digit2");
    step(200);
    assert.equal(phone.held.size, 0, `rodada ${round}: dedo preso no celular`);
    assertButtonStream(sent);
    ic.detach();
  }
});

test("fuzz com 20 botões (segurar/alternar/toque, teclas, mouse, roda, blur, aba, troca de modo e de layout): DOWN/UP pareados no mesmo ponteiro, nada de botão em 0/8/9", (t) => {
  let seed = 2024;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
  const codes = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9", "Digit0", "KeyE", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "KeyM", "KeyN", "KeyB", "KeyW", "KeyA"];
  let touches = 0;
  let limitHits = 0;
  for (let round = 0; round < 250; round++) {
    // metade das rodadas: só botões (sem joystick/câmera, mouse travado) → qualquer pacote em 0/8/9 seria de botão
    const onlyButtons = round % 2 === 0;
    const layout = bigLayout(MAX_BUTTONS, { joystick: !onlyButtons, look: !onlyButtons, modes: ["hold", "toggle", "tap", "hold"] });
    layout.buttons[17].bind = "mouse:0";
    layout.buttons[18].bind = "mouse:2";
    layout.buttons[19].bind = "wheel:up";
    const { ic, sent, state, key, tick } = setup({ layout, mode: onlyButtons ? "locked" : round % 4 === 1 ? "free" : "locked" });
    if (round % 3 !== 2) ic.setPhoneCaps(2);
    const phone = new PhoneModel();
    let seen = 0;
    for (let i = 0; i < 120; i++) {
      const r = rnd(20);
      if (r < 9) key("keydown", codes[rnd(codes.length)], { repeat: rnd(6) === 0 });
      else if (r < 14) key("keyup", codes[rnd(codes.length)]);
      else if (r === 14) win.fire("mousedown", { button: [0, 2][rnd(2)], nx: 0.5, ny: 0.5 });
      else if (r === 15) win.fire("mouseup", { button: [0, 2][rnd(2)], nx: 0.5, ny: 0.5 });
      else if (r === 16) win.fire("wheel", { deltaY: -100, deltaX: 0, deltaMode: 0, nx: 0.5, ny: 0.5 });
      else if (r === 17 && rnd(3) === 0) {
        const ev = rnd(4);
        if (ev === 0) win.fire("blur");
        else if (ev === 1) { doc.visibilityState = "hidden"; doc.fire("visibilitychange"); doc.visibilityState = "visible"; }
        else if (ev === 2 && !onlyButtons) { state.mode = state.mode === "locked" ? "free" : "locked"; ic.releaseAll(); } // troca de modo / perda do pointer lock
        else ic.releaseAll();
      } else if (r === 18) {
        // layout trocado com teclas seguradas (editor, outro perfil): botões somem/mudam de tecla
        const l2 = structuredClone(state.layout);
        l2.buttons = l2.buttons.filter(() => rnd(3) !== 0);
        state.layout = l2;
      } else win.fire("mousemove", { buttons: rnd(4), movementX: 2, movementY: 1, nx: 0.4, ny: 0.4 });
      tick(rnd(50));
      if (rnd(3) === 0) frame();
      for (; seen < sent.length; seen++) phone.apply(sent[seen]);
      // celular (entrega imediata) com os mesmos dedos de botão que o site
      const btns = [...phone.held.keys()].filter((k) => k >= 1 && k <= 7).sort();
      assert.deepEqual(btns, Object.values(ic.activeButtons()).sort(), `rodada ${round} passo ${i}`);
      assert.ok(btns.length <= 7);
    }
    ic.releaseAll();
    tick(1000);
    frame();
    for (; seen < sent.length; seen++) phone.apply(sent[seen]);
    assert.deepEqual(ic.heldPointers(), [], `rodada ${round}`);
    assert.deepEqual(ic.activeButtons(), {});
    assert.equal(phone.held.size, 0, `rodada ${round}: celular com dedo preso`);
    if (onlyButtons)
      assert.ok(
        sent.every((p) => p.a === Action.RELEASE_ALL || (p.k >= 1 && p.k <= 7)),
        `rodada ${round}: pacote de botão em 0/8/9`
      );
    touches += assertButtonStream(sent).touches;
    assertBalanced(sent);
    limitHits += ic.stats.limitHits;
    ic.detach();
  }
  t.diagnostic(`fuzz 20 botões: ${touches} toques de botão, ${limitHits} apertos acima do limite de 7`);
  assert.ok(touches > 2000, `toques de botão no fuzz: ${touches}`);
  assert.ok(limitHits > 0, "o fuzz chegou ao limite de 7 simultâneos");
});
