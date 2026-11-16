// Testes do framing USB (TS). Rodar: `npm run test:usb` (node --test com remoção de tipos).
// Usa os MESMOS vetores que android/app/src/test/.../UsbWireTest.kt: docs/usb-protocol-vectors.txt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FrameDecoder,
  FrameType,
  MAX_VIDEO_PAYLOAD,
  WireError,
  codecFromAnnexB,
  encodeFrame,
  encodeVideoFrame,
  parseVideoPayload,
} from "../lib/usbWire.ts";

const VECTORS = fileURLToPath(new URL("../../docs/usb-protocol-vectors.txt", import.meta.url));
const lines = readFileSync(VECTORS, "utf8")
  .split("\n")
  .filter((l) => l.trim() && !l.startsWith("#"))
  .map((l) => l.split("|").map((s) => s.trim()));

const unhex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

type FrameVec = { name: string; type: number; pts: number | null; data: Uint8Array; frame: Uint8Array };
const frames: FrameVec[] = lines
  .filter((l) => l[0] === "frame")
  .map(([, name, type, pts, data, frame]) => ({
    name,
    type: parseInt(type, 16),
    pts: pts === "-" ? null : Number(pts),
    data: unhex(data),
    frame: unhex(frame),
  }));
const invalid = lines.filter((l) => l[0] === "invalid").map(([, name, bytes]) => ({ name, bytes: unhex(bytes) }));
const codecs = lines.filter((l) => l[0] === "codec").map(([, b, c]) => ({ bytes: unhex(b), codec: c }));

test("há vetores suficientes", () => {
  assert.ok(frames.length >= 9 && invalid.length >= 8 && codecs.length >= 3);
  const types = new Set(frames.map((f) => f.type));
  for (const t of Object.values(FrameType)) assert.ok(types.has(t), `falta vetor para 0x${t.toString(16)}`);
});

test("encode produz exatamente os bytes dos vetores", () => {
  for (const v of frames) {
    const out = v.pts === null ? encodeFrame(v.type, v.data) : encodeVideoFrame(v.type, v.pts, v.data);
    assert.equal(hex(out), hex(v.frame), v.name);
  }
});

test("decode de cada vetor devolve tipo, payload e pts", () => {
  for (const v of frames) {
    const d = new FrameDecoder();
    const got = d.push(v.frame);
    assert.equal(got.length, 1, v.name);
    assert.equal(got[0].type, v.type, v.name);
    if (v.pts === null) assert.equal(hex(got[0].payload), hex(v.data), v.name);
    else {
      const { ptsUs, data } = parseVideoPayload(got[0].payload);
      assert.equal(ptsUs, v.pts, v.name);
      assert.equal(hex(data), hex(v.data), v.name);
    }
    assert.equal(d.pending, 0);
  }
});

test("leitura fragmentada byte a byte e em pedaços irregulares", () => {
  const all = new Uint8Array(frames.reduce((n, f) => n + f.frame.length, 0));
  let o = 0;
  for (const f of frames) {
    all.set(f.frame, o);
    o += f.frame.length;
  }
  for (const step of [1, 2, 3, 7, 64, all.length]) {
    const d = new FrameDecoder();
    const got = [];
    for (let i = 0; i < all.length; i += step) got.push(...d.push(all.subarray(i, i + step)));
    assert.deepEqual(got.map((g) => g.type), frames.map((f) => f.type), `passo ${step}`);
    assert.deepEqual(got.map((g) => hex(encodeFrame(g.type, g.payload))), frames.map((f) => hex(f.frame)));
  }
});

test("quadro grande (1 MiB) chega inteiro mesmo em pedaços", () => {
  const big = new Uint8Array(1 << 20).map((_, i) => i & 0xff);
  const f = encodeVideoFrame(FrameType.VIDEO_KEY, 42, big);
  const d = new FrameDecoder();
  const got = [];
  for (let i = 0; i < f.length; i += 1000) got.push(...d.push(f.subarray(i, i + 1000)));
  assert.equal(got.length, 1);
  const { ptsUs, data } = parseVideoPayload(got[0].payload);
  assert.equal(ptsUs, 42);
  assert.equal(data.length, big.length);
  assert.equal(data[12345], big[12345]);
});

test("vetores inválidos são rejeitados (já no cabeçalho)", () => {
  for (const v of invalid) {
    assert.throws(() => new FrameDecoder().push(v.bytes), WireError, v.name);
    // Só o cabeçalho já basta para rejeitar.
    assert.throws(() => new FrameDecoder().push(v.bytes.subarray(0, 5)), WireError, v.name + " (cabeçalho)");
  }
});

test("encode recusa payload fora do limite", () => {
  assert.throws(() => encodeFrame(FrameType.INPUT, new Uint8Array(17)), WireError);
  assert.throws(() => encodeFrame(FrameType.VIDEO_CONFIG, new Uint8Array(MAX_VIDEO_PAYLOAD + 1)), WireError);
});

test("tipo desconhecido pequeno é aceito (ignorado pelo receptor)", () => {
  const got = new FrameDecoder().push(unhex("5502000000abcd"));
  assert.equal(got[0].type, 0x55);
});

test("codec avc1 a partir da SPS", () => {
  for (const c of codecs) assert.equal(codecFromAnnexB(c.bytes), c.codec);
  assert.equal(codecFromAnnexB(unhex("0000000168ce3c80")), null);
});
