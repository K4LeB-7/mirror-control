// Testes dos módulos puros da UI (perfis, geometria, modos do mouse, roda). Rodar: `npm run test:ui`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LANDSCAPE,
  DEFAULT_PORTRAIT,
  MAX_BUTTONS,
  bindLabel,
  controlBoxes,
  fitContain,
  joystickOffset,
  orientationFor,
  overlappingControls,
  toNormalized,
} from "../lib/layout.ts";
import {
  DEFAULT_SETTINGS,
  LEGACY_KEY,
  STORE_KEY,
  SETTINGS_KEY,
  activeProfile,
  addButton,
  createProfile,
  deleteProfile,
  duplicateProfile,
  exportProfile,
  findConflicts,
  importProfile,
  loadSettings,
  loadStore,
  removeButton,
  renameProfile,
  reservedBinds,
  saveStore,
  updateLayout,
  removeControl,
  restoreControl,
  clearLayout,
} from "../lib/profiles.ts";
import { controlCount } from "../lib/layout.ts";
import type { ModeEvent, ModeState } from "../lib/mouseModes.ts";
import { INITIAL_MODE, isEditableTarget, nextMode, wheelPixels, wheelSwipe, WHEEL } from "../lib/mouseModes.ts";

const mem = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

// Layout gravado pelo site 0.2.0 (formato v1), com um botão extra e o "Agachar" apagado.
const LEGACY = {
  joystick: { x: 0.2, y: 0.7, radius: 0.18, up: "KeyW", down: "KeyS", left: "KeyA", right: "KeyD" },
  look: { x: 0.65, y: 0.5, sensitivity: 1.5 },
  buttons: [
    { id: "fire", label: "Atirar", mouse: 0, x: 0.88, y: 0.62 },
    { id: "aim", label: "Mirar", mouse: 2, x: 0.8, y: 0.45 },
    { id: "jump", label: "Pular", key: "Space", x: 0.92, y: 0.8 },
    { id: "b123", label: "Granada", key: "KeyG", x: 0.5, y: 0.2 },
  ],
};

// ---------------------------------------------------------------- perfis

test("migração do formato antigo v1: vira o layout de PAISAGEM do perfil Padrão, sem perder nada", () => {
  const kv = mem({ [LEGACY_KEY]: JSON.stringify(LEGACY) });
  const s = loadStore(kv);
  assert.equal(s.profiles.length, 1);
  const p = activeProfile(s);
  assert.equal(p.name, "Padrão");
  const l = p.landscape;
  assert.equal(l.confirmed, true, "layout antigo conta como personalizado (mapeador não abre sozinho)");
  assert.deepEqual([l.joystick.x, l.joystick.y, l.joystick.radius], [0.2, 0.7, 0.18]);
  assert.ok(Math.abs(l.joystick.size - 0.4) < 1e-9, "círculo acompanha o raio antigo");
  assert.equal(l.look.sensX, 1.5);
  assert.equal(l.look.sensY, 1.5);
  assert.deepEqual(
    l.buttons.map((b) => [b.id, b.bind, b.pointer, b.mode]),
    [
      ["fire", "mouse:0", 1, "hold"],
      ["aim", "mouse:2", 2, "hold"],
      ["jump", "key:Space", 3, "hold"],
      ["b123", "key:KeyG", 4, "hold"],
    ],
    "ponteiros = índice + 1 (como o site antigo enviava)"
  );
  // retrato começa no padrão novo e ainda não confirmado (mapeador abre na 1ª vez em retrato)
  assert.deepEqual(p.portrait.buttons.map((b) => b.id), DEFAULT_PORTRAIT.buttons.map((b) => b.id));
  assert.notEqual(p.portrait.confirmed, true);
  // a chave antiga não é apagada; salvar grava a v2 e recarregar lê a v2
  saveStore(kv, s);
  assert.ok(kv.m.has(LEGACY_KEY) && kv.m.has(STORE_KEY));
  assert.deepEqual(loadStore(kv), s);
});

test("armazenamento vazio/corrompido → perfil Padrão com os dois layouts padrão", () => {
  for (const kv of [mem(), mem({ [STORE_KEY]: "{oops" }), mem({ [STORE_KEY]: '{"profiles":[]}' }), null]) {
    const s = loadStore(kv);
    assert.equal(s.profiles.length, 1);
    assert.deepEqual(activeProfile(s).landscape.buttons, DEFAULT_LANDSCAPE.buttons);
    assert.deepEqual(activeProfile(s).portrait.buttons, DEFAULT_PORTRAIT.buttons);
  }
});

test("retrato vs paisagem: orientação pela proporção e layouts independentes", () => {
  assert.equal(orientationFor(640 / 288), "landscape");
  assert.equal(orientationFor(288 / 640), "portrait");
  assert.equal(orientationFor(1), "landscape");
  let s = loadStore(mem());
  s = updateLayout(s, "portrait", (l) => ({ ...l, joystick: { ...l.joystick, x: 0.33 }, confirmed: true }));
  assert.equal(activeProfile(s).portrait.joystick.x, 0.33);
  assert.equal(activeProfile(s).landscape.joystick.x, DEFAULT_LANDSCAPE.joystick.x);
  assert.equal(activeProfile(s).landscape.confirmed, undefined);
});

test("criar / duplicar / renomear / excluir perfis", () => {
  let s = loadStore(mem());
  s = updateLayout(s, "landscape", (l) => ({ ...l, joystick: { ...l.joystick, x: 0.3 } }));
  s = duplicateProfile(s);
  assert.equal(s.profiles.length, 2);
  const dup = activeProfile(s);
  assert.equal(dup.name, "Padrão (cópia)");
  assert.notEqual(dup.id, s.profiles[0].id);
  assert.equal(dup.landscape.joystick.x, 0.3);
  // cópia profunda: mexer na cópia não muda o original
  s = updateLayout(s, "landscape", (l) => ({ ...l, joystick: { ...l.joystick, x: 0.9 } }));
  assert.equal(s.profiles[0].landscape.joystick.x, 0.3);
  s = renameProfile(s, dup.id, "  FPS  ");
  assert.equal(activeProfile(s).name, "FPS");
  assert.equal(renameProfile(s, dup.id, "   "), s, "nome vazio é ignorado");
  s = createProfile(s, "FPS");
  assert.equal(activeProfile(s).name, "FPS (2)", "nome único");
  s = deleteProfile(s, s.activeId);
  assert.equal(s.profiles.length, 2);
  assert.ok(s.profiles.some((p) => p.id === s.activeId));
  s = deleteProfile(deleteProfile(s, s.profiles[0].id), s.profiles[1].id);
  assert.equal(s.profiles.length, 1, "o último perfil não é apagado");
});

test("exportar / importar (JSON novo, objeto cru e layout v1)", () => {
  let s = loadStore(mem());
  s = updateLayout(s, "portrait", (l) => addButton(l, 0.4, 0.3, "Granada").layout);
  const text = exportProfile(activeProfile(s));
  assert.ok(!/"id":\s*"default"/.test(text), "id do perfil não vai no arquivo");
  const s2 = importProfile(s, text);
  assert.equal(s2.profiles.length, 2);
  const imp = activeProfile(s2);
  assert.equal(imp.name, "Padrão (2)");
  assert.notEqual(imp.id, s.profiles[0].id);
  assert.deepEqual(imp.portrait.buttons, activeProfile(s).portrait.buttons);
  // layout v1 colado direto
  const s3 = importProfile(s, JSON.stringify(LEGACY));
  assert.equal(activeProfile(s3).landscape.buttons[3].bind, "key:KeyG");
  // lixo
  assert.throws(() => importProfile(s, "nada"), /JSON válido/);
  assert.throws(() => importProfile(s, '{"a":1}'), /não parece/);
  // valores absurdos são saneados
  const evil = importProfile(
    s,
    JSON.stringify({ landscape: { buttons: Array.from({ length: 20 }, (_, i) => ({ id: "x", x: 9, y: -3, size: 99, pointer: 1, bind: "key:Bad Key!" + i })) } })
  );
  const bl = activeProfile(evil).landscape.buttons;
  assert.equal(bl.length, MAX_BUTTONS);
  assert.equal(new Set(bl.map((b) => b.id)).size, MAX_BUTTONS, "ids únicos");
  assert.deepEqual(bl.map((b) => b.pointer).sort(), [1, 2, 3, 4, 5, 6, 7], "ponteiros únicos 1..7");
  assert.ok(bl.every((b) => b.x === 1 && b.y === 0 && b.size <= 0.35 && b.bind === undefined));
});

test("ponteiro estável: apagar um botão não muda o ponteiro dos outros; novo usa o menor livre; limite de 7", () => {
  let l = structuredClone(DEFAULT_LANDSCAPE);
  const before = Object.fromEntries(l.buttons.map((b) => [b.id, b.pointer]));
  l = removeButton(l, "aim"); // ponteiro 2
  for (const b of l.buttons) assert.equal(b.pointer, before[b.id]);
  const r = addButton(l, 0.5, 0.5);
  assert.equal(r.layout.buttons.find((b) => b.id === r.id)!.pointer, 2, "reaproveita o 2");
  l = r.layout;
  l = addButton(l, 0.1, 0.1).layout;
  l = addButton(l, 0.2, 0.1).layout;
  assert.equal(l.buttons.length, 7);
  assert.deepEqual(l.buttons.map((b) => b.pointer).sort(), [1, 2, 3, 4, 5, 6, 7]);
  const full = addButton(l, 0.3, 0.3);
  assert.equal(full.id, undefined);
  assert.equal(full.layout, l, "8º botão é recusado");
  assert.ok(l.buttons.every((b) => b.pointer !== 8 && b.pointer !== 9 && b.pointer !== 0));
});

test("conflitos de atalho (inclui F8 e Esc reservados)", () => {
  const l = structuredClone(DEFAULT_LANDSCAPE);
  assert.deepEqual(findConflicts(l, reservedBinds("F8")), [], "padrão sem conflitos");
  l.buttons[2].bind = "key:KeyW"; // Pular = W, igual ao joystick ↑
  l.buttons[3].bind = "key:F8";
  l.buttons[4].bind = "mouse:0"; // igual ao Atirar
  const c = findConflicts(l, reservedBinds("F8"));
  const byBind = Object.fromEntries(c.map((x) => [x.bind, x.owners]));
  assert.deepEqual(byBind["key:KeyW"], ["Joystick ↑", "Pular"]);
  assert.deepEqual(byBind["key:F8"], ["Agachar", "Travar/soltar mouse"]);
  assert.deepEqual(byBind["mouse:0"], ["Atirar", "Recarregar"]);
  assert.equal(c.length, 3);
  assert.equal(bindLabel("wheel:up"), "Roda ↑");
  assert.equal(bindLabel("key:Space"), "Espaço");
});

test("preferências: padrão e valores inválidos", () => {
  assert.deepEqual(loadSettings(mem()), DEFAULT_SETTINGS);
  assert.equal(DEFAULT_SETTINGS.toggleKey, "F8");
  assert.equal(DEFAULT_SETTINGS.keysInFree, true);
  const s = loadSettings(mem({ [SETTINGS_KEY]: JSON.stringify({ toggleKey: "Escape", opacity: 9, keysInFree: false }) }));
  assert.equal(s.toggleKey, "F8", "Esc não pode ser o atalho");
  assert.equal(s.opacity, 1);
  assert.equal(s.keysInFree, false);
});

// ---------------------------------------------------------------- geometria / escala

test("joystick é círculo em px em retrato e paisagem e escala com o vídeo", () => {
  for (const [w, h] of [[1280, 576], [576, 1280], [400, 900], [1000, 450]]) {
    for (const l of [DEFAULT_LANDSCAPE, DEFAULT_PORTRAIT]) {
      const joy = controlBoxes(l, w, h).find((b) => b.kind === "joy")!.rect;
      assert.equal(joy.width, joy.height, `${w}x${h}`);
      assert.ok(Math.abs(joy.width - l.joystick.size * Math.min(w, h)) < 1e-9);
      for (const b of controlBoxes(l, w, h)) assert.equal(b.rect.width, b.rect.height);
    }
  }
  const small = controlBoxes(DEFAULT_LANDSCAPE, 640, 288).find((b) => b.kind === "joy")!.rect.width;
  const big = controlBoxes(DEFAULT_LANDSCAPE, 1280, 576).find((b) => b.kind === "joy")!.rect.width;
  assert.ok(Math.abs(big / small - 2) < 1e-9, "dobra junto com o vídeo");
});

test("layouts padrão sem sobreposição e dentro da tela (16:9 a 21:9 e 9:16 a 9:21)", () => {
  const cases: [typeof DEFAULT_LANDSCAPE, number[]][] = [
    [DEFAULT_LANDSCAPE, [16 / 9, 2, 20 / 9, 640 / 288, 21 / 9]],
    [DEFAULT_PORTRAIT, [9 / 16, 9 / 19.5, 9 / 20, 288 / 640, 9 / 21]],
  ];
  for (const [l, aspects] of cases)
    for (const a of aspects)
      for (const H of [300, 720, 1080]) {
        const w = a >= 1 ? H * a : H;
        const h = a >= 1 ? H : H / a;
        assert.deepEqual(overlappingControls(l, w, h), [], `aspect ${a.toFixed(3)} ${w}x${h}`);
        for (const b of controlBoxes(l, w, h)) {
          assert.ok(b.rect.left >= -1 && b.rect.top >= -1, `${b.id} fora (esq/topo) ${a}`);
          assert.ok(b.rect.left + b.rect.width <= w + 1 && b.rect.top + b.rect.height <= h + 1, `${b.id} fora ${a}`);
        }
      }
});

test("deslocamento do joystick: raio em fração do lado menor", () => {
  const land = joystickOffset(1, 0, 0.16, 2);
  assert.ok(Math.abs(land.dx - 0.08) < 1e-9 && land.dy === 0, "paisagem: igual ao site antigo (radius/aspect)");
  const landY = joystickOffset(0, -1, 0.16, 2);
  assert.ok(Math.abs(landY.dy + 0.16) < 1e-9);
  const port = joystickOffset(1, 0, 0.16, 0.5);
  assert.ok(Math.abs(port.dx - 0.16) < 1e-9);
  const portY = joystickOffset(0, 1, 0.16, 0.5);
  assert.ok(Math.abs(portY.dy - 0.08) < 1e-9, "retrato: mesma distância em px nos dois eixos");
});

test("contain + letterbox: ponto da página → coordenada do vídeo", () => {
  // caixa 1000×500 com vídeo retrato 0.5 → conteúdo 250×500 centrado (faixas de 375 px)
  const r = fitContain(1000, 500, 0.5);
  assert.deepEqual(r, { left: 375, top: 0, width: 250, height: 500 });
  const c = { ...r, left: r.left + 10, top: r.top + 20 }; // caixa na página em (10,20)
  assert.deepEqual(toNormalized(c, 10 + 375 + 125, 20 + 250), { x: 0.5, y: 0.5 });
  assert.deepEqual(toNormalized(c, 10 + 375, 20), { x: 0, y: 0 });
  assert.equal(toNormalized(c, 10 + 100, 20 + 250), null, "faixa preta não vira toque");
  assert.deepEqual(toNormalized(c, 10 + 100, 20 + 600, true), { x: 0, y: 1 }, "arrasto saindo da imagem é limitado");
  assert.deepEqual(fitContain(1000, 500, 4), { left: 0, top: 125, width: 1000, height: 250 });
  // tolerância de 1 px (clientX/Y inteiros): a borda conta, 2 px fora não
  assert.deepEqual(toNormalized(c, 10 + 375 - 0.6, 20 + 250, false, 1), { x: 0, y: 0.5 });
  assert.equal(toNormalized(c, 10 + 375 - 2, 20 + 250, false, 1), null);
});

// ---------------------------------------------------------------- modos do mouse

test("máquina de estados livre/travado", () => {
  const run = (evs: ModeEvent[], s: ModeState = INITIAL_MODE) => {
    const effects: string[] = [];
    for (const e of evs) {
      const r = nextMode(s, e);
      s = r.state;
      effects.push(...r.effects.map((x) => `${e}:${x}`));
    }
    return { s, effects };
  };
  assert.deepEqual(INITIAL_MODE, { mode: "free", requesting: false }, "começa livre");
  // F8 pede a trava; só vira travado quando o navegador confirma
  let r = run(["toggle"]);
  assert.deepEqual(r.s, { mode: "free", requesting: true });
  assert.deepEqual(r.effects, ["toggle:requestLock"]);
  r = run(["toggle", "toggle"]);
  assert.deepEqual(r.effects, ["toggle:requestLock"], "F8 repetido não pede de novo");
  r = run(["toggle", "lockAcquired"]);
  assert.deepEqual(r.s, { mode: "locked", requesting: false });
  assert.deepEqual(r.effects, ["toggle:requestLock", "lockAcquired:releaseAll"]);
  // F8 de novo destrava
  r = run(["toggle", "lockAcquired", "toggle"]);
  assert.equal(r.s.mode, "free");
  assert.deepEqual(r.effects.slice(-2), ["toggle:exitLock", "toggle:releaseAll"]);
  // Esc (do navegador) destrava e NÃO trava de novo sozinho
  r = run(["toggle", "lockAcquired", "lockLost"]);
  assert.deepEqual(r.s, { mode: "free", requesting: false });
  assert.deepEqual(r.effects.slice(-1), ["lockLost:releaseAll"]);
  assert.ok(!r.effects.some((e) => e.startsWith("lockLost:requestLock")));
  r = run(["toggle", "lockAcquired", "escape"]);
  assert.equal(r.s.mode, "free");
  assert.deepEqual(r.effects.slice(-2), ["escape:exitLock", "escape:releaseAll"]);
  // recusa do navegador volta a permitir pedir
  r = run(["toggle", "lockError", "toggle"]);
  assert.deepEqual(r.effects, ["toggle:requestLock", "toggle:requestLock"]);
  // perder o foco solta os dedos sem mudar o modo
  r = run(["blur"]);
  assert.deepEqual(r, { s: INITIAL_MODE, effects: ["blur:releaseAll"] });
  // lockLost no modo livre não manda RELEASE_ALL à toa
  assert.deepEqual(run(["lockLost"]).effects, []);
});

test("roda do mouse → swipe curto (direção, distância, bordas, sem fling)", () => {
  const down = wheelSwipe({ x: 0.5, y: 0.5 }, 0, 100);
  assert.equal(down.length, WHEEL.steps + 1 + WHEEL.hold);
  assert.deepEqual(down[0], { x: 0.5, y: 0.5 });
  const end = down[down.length - 1];
  assert.ok(Math.abs(end.y - (0.5 - WHEEL.perNotch)) < 1e-9, "rolar para baixo = dedo sobe");
  assert.ok(down.every((p) => p.x === 0.5));
  assert.deepEqual(down[down.length - 1], down[down.length - 2], "termina parado (sem fling)");
  for (let i = 1; i < WHEEL.steps; i++) assert.ok(down[i].y <= down[i - 1].y, "monotônico");
  const up = wheelSwipe({ x: 0.3, y: 0.5 }, 0, -100);
  assert.ok(up[up.length - 1].y > 0.5, "rolar para cima = dedo desce");
  // perto da borda: desloca o início para o swipe caber
  const edge = wheelSwipe({ x: 0.5, y: 0.08 }, 0, 100);
  assert.ok(edge.every((p) => p.y >= WHEEL.edge - 1e-9 && p.y <= 1 - WHEEL.edge + 1e-9));
  assert.ok(edge[0].y > edge[edge.length - 1].y);
  // distância proporcional, com limites
  const big = wheelSwipe({ x: 0.5, y: 0.9 }, 0, 1000);
  assert.ok(Math.abs(big[0].y - big[big.length - 1].y - WHEEL.max) < 1e-9);
  const tiny = wheelSwipe({ x: 0.5, y: 0.5 }, 0, 4);
  assert.ok(Math.abs(tiny[0].y - tiny[tiny.length - 1].y - WHEEL.min) < 1e-9);
  // horizontal e unidades (linhas)
  const h = wheelSwipe({ x: 0.5, y: 0.5 }, 100, 3);
  assert.ok(h.every((p) => p.y === 0.5) && h[h.length - 1].x < 0.5);
  assert.equal(wheelPixels(3, 1), 120);
  assert.deepEqual(wheelSwipe({ x: 0.5, y: 0.5 }, 0, 0), []);
});

test("campo de texto em foco não vira toque", () => {
  assert.equal(isEditableTarget({ tagName: "INPUT", type: "text" } as unknown as EventTarget), true);
  assert.equal(isEditableTarget({ tagName: "INPUT", type: "checkbox" } as unknown as EventTarget), false);
  assert.equal(isEditableTarget({ tagName: "TEXTAREA" } as unknown as EventTarget), true);
  assert.equal(isEditableTarget({ tagName: "SELECT" } as unknown as EventTarget), true);
  assert.equal(isEditableTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget), true);
  assert.equal(isEditableTarget({ tagName: "CANVAS" } as unknown as EventTarget), false);
  assert.equal(isEditableTarget(null), false);
});

// ---------------------------------------------------------------- excluir controles pré-definidos (0.3.1)

test("perfil v2 salvo pela 0.3.0 (sem 'enabled') migra com joystick e câmera habilitados, sem perder nada", () => {
  const old = { version: 2, activeId: "x", profiles: [{ id: "x", name: "Meu", landscape: { ...structuredClone(DEFAULT_LANDSCAPE), confirmed: true }, portrait: structuredClone(DEFAULT_PORTRAIT) }] };
  for (const l of [old.profiles[0].landscape, old.profiles[0].portrait]) {
    delete (l.joystick as { enabled?: boolean }).enabled;
    delete (l.look as { enabled?: boolean }).enabled;
  }
  old.profiles[0].landscape.joystick.x = 0.3;
  const s = loadStore(mem({ [STORE_KEY]: JSON.stringify(old) }));
  const p = activeProfile(s);
  assert.equal(p.name, "Meu");
  assert.equal(p.landscape.joystick.enabled, true);
  assert.equal(p.landscape.look.enabled, true);
  assert.equal(p.landscape.joystick.x, 0.3);
  assert.equal(p.landscape.confirmed, true);
  assert.deepEqual(p.landscape.buttons, DEFAULT_LANDSCAPE.buttons);
});

test("todo controle é removível (botões padrão, joystick, câmera) e nada reaparece ao recarregar", () => {
  let s = loadStore(mem());
  for (const id of ["fire", "aim", "jump", "joystick", "look"]) s = updateLayout(s, "landscape", (l) => removeControl(l, id));
  const l = activeProfile(s).landscape;
  assert.equal(l.joystick.enabled, false);
  assert.equal(l.look.enabled, false);
  assert.deepEqual(l.buttons.map((b) => b.id), ["crouch", "reload"]);
  assert.equal(l.joystick.up, "KeyW", "joystick removido guarda as teclas para adicionar de volta");
  assert.deepEqual(controlBoxes(l, 1000, 450).map((b) => b.id), ["crouch", "reload"], "removidos não são desenhados");
  // os botões que sobraram mantêm o ponteiro; um novo usa o menor livre
  assert.deepEqual(l.buttons.map((b) => b.pointer), [4, 5]);
  assert.equal(addButton(l, 0.5, 0.5).layout.buttons.at(-1)!.pointer, 1);
  const kv = mem();
  saveStore(kv, s);
  const again = activeProfile(loadStore(kv)).landscape;
  assert.equal(again.joystick.enabled, false);
  assert.equal(again.look.enabled, false);
  assert.deepEqual(again.buttons.map((b) => b.id), ["crouch", "reload"]);
  // removeControl de um id inexistente/duplo não muda nada
  assert.equal(removeControl(l, "joystick"), l);
  assert.equal(removeControl(l, "nada"), l);
});

test("limpar tudo → layout vazio persistido; restaurar padrão e '+ Joystick/+ Câmera' trazem de volta", () => {
  let s = updateLayout(loadStore(mem()), "portrait", (l) => ({ ...clearLayout(l), confirmed: true }));
  const empty = activeProfile(s).portrait;
  assert.equal(controlCount(empty), 0);
  assert.deepEqual(controlBoxes(empty, 450, 1000), []);
  assert.deepEqual(findConflicts(empty, reservedBinds("F8")), []);
  const kv = mem();
  saveStore(kv, s);
  const reloaded = loadStore(kv);
  assert.equal(controlCount(activeProfile(reloaded).portrait), 0, "o perfil fica sem nenhum controle depois de recarregar");
  assert.equal(controlCount(activeProfile(reloaded).landscape), 7, "a outra orientação não muda");
  s = updateLayout(reloaded, "portrait", (l) => restoreControl(restoreControl(l, "joystick"), "look"));
  assert.equal(controlCount(activeProfile(s).portrait), 2);
  assert.equal(activeProfile(s).portrait.joystick.x, DEFAULT_PORTRAIT.joystick.x);
});

test("joystick removido não conta nos conflitos de atalho; exportar/importar mantém os removidos", () => {
  const l = removeControl(structuredClone(DEFAULT_LANDSCAPE), "joystick");
  const withW = { ...l, buttons: [...l.buttons, { ...l.buttons[0], id: "w", bind: "key:KeyW", pointer: 6 }] };
  assert.deepEqual(findConflicts(withW, []).map((c) => c.bind), [], "W livre com o joystick removido");
  assert.deepEqual(findConflicts({ ...withW, joystick: { ...withW.joystick, enabled: true } }, []).map((c) => c.bind), ["key:KeyW"]);
  let s = updateLayout(loadStore(mem()), "landscape", () => clearLayout(DEFAULT_LANDSCAPE));
  const text = exportProfile(activeProfile(s));
  s = importProfile(s, text);
  assert.equal(controlCount(activeProfile(s).landscape), 0);
  assert.equal(controlCount(activeProfile(s).portrait), 7);
});
