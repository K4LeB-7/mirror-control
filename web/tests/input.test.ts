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
  });
  ic.attach();
  const tick = (ms: number) => {
    now += ms;
    mock.timers.tick(ms);
  };
  return { ic, sent, ctrls, state, tick, key: (t: "keydown" | "keyup", code: string, extra = {}) => win.fire(t, { code, ...extra }) };
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
  assert.equal(seq(sent), "D3 U3");
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
  assert.equal(seq(sent), "D3");
  tick(1);
  assert.equal(seq(sent), "D3 U3");
  key("keyup", "Space"); // soltar depois não manda nada
  assert.equal(seq(sent), "D3 U3");
  // soltar ANTES do tempo não encurta
  key("keydown", "Space");
  key("keyup", "Space");
  assert.equal(seq(sent), "D3 U3 D3");
  tick(TAP_MS);
  assert.equal(seq(sent), "D3 U3 D3 U3");
  ic.detach();
});

test("auto-repeat não gera DOWN extra; segurar alternar: 1º aperto DOWN, 2º UP", () => {
  const { ic, sent, state, key } = setup();
  key("keydown", "KeyC");
  key("keydown", "KeyC", { repeat: true });
  key("keydown", "KeyC", { repeat: true });
  key("keyup", "KeyC");
  assert.equal(seq(sent), "D4 U4");
  state.layout.buttons.find((b) => b.id === "crouch")!.mode = "toggle";
  key("keydown", "KeyC");
  key("keyup", "KeyC");
  assert.equal(seq(sent), "D4 U4 D4");
  key("keydown", "KeyC");
  key("keyup", "KeyC");
  assert.equal(seq(sent), "D4 U4 D4 U4");
  ic.detach();
});

test("blur / aba escondida / pagehide com teclas e mouse segurados → UP de cada dedo + RELEASE_ALL", () => {
  for (const ev of ["blur", "visibilitychange", "pagehide"]) {
    const { ic, sent, key } = setup();
    key("keydown", "KeyW");
    key("keydown", "Space");
    win.fire("mousedown", { button: 0, nx: 0.5, ny: 0.5 });
    assert.deepEqual(ic.heldPointers().sort(), [0, 3, 8]);
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
  assert.deepEqual(locked.ic.heldPointers(), [2]);
  win.fire("mousemove", { buttons: 0, movementX: 1, movementY: 0 });
  assert.deepEqual(locked.ic.heldPointers(), []);
  assertBalanced(locked.sent);
  locked.ic.detach();
});

test("layout trocado com a tecla segurada: o UP vai para o dedo que foi pressionado", () => {
  const { ic, sent, state, key } = setup();
  key("keydown", "Space");
  state.layout = removeControl(state.layout, "jump"); // botão apagado no meio
  key("keyup", "Space");
  assert.equal(seq(sent), "D3 U3");
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
      assert.equal(phone.held.has(3), pressed.has("Space"), `${label} ${what}: pulo`);
    };

    // 1) A segurado + Espaço curto/longo/rapidíssimo, repetido
    down("KeyA"); wait(50); expectState("A");
    for (const hold of [0, 10, 40, 120, 300, 5]) {
      const before = sent.length;
      down("Space");
      const atDown = sent.slice(before);
      assert.ok(atDown.every((p) => p.k === 3), `${label}: DOWN do pulo não gera pacote do joystick: ${JSON.stringify(atDown)}`);
      wait(hold);
      const b2 = sent.length;
      up("Space");
      assert.ok(sent.slice(b2).every((p) => p.k === 3), `${label}: UP do pulo não gera pacote do joystick`);
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
      assert.equal(phone.held.has(3), pressed.has("Space"), `rodada ${round}: pulo`);
      assert.equal(phone.held.has(4), pressed.has("KeyC"), `rodada ${round}: agachar`);
    }
    ic.releaseAll();
    tick(500);
    for (; seen < sent.length; seen++) phone.apply(sent[seen]);
    assert.equal(phone.held.size, 0);
    assertBalanced(sent);
    ic.detach();
  }
});
