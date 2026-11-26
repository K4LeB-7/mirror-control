// Escrita agrupada do modo USB (site 0.3.3): um write por vez; o que chega durante um write sai TODO junto no
// próximo; com o canal livre, o que o mesmo evento gera sai num write só (microtarefa); ordem estrita.
import { test } from "node:test";
import assert from "node:assert/strict";
import { UsbSession } from "../lib/usbSession.ts";
import { Action, encodePacket } from "../lib/protocol.ts";
import { FrameDecoder, FrameType, encodeText } from "../lib/usbWire.ts";

type Pending = { bytes: Uint8Array; resolve: () => void };

function fakeOpener(opts: { holdWrites: boolean }) {
  const writes: Pending[] = [];
  let push: ((c: Uint8Array | undefined) => void) | null = null;
  const inbox: (Uint8Array | undefined)[] = [];
  const channel = {
    read: () =>
      new Promise<Uint8Array | undefined>((r) => {
        if (inbox.length) r(inbox.shift());
        else push = r;
      }),
    write: (bytes: Uint8Array) =>
      new Promise<void>((resolve) => {
        writes.push({ bytes: bytes.slice(), resolve });
        if (!opts.holdWrites) resolve();
      }),
    close: () => push?.(undefined),
  };
  const deliver = (c: Uint8Array) => {
    if (push) {
      const p = push;
      push = null;
      p(c);
    } else inbox.push(c);
  };
  return {
    writes,
    deliver,
    opener: { open: async () => channel, dispose() {} },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const decodeAll = (ws: Pending[]) => {
  const d = new FrameDecoder();
  return ws.flatMap((w) => d.push(w.bytes));
};
const pkt = (a: number, k: number, x = 0) => encodePacket(a as never, k, x, 0, 0, 0);

async function connected(holdWrites: boolean) {
  const f = fakeOpener({ holdWrites });
  const s = new UsbSession(f.opener as never, "123456", { onState: () => {} });
  await tick();
  // HELLO já saiu; o celular aceita o PIN (INFO)
  f.deliver(encodeText(FrameType.INFO, JSON.stringify({ width: 640, height: 288, fps: 60, codec: "avc1.42C01F" })));
  await tick();
  assert.equal(s.inputReady, true);
  if (holdWrites) for (const w of f.writes) w.resolve();
  await tick();
  return { s, f, base: f.writes.length };
}

test("canal livre: DOWN + MOVE do mesmo evento saem num write só, na ordem, sem esperar timer", async () => {
  const { s, f, base } = await connected(false);
  s.sendInput(pkt(Action.DOWN, 0, 0.1));
  s.sendInput(pkt(Action.MOVE, 0, 0.2));
  assert.equal(f.writes.length, base, "ainda na mesma tarefa: nada escrito (microtarefa)");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(f.writes.length, base + 1, "um write");
  const fr = decodeAll(f.writes.slice(base));
  assert.deepEqual(fr.map((x) => [x.type, x.payload[0]]), [[FrameType.INPUT, Action.DOWN], [FrameType.INPUT, Action.MOVE]]);
  s.close();
});

test("write em andamento: tudo o que chega espera só ele e sai junto no próximo write, ordem estrita", async () => {
  const { s, f, base } = await connected(true);
  s.sendInput(pkt(Action.DOWN, 1));
  await tick();
  assert.equal(f.writes.length, base + 1);
  // enquanto o 1º write não termina: MOVE do joystick, DOWN do pulo, LOOK, UP
  s.sendInput(pkt(Action.MOVE, 0, 0.3));
  s.sendInput(pkt(Action.DOWN, 2));
  s.sendInput(pkt(Action.LOOK, 9));
  s.sendInput(pkt(Action.UP, 1));
  await tick();
  assert.equal(f.writes.length, base + 1, "nenhum write novo enquanto o anterior está em andamento");
  f.writes[base].resolve();
  await tick();
  assert.equal(f.writes.length, base + 2, "um write só com os 4");
  const fr = decodeAll(f.writes.slice(base));
  assert.deepEqual(fr.map((x) => `${x.payload[0]}/${x.payload[1]}`), ["1/1", "2/0", "1/2", "4/9", "3/1"], "ordem estrita entre ponteiros");
  assert.equal(s.stats.writes - s.stats.frames < 0, true);
  f.writes[base + 1].resolve();
  s.close();
});

test("USB engasgado: MOVE/LOOK podem ser descartados, DOWN/UP nunca; congested() avisa o controlador", async () => {
  const { s, f, base } = await connected(true);
  s.sendInput(pkt(Action.DOWN, 1));
  await tick();
  for (let i = 0; i < 40; i++) s.sendInput(pkt(Action.LOOK, 9));
  assert.equal(s.congested(), true);
  s.sendInput(pkt(Action.UP, 1));
  f.writes[base].resolve();
  await tick();
  const fr = decodeAll(f.writes.slice(base + 1));
  assert.equal(fr.filter((x) => x.payload[0] === Action.UP).length, 1, "o UP saiu");
  assert.ok(s.stats.droppedMoves > 0);
  assert.equal(fr.at(-1)!.payload[0], Action.UP, "e por último");
  f.writes.at(-1)!.resolve();
  s.close();
});

test("reliable = true (o InputController desliga cópias/keepalive/deadman no USB)", async () => {
  const { s } = await connected(false);
  assert.equal(s.reliable, true);
  s.close();
});

// ---------------------------------------------------------------- 0.3.4: perfil de vídeo, vstat e teste de latência
const ctrlsOf = (ws: Pending[]) => decodeAll(ws).filter((x) => x.type === FrameType.CTRL).map((x) => new TextDecoder().decode(x.payload));

test("0.3.4: CTRL video é guardado, aplicado localmente e reenviado a cada conexão (junto do quality)", async () => {
  const f = fakeOpener({ holdWrites: false });
  const s = new UsbSession(f.opener as never, "123456", { onState: () => {} });
  assert.equal(s.mode, "legacy", "sem CTRL video (site antigo/teste): comportamento da 0.3.3");
  s.sendCtrl({ type: "quality", height: 720, fps: 60 });
  s.sendCtrl({ type: "video", mode: "lowlat" });
  assert.equal(s.mode, "lowlat");
  await tick();
  const sent = ctrlsOf(f.writes);
  assert.ok(sent.includes('{"type":"quality","height":720,"fps":60}'));
  assert.ok(sent.includes('{"type":"video","mode":"lowlat"}'));
  s.close();
});

test("0.3.4: vstat do app é consumido (e continua indo ao onCtrl); app antigo = sem vstat", async () => {
  const seen: string[] = [];
  const f = fakeOpener({ holdWrites: false });
  const s = new UsbSession(f.opener as never, "123456", { onState: () => {}, onCtrl: (t) => seen.push(t) });
  await tick();
  assert.equal(s.phoneVstat, null);
  f.deliver(encodeText(FrameType.INFO, JSON.stringify({ width: 640, height: 288, fps: 60, codec: "avc1.42C01F" })));
  const vstat = '{"type":"vstat","seq":1,"enc":{"p50":8,"p95":9,"max":10},"clk":"mono","mode":"lowlat","keyMaxKB":90.5}';
  f.deliver(encodeText(FrameType.CTRL, vstat));
  await tick();
  const v = s.phoneVstat as { enc?: { p50: number } | null; keyMaxKB?: number } | null;
  assert.equal(v?.enc?.p50, 8);
  assert.equal(v?.keyMaxKB, 90.5);
  assert.deepEqual(seen, [vstat]);
  assert.equal(s.videoSummary().enc?.p50, 8);
  assert.equal(s.videoSummary().age, null, "sem offset de relógio: sem idade");
  s.close();
});

test("0.3.4: teste de latência sem sincronismo de relógio / app antigo → mensagem clara, nada enviado ao app", async () => {
  const f = fakeOpener({ holdWrites: false });
  const s = new UsbSession(f.opener as never, "123456", { onState: () => {} });
  await tick();
  f.deliver(encodeText(FrameType.INFO, JSON.stringify({ width: 640, height: 288, fps: 60, codec: "avc1.42C01F" })));
  await tick();
  const r = await s.startFlashTest();
  assert.equal(r.ok, false);
  assert.match(r.error!, /Relógio do celular ainda não sincronizado/);
  assert.equal(ctrlsOf(f.writes).filter((m) => /flash/.test(m)).length, 0);
  s.close();
});

test("0.3.4: teste de latência: envia flash, e o status de falha do app encerra com a mensagem dele; pedido duplo é recusado", async () => {
  const f = fakeOpener({ holdWrites: false });
  const s = new UsbSession(f.opener as never, "123456", { onState: () => {} });
  s.setClock(() => ({ offsetMs: 0, uncertaintyMs: 5, rttMs: 10, n: 3 }));
  await tick();
  f.deliver(encodeText(FrameType.INFO, JSON.stringify({ width: 640, height: 288, fps: 60, codec: "avc1.42C01F" })));
  await tick();
  const p = s.startFlashTest();
  const dup = await s.startFlashTest();
  assert.equal(dup.ok, false);
  assert.match(dup.error!, /em andamento/);
  await tick();
  assert.equal(ctrlsOf(f.writes).filter((m) => m === '{"type":"flash"}').length, 1);
  f.deliver(encodeText(FrameType.CTRL, '{"type":"status","scope":"flash","ok":false,"text":"ative a acessibilidade"}'));
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.error, "ative a acessibilidade");
  s.close();
});

test("0.3.4: fim do teste sem nenhum pulso detectado → erro explicando (o quadrado não entrou na captura)", async () => {
  const f = fakeOpener({ holdWrites: false });
  const s = new UsbSession(f.opener as never, "123456", { onState: () => {} });
  s.setClock(() => ({ offsetMs: 0, uncertaintyMs: 5, rttMs: 10, n: 3 }));
  await tick();
  f.deliver(encodeText(FrameType.INFO, JSON.stringify({ width: 640, height: 288, fps: 60, codec: "avc1.42C01F" })));
  await tick();
  const p = s.startFlashTest();
  await tick();
  for (let n = 1; n <= 5; n++) f.deliver(encodeText(FrameType.CTRL, `{"type":"flashAck","n":${n},"pm":${n * 600 * 1000},"vs":8333}`));
  f.deliver(encodeText(FrameType.CTRL, '{"type":"flashAck","n":0,"end":1,"pulses":5}'));
  const r = await p; // o fim fecha a conta depois de ~400 ms; sem quadros decodificados (node) não há bordas
  assert.equal(r.ok, false);
  assert.match(r.error!, /Só 0 de 5 pulsos apareceram no vídeo/);
  assert.equal(s.lastFlashResult, r);
  s.close();
});
