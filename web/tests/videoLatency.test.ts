// Instrumentação de latência do vídeo (site 0.3.4): offset de relógio, idade do quadro, janelas, parser de vstat/flashAck,
// detecção de pulso por luminância, contrapressão, linha da barra, ?dec= e diagnóstico. Rodar: `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LinkProbe } from "../lib/linkProbe.ts";
import { parsePhoneCtrl, type PhonePong } from "../lib/protocol.ts";
import {
  BACKPRESSURE_LEGACY,
  BACKPRESSURE_LOWLAT,
  VideoMetrics,
  Window,
  decText,
  frameAgeMs,
  parseDecOptions,
  shouldDropForBackpressure,
  summarize,
  videoLineText,
} from "../lib/videoStats.ts";
import {
  FLASH_SQUARE_FRACTION,
  PulseDetector,
  flashDetail,
  flashRegion,
  flashText,
  matchPulses,
  meanLumaRGBA,
  summarizeFlash,
} from "../lib/flashProbe.ts";
import { buildDiagnostics, diagnosticsText } from "../lib/diagnostics.ts";
import { FrameDecoder, FrameType, encodeFrame, encodeVideoFrame } from "../lib/usbWire.ts";

// ---------------------------------------------------------------- offset de relógio
/** Simula um ping/pong com atrasos de ida/volta conhecidos e o relógio do celular = browser − trueOffset. */
function probeWith(samples: { out: number; back: number }[], trueOffsetMs: number, procMs = 0.1) {
  let clock = 1000;
  const probe = new LinkProbe(() => clock);
  for (const s of samples) {
    const ping = probe.ping();
    const tSend = ping.t;
    const phoneRecvBrowser = tSend + s.out; // instante (relógio do navegador) em que o celular recebeu
    const pmBrowser = phoneRecvBrowser + procMs; // pm é lido ao montar o pong
    const pm = (pmBrowser - trueOffsetMs) * 1000; // µs no relógio do celular
    clock = pmBrowser + s.back;
    const pong: PhonePong = { type: "pong", t: ping.t, p: Math.round(procMs * 1000), d: -1, pm };
    assert.equal(probe.onPong(pong), true);
    clock += 1000;
  }
  return probe;
}

test("offset: sem assimetria o erro é ~0 (RTT 10 ms)", () => {
  const probe = probeWith(Array.from({ length: 8 }, () => ({ out: 5, back: 5 })), -123456.789);
  const c = probe.clockOffset()!;
  assert.ok(Math.abs(c.offsetMs - -123456.789) < 0.01, `${c.offsetMs}`);
  assert.ok(Math.abs(c.rttMs - 10.1) < 0.01);
  assert.ok(Math.abs(c.uncertaintyMs - 5) < 0.01); // (RTT − p)/2
  assert.equal(c.n, 8);
});

test("offset: usa o ping de MENOR RTT (filtro de mínimo)", () => {
  // pings engarrafados atrás de quadros de vídeo (volta lenta) + um ping limpo no meio
  const s = [
    { out: 4, back: 40 },
    { out: 4, back: 30 },
    { out: 4, back: 4 }, // limpo: RTT ≈ 8
    { out: 4, back: 25 },
  ];
  const c = probeWith(s, 5000)!.clockOffset()!;
  assert.ok(Math.abs(c.offsetMs - 5000) < 0.2, `offset do ping limpo: ${c.offsetMs}`);
  assert.ok(c.rttMs < 9);
  // sem o filtro (só os ruins) o erro seria ~(40−4)/2 = 18 ms: confirma que o filtro importa
  const bad = probeWith(s.filter((x) => x.back !== 4), 5000).clockOffset()!;
  assert.ok(Math.abs(bad.offsetMs - 5000) > 10);
  assert.ok(Math.abs(bad.offsetMs - 5000) <= bad.uncertaintyMs + 0.2, "o erro cabe na incerteza declarada");
});

test("offset: assimetria total vira erro de (ida−volta)/2, sempre ≤ incerteza", () => {
  for (const [out, back] of [[2, 18], [18, 2], [10, 10], [0.5, 12]] as const) {
    const c = probeWith([{ out, back }], 777).clockOffset()!;
    const err = Math.abs(c.offsetMs - 777);
    assert.ok(Math.abs(err - Math.abs(out - back) / 2) < 0.1, `${out}/${back}: ${err}`);
    assert.ok(err <= c.uncertaintyMs + 0.1);
  }
});

test("offset: pong sem pm (app 0.3.3) não gera offset; reset limpa; janela limitada a 20", () => {
  let clock = 0;
  const probe = new LinkProbe(() => clock);
  const p = probe.ping();
  clock += 5;
  probe.onPong({ type: "pong", t: p.t, p: 100, d: 2 });
  assert.equal(probe.clockOffset(), null);
  assert.ok(probe.summary());
  const many = probeWith(Array.from({ length: 30 }, () => ({ out: 3, back: 3 })), 1);
  assert.equal(many.clockOffset()!.n, 20);
  many.reset();
  assert.equal(many.clockOffset(), null);
});

// ---------------------------------------------------------------- idade do quadro
test("idade do quadro = agora − offset − pts", () => {
  // pts 2 000 000 µs no relógio do celular; offset +500 ms (browser = phone + 500) → capturado em 2500 ms do navegador
  assert.equal(frameAgeMs(2560, 500, 2_000_000), 60);
  assert.equal(frameAgeMs(100, -1000, 1_090_000), 10);
});

// ---------------------------------------------------------------- janelas
test("Window: p50/p95/max (definição do app) e circularidade", () => {
  const w = new Window(300);
  assert.equal(w.summary(), null);
  for (let i = 1; i <= 20; i++) w.add(i);
  assert.deepEqual(w.summary(), { p50: 10, p95: 19, max: 20, n: 20 }); // s[(n-1)/2], s[(n-1)*95/100]
  w.add(NaN);
  w.add(Infinity);
  assert.equal(w.count, 20); // não finitos ignorados
  const c = new Window(5);
  for (let i = 1; i <= 12; i++) c.add(i); // fica 8..12
  assert.deepEqual(c.summary(), { p50: 10, p95: 11, max: 12, n: 5 });
  c.clear();
  assert.equal(c.summary(), null);
  const one = new Window();
  one.add(7.5);
  assert.deepEqual(one.summary(), { p50: 7.5, p95: 7.5, max: 7.5, n: 1 });
});

test("Window de 300 amostras: p95 de 0..299", () => {
  const w = new Window();
  for (let i = 0; i < 300; i++) w.add(i);
  const s = w.summary()!;
  assert.equal(s.p50, 149);
  assert.equal(s.p95, 284); // floor(299*95/100)
  assert.equal(s.max, 299);
});

// ---------------------------------------------------------------- métricas por quadro
test("VideoMetrics: parcelas e idade com offset conhecido", () => {
  const m = new VideoMetrics();
  const off = 1000; // browser = phone + 1000
  // quadro capturado em 10 000 ms (celular) = 11 000 ms (navegador); chegou 25 ms depois; decod 4; desenho 1
  for (let k = 0; k < 10; k++) {
    const ptsUs = (10_000 + k * 16) * 1000;
    const capB = 11_000 + k * 16;
    m.onArrive(5000, k === 0);
    m.onSubmit(ptsUs, capB + 25, 1, off);
    m.onOutput(ptsUs, capB + 29);
    m.onDraw(ptsUs, capB + 29, capB + 30, off);
  }
  assert.deepEqual([m.arrive.summary()!.p50, m.decode.summary()!.p50, m.drawWait.summary()!.p50, m.age.summary()!.p50], [25, 4, 1, 30]);
  assert.equal(m.recv, 10);
  assert.equal(m.keyCount, 1);
  assert.equal(m.keyMaxBytes, 5000);
  assert.equal(m.drawn, 10);
  // sem offset (app antigo): sem idade nem chegada, mas decod/espera continuam
  const n = new VideoMetrics();
  n.onSubmit(1_000_000, 50, 0, null);
  n.onOutput(1_000_000, 53);
  n.onDraw(1_000_000, 53, 54, null);
  assert.equal(n.age.summary(), null);
  assert.equal(n.arrive.summary(), null);
  assert.equal(n.decode.summary()!.p50, 3);
});

test("VideoMetrics: espera do quadro mais velho no decoder e reinício", () => {
  const m = new VideoMetrics();
  assert.equal(m.oldestPendingWaitMs(100), 0);
  m.onSubmit(1_000_000, 100, 1, null);
  m.onSubmit(1_016_000, 116, 2, null);
  m.onSubmit(1_033_000, 133, 3, null);
  assert.equal(m.oldestPendingWaitMs(150), 50); // o primeiro, de 100 → 150
  m.onOutput(1_000_000, 140); // saiu o 1º
  assert.equal(m.oldestPendingWaitMs(150), 34); // agora o 2º (116)
  assert.equal(m.queuePeak, 3);
  m.onDecoderReset();
  assert.equal(m.oldestPendingWaitMs(500), 0);
  // timestamp desconhecido (anel reiniciado): não quebra
  assert.equal(m.onOutput(1_016_000, 600), -1);
});

test("VideoMetrics: fps e kbps por intervalo", () => {
  const m = new VideoMetrics();
  m.ratesAt(0);
  for (let i = 0; i < 60; i++) {
    m.onArrive(10_000, i === 0);
    m.onOutput(i * 16000, 0);
    m.onDraw(i * 16000, 0, 0, null);
  }
  const r = m.ratesAt(1000);
  assert.equal(r.recvFps, 60);
  assert.equal(r.decFps, 60);
  assert.equal(r.drawFps, 60);
  assert.equal(r.kbps, 4800); // 600 000 B em 1 s
  assert.equal(m.ratesAt(1100), r); // < 400 ms: devolve o anterior
});

// ---------------------------------------------------------------- contrapressão
test("contrapressão: baixa latência (>2 e esperando) e padrão (>6)", () => {
  const L = BACKPRESSURE_LOWLAT;
  assert.equal(shouldDropForBackpressure(0, 0, L), false);
  assert.equal(shouldDropForBackpressure(2, 100, L), false); // no limite
  assert.equal(shouldDropForBackpressure(3, 5, L), false, "rajada de 3 que drena em poucos ms não derruba o fluxo");
  assert.equal(shouldDropForBackpressure(3, L.minWaitMs, L), true, "fila > 2 e o mais velho espera ≥ minWait → descarta");
  assert.equal(shouldDropForBackpressure(7, 0, L), true, "fila > hardMax descarta sempre");
  // sem progresso desde o último descarte: não reinicia de novo o decoder que ainda não entregou o quadro-chave
  assert.equal(shouldDropForBackpressure(5, 100, L, false), false);
  assert.equal(shouldDropForBackpressure(12, 100, L, false), false);
  assert.equal(shouldDropForBackpressure(13, 0, L, false), true, "mesmo sem progresso, uma fila extrema é descartada");
  const G = BACKPRESSURE_LEGACY;
  assert.equal(shouldDropForBackpressure(6, 999, G), false);
  assert.equal(shouldDropForBackpressure(7, 0, G), true); // = o `decodeQueueSize > 6` da 0.3.3
  assert.equal(shouldDropForBackpressure(3, 999, G), false);
});

// ---------------------------------------------------------------- parser de vstat / flashAck / pong
test("parsePhoneCtrl: vstat completo e parcial", () => {
  const v = parsePhoneCtrl(
    '{"type":"vstat","seq":4,"enc":{"p50":8.2,"p95":12,"max":20.1},"q":{"p50":0.1,"p95":0.5,"max":2},"wr":null,"fps":59.8,"kbps":7900,"keyMaxKB":123.4,"queueDrops":3,"queueOverflows":1,"queuePeak":2,"clk":"mono","mode":"lowlat","tier":3,"rej":"","vw":1280,"vh":576,"capFps":60,"targetKbps":6000,"gop":4,"n":60,"ver":"0.3.4"}'
  );
  assert.ok(v && v.type === "vstat");
  assert.deepEqual(v.enc, { p50: 8.2, p95: 12, max: 20.1 });
  assert.equal(v.wr, null);
  assert.equal(v.queueDrops, 3);
  assert.equal(v.mode, "lowlat");
  assert.equal(v.tier, 3);
  assert.equal(v.width, 1280);
  assert.equal(v.ver, "0.3.4");
  const p = parsePhoneCtrl('{"type":"vstat","enc":null,"clk":"unk"}');
  assert.ok(p && p.type === "vstat");
  assert.equal(p.enc, null);
  assert.equal(p.clk, "unk");
  assert.equal(p.mode, "");
  assert.equal(p.fps, 0);
  const bad = parsePhoneCtrl('{"type":"vstat","enc":{"p50":"x"}}');
  assert.ok(bad && bad.type === "vstat" && bad.enc === null);
});

test("parsePhoneCtrl: flashAck, fim, falha e pong com pm", () => {
  assert.deepEqual(parsePhoneCtrl('{"type":"flashAck","n":3,"pm":123456,"pm0":115000,"vs":8333}'), { type: "flashAck", n: 3, pm: 123456, pm0: 115000, vs: 8333, end: false });
  assert.deepEqual(parsePhoneCtrl('{"type":"flashAck","n":0,"end":1,"pulses":5}'), { type: "flashAck", n: 0, pm: 0, end: true, pulses: 5 });
  assert.equal(parsePhoneCtrl('{"type":"flashAck","n":0,"pm":5}'), null); // n ≥ 1 ou end
  assert.equal(parsePhoneCtrl('{"type":"flashAck","n":1}'), null);
  const st = parsePhoneCtrl('{"type":"status","scope":"flash","ok":false,"text":"ative a acessibilidade"}');
  assert.ok(st && st.type === "status" && st.scope === "flash" && st.ok === false);
  assert.deepEqual(parsePhoneCtrl('{"type":"pong","t":1234.567,"p":42,"d":2.5,"profile":"eco","pm":987654321}'), { type: "pong", t: 1234.567, p: 42, d: 2.5, profile: "eco", pm: 987654321 });
  // pong da 0.3.3 continua igual (sem a chave pm)
  assert.deepEqual(parsePhoneCtrl('{"type":"pong","t":1,"p":2,"d":3}'), { type: "pong", t: 1, p: 2, d: 3, profile: undefined });
});

// ---------------------------------------------------------------- pulso por luminância
const rgba = (r: number, g: number, b: number, px = 64) => {
  const a = new Uint8ClampedArray(px * 4);
  for (let i = 0; i < px; i++) a.set([r, g, b, 255], i * 4);
  return a;
};

test("luminância média (Rec. 709) de RGBA", () => {
  assert.equal(Math.round(meanLumaRGBA(rgba(0, 0, 0))), 0);
  assert.equal(Math.round(meanLumaRGBA(rgba(255, 255, 255))), 255);
  assert.ok(Math.abs(meanLumaRGBA(rgba(255, 0, 0)) - 54.2) < 0.1);
  assert.ok(Math.abs(meanLumaRGBA(rgba(0, 255, 0)) - 182.4) < 0.1);
  // metade preta, metade branca
  const half = new Uint8ClampedArray(8 * 4);
  for (let i = 4; i < 8; i++) half.set([255, 255, 255, 255], i * 4);
  assert.ok(Math.abs(meanLumaRGBA(half) - 127.5) < 0.01);
  assert.equal(meanLumaRGBA(new Uint8Array(0)), 0);
});

test("PulseDetector: 5 pulsos com histerese, ignora ruído e o branco inicial", () => {
  const d = new PulseDetector();
  // canto já branco antes do app desenhar: nada de pulso falso
  assert.equal(d.push(0, 240), false);
  assert.equal(d.push(16, 238), false);
  assert.equal(d.state, "unknown");
  let t = 32;
  const edges: number[] = [];
  for (let n = 0; n < 5; n++) {
    for (let i = 0; i < 6; i++) d.push((t += 16), 14 + (i % 3)); // preto com ruído
    d.push((t += 16), 110); // quadro intermediário (compressão): ainda não é pulso
    edges.push(t + 16);
    assert.equal(d.push((t += 16), 235), true);
    for (let i = 0; i < 5; i++) assert.equal(d.push((t += 16), 233 + (i % 3)), false); // branco estável
    d.push((t += 16), 150); // intermediário descendo: histerese, ainda "alto"
    assert.equal(d.state, "high");
  }
  assert.equal(d.edges.length, 5);
  assert.deepEqual(d.edges, edges);
  assert.equal(d.minLuma, 14);
  assert.equal(d.maxLuma, 240);
});

test("PulseDetector: tremida entre os limiares não conta", () => {
  const d = new PulseDetector();
  d.push(0, 10);
  for (let i = 1; i < 30; i++) assert.equal(d.push(i, 100 + (i % 2) * 30), false);
  assert.equal(d.edges.length, 0);
});

test("região amostrada fica dentro do quadrado, em qualquer escala", () => {
  for (const [w, h] of [[1280, 576], [576, 1280], [640, 288], [1920, 1080]] as const) {
    const r = flashRegion(w, h);
    const side = FLASH_SQUARE_FRACTION * Math.min(w, h);
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= side && r.y + r.h <= side, `${w}x${h}: ${JSON.stringify(r)} lado ${side}`);
    assert.ok(r.w >= 2);
  }
});

test("matchPulses: latência = borda − (pm/1000 + offset); tolera borda perdida e ordem", () => {
  const offset = 1000;
  const acks = [1, 2, 3, 4, 5].map((n) => ({ n, pm: (5000 + n * 600) * 1000 })); // celular: 5600, 6200, …
  const present = (n: number) => 5000 + n * 600 + offset;
  const lat = [60, 62, 58, 64, 61];
  const edges = [1, 2, 3, 4, 5].map((n, i) => present(n) + lat[i]);
  let r = matchPulses(edges, acks, offset);
  assert.deepEqual(r.pairs.map((p) => Math.round(p.latencyMs)), lat);
  assert.equal(r.unmatched, 0);
  // o 3º pulso não foi detectado: os outros continuam casando com o certo
  r = matchPulses(edges.filter((_, i) => i !== 2), acks, offset);
  assert.deepEqual(r.pairs.map((p) => p.n), [1, 2, 4, 5]);
  assert.equal(r.unmatched, 1);
  // borda espúria muito antes do 1º pulso é ignorada
  r = matchPulses([100, ...edges], acks, offset);
  assert.equal(r.pairs.length, 5);
  assert.deepEqual(r.pairs.map((p) => Math.round(p.latencyMs)), lat);
  // sem bordas
  assert.equal(matchPulses([], acks, offset).unmatched, 5);
});

test("summarizeFlash/flashText: mediana, mín, máx", () => {
  const pairs = [60, 62, 58, 64, 61].map((latencyMs, i) => ({ n: i + 1, latencyMs }));
  const r = summarizeFlash(pairs, 5, 4.4, 123, 0);
  assert.equal(r.ok, true);
  assert.equal(r.median, 61);
  assert.equal(r.min, 58);
  assert.equal(r.max, 64);
  assert.equal(r.n, 5);
  assert.equal(flashText(r), "Latência real do vídeo: 61 ms (mín 58 · máx 64)");
  assert.equal(flashDetail(r), "5 pulsos medidos de 5; por pulso 60/62/58/64/61 ms; erro máximo do relógio ±4 ms (assimetria ida/volta); não inclui o compositor do Chrome e o monitor");
  assert.equal(summarizeFlash([{ n: 1, latencyMs: 50 }], 5, 1, 0, 0).ok, false); // 1 pulso só não basta
  assert.equal(summarizeFlash([{ n: 1, latencyMs: 50 }, { n: 2, latencyMs: 70 }], 5, 1, 0, 0).median, 60); // par: média dos do meio
  assert.equal(flashText({ ...r, ok: false, error: "sem acessibilidade" }), "sem acessibilidade");
});

// ---------------------------------------------------------------- linha da barra e ?dec=
test("linha da barra: com dados, sem idade (app antigo) e sem nada", () => {
  const m = new VideoMetrics();
  const off = 0;
  for (let k = 0; k < 20; k++) {
    const pts = k * 16_000;
    m.onSubmit(pts, k * 16 + 30, 0, off); // chegou 30 ms depois da captura (inclui enc 18)
    m.onOutput(pts, k * 16 + 34);
    m.onDraw(pts, k * 16 + 34, k * 16 + 35, off);
  }
  const s = summarize(m, { p50: 18, p95: 22, max: 30, n: 20 }, 120, 1000);
  assert.equal(s.cableQueueMs, 12); // 30 − 18
  assert.equal(s.cableDecMs, 16); // 12 + 4
  assert.match(videoLineText(s), /^Vídeo: idade na tela 35\/35 ms · cod\. 18 · cabo\+dec\. 16 · fila 0 · \d+ fps$/);
  const old = new VideoMetrics();
  old.onSubmit(1_000_000, 10, 2, null);
  old.onOutput(1_000_000, 12);
  old.onDraw(1_000_000, 12, 13, null);
  assert.match(videoLineText(summarize(old, null, null, 1000)), /^Vídeo: idade na tela — · fila 2 · \d+ fps$/);
  assert.equal(videoLineText(null), "Vídeo: —");
});

test("?dec=: tokens, padrão e lixo", () => {
  assert.equal(parseDecOptions(""), null);
  assert.equal(parseDecOptions("?room=abc"), null);
  assert.equal(parseDecOptions("?dec=lat1,nopref"), null); // = padrão
  assert.deepEqual(parseDecOptions("?dec=lat0"), { optimizeForLatency: false, hardwareAcceleration: "no-preference" });
  assert.deepEqual(parseDecOptions("?dec=lat0,sw"), { optimizeForLatency: false, hardwareAcceleration: "prefer-software" });
  assert.deepEqual(parseDecOptions("?dec=hw"), { optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" });
  assert.deepEqual(parseDecOptions("?x=1&dec=sw.lat0&y=2"), { optimizeForLatency: false, hardwareAcceleration: "prefer-software" });
  assert.equal(parseDecOptions("?dec=banana"), null);
  assert.equal(decText({ optimizeForLatency: false, hardwareAcceleration: "prefer-software" }), "lat0,sw");
});

// ---------------------------------------------------------------- parser de quadros sem cópia
test("FrameDecoder zeroCopy: mesmo resultado, em qualquer fragmentação", () => {
  const data = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 255);
  const stream = new Uint8Array([
    ...encodeFrame(FrameType.CTRL, new TextEncoder().encode('{"a":1}')),
    ...encodeVideoFrame(FrameType.VIDEO_KEY, 123_456, data),
    ...encodeVideoFrame(FrameType.VIDEO_DELTA, 123_460, data.subarray(0, 50)),
    ...encodeFrame(FrameType.INFO, new TextEncoder().encode("{}")),
  ]);
  const ref = new FrameDecoder().push(stream);
  for (const step of [1, 3, 5, 7, 64, 200, stream.length]) {
    const d = new FrameDecoder(true);
    const got: { type: number; payload: Uint8Array }[] = [];
    for (let i = 0; i < stream.length; i += step) {
      // cada pedaço numa cópia própria e sobrescrita depois (como se o transporte reaproveitasse): vale o contrato "usar na hora"
      const chunk = stream.slice(i, i + step);
      for (const f of d.push(chunk)) got.push({ type: f.type, payload: f.payload.slice() });
    }
    assert.equal(got.length, ref.length, `passo ${step}`);
    got.forEach((f, i) => {
      assert.equal(f.type, ref[i].type);
      assert.deepEqual(f.payload, ref[i].payload);
    });
    assert.equal(d.pending, 0);
  }
});

test("FrameDecoder zeroCopy: quadros inteiros no pedaço são vistas (sem cópia); resto incompleto é guardado", () => {
  const f1 = encodeFrame(FrameType.CTRL, new TextEncoder().encode("hello"));
  const f2 = encodeFrame(FrameType.CTRL, new TextEncoder().encode("world!"));
  const chunk = new Uint8Array([...f1, ...f2.subarray(0, 4)]);
  const d = new FrameDecoder(true);
  const out = d.push(chunk);
  assert.equal(out.length, 1);
  assert.equal(out[0].payload.buffer, chunk.buffer); // vista do próprio pedaço
  assert.equal(d.pending, 4);
  const rest = d.push(f2.subarray(4));
  assert.equal(new TextDecoder().decode(rest[0].payload), "world!");
  assert.throws(() => new FrameDecoder(true).push(Uint8Array.from([0x10, 5, 0, 0, 0])), /tamanho inválido/); // INPUT deve ter 18 bytes
});

// ---------------------------------------------------------------- diagnóstico
test("diagnóstico: reúne tudo, sem PIN/série, e sobrevive a dados ausentes", () => {
  const m = new VideoMetrics();
  for (let k = 0; k < 10; k++) {
    m.onSubmit(k * 16_000, k * 16 + 30, 0, 0);
    m.onOutput(k * 16_000, k * 16 + 34);
    m.onDraw(k * 16_000, k * 16 + 34, k * 16 + 35, 0);
  }
  const video = summarize(m, { p50: 18, p95: 22, max: 30, n: 10 }, 120, 1000);
  const flash = summarizeFlash([60, 62, 58].map((latencyMs, i) => ({ n: i + 1, latencyMs })), 5, 4, 100, 0);
  const d = buildDiagnostics({
    siteVersion: "0.3.4",
    userAgent: "UA-teste",
    transport: "usb",
    quality: { height: 720, fps: 60 },
    fluidity: "balanced",
    phoneFluidity: "balanced",
    videoMode: "lowlat",
    dec: { optimizeForLatency: true, hardwareAcceleration: "no-preference" },
    info: { width: 1280, height: 576, fps: 60, codec: "avc1.42C01F" },
    link: { n: 20, rttP50: 9.5, rttP95: 12, rttMax: 15, appMs: 0.1, phoneDispatchMs: 2.3, keyToPhoneMs: 4.9 },
    clock: { offsetMs: 12345.6, uncertaintyMs: 4.7, rttMs: 9.5, n: 20 },
    video,
    vstat: null,
    session: { mode: "lowlat" },
    flash,
    adb: { maxPayloadSize: 1048576, delayedAck: true },
    now: new Date("2026-01-01T00:00:00Z"),
  });
  const text = diagnosticsText(d);
  const j = JSON.parse(text);
  assert.equal(j.site.versao, "0.3.4");
  assert.equal(j.video.perfil, "lowlat");
  assert.equal(j.video.decodificador.opcoes, "lat1,nopref");
  assert.equal(j.video.idadeNaTelaMs.p50, 35);
  assert.equal(j.video.caboMaisFilaMs, 12);
  assert.equal(j.testeFlash.medianaMs, 60);
  assert.deepEqual(j.testeFlash.porPulsoMs, [60, 62, 58]);
  assert.equal(j.relogio.incertezaMs, 4.7);
  assert.equal(j.entrada.celularParaToqueMs, 2.3);
  assert.equal(j.adb.delayedAck, true);
  assert.equal(j.app, null); // sem vstat
  assert.ok(j.resumo.some((l: string) => /Idade do quadro na tela p50\/p95\/máx: 35/.test(l)));
  assert.ok(j.resumo.some((l: string) => /Latência real do vídeo \(flash\): mediana 60/.test(l)));
  assert.doesNotMatch(text, /pin|serial/i);
  // tudo ausente
  const e = buildDiagnostics({
    siteVersion: "0.3.4", userAgent: "UA", transport: "webrtc", quality: { height: 720, fps: 60 }, fluidity: "balanced", phoneFluidity: "—",
    videoMode: "legacy", dec: { optimizeForLatency: true, hardwareAcceleration: "no-preference" }, info: null, link: null, clock: null,
    video: null, vstat: null, session: null, flash: null, adb: null, now: new Date(0),
  });
  const ej = JSON.parse(diagnosticsText(e));
  assert.equal(ej.video.idadeNaTelaMs, null);
  assert.ok(ej.resumo.some((l: string) => /Idade do quadro na tela: —/.test(l)));
});

// ---------------------------------------------------------------- revisão 0.3.4: relógio (pq, salto, deriva) e flash
/**
 * Ping/pong como o app revisado: o pong espera `queueMs` na fila de saída atrás de vídeo; `pm` é carimbado na ida ao
 * socket e `pq` = recebimento → ida. `phoneOffset(tBrowser)` = relógio do celular − navegador (muda num salto/deriva).
 */
function probeRev(samples: { out: number; back: number; queueMs: number; withPq: boolean }[], phoneMinusBrowser: (t: number) => number) {
  let clock = 1000;
  const probe = new LinkProbe(() => clock);
  for (const s of samples) {
    const ping = probe.ping();
    const recv = ping.t + s.out;
    const leave = recv + 0.1 + s.queueMs; // tratou em 0,1 ms e esperou a fila
    const stamp = s.withPq ? leave : recv + 0.1; // app revisado carimba na ida; 0.3.4 original, antes da fila
    const pm = (stamp + phoneMinusBrowser(stamp)) * 1000;
    clock = leave + s.back;
    const pong: PhonePong = { type: "pong", t: ping.t, p: 100, d: -1, pm, ...(s.withPq ? { pq: Math.round((leave - recv) * 1000) } : {}) };
    assert.equal(probe.onPong(pong), true);
    clock += 1000;
  }
  return probe;
}

test("revisão: pong carimbado na ida ao socket (pq) tira a espera da fila de vídeo da assimetria", () => {
  const trueOff = -7000; // browser = phone − 7000 → phoneMinusBrowser = +7000
  const rows = Array.from({ length: 10 }, () => ({ out: 3, back: 3, queueMs: 25, withPq: true }));
  const c = probeRev(rows, () => 7000).clockOffset()!;
  assert.ok(Math.abs(c.offsetMs - trueOff) < 0.05, `offset ${c.offsetMs}`);
  assert.ok(c.uncertaintyMs < 3.1, `incerteza só do cabo (3 ms), sem a fila: ${c.uncertaintyMs}`);
  // o mesmo cenário com o pong carimbado ANTES da fila (sem pq): viés de ~fila/2 para mais, coberto pela incerteza
  const old = probeRev(rows.map((r) => ({ ...r, withPq: false })), () => 7000).clockOffset()!;
  assert.ok(Math.abs(old.offsetMs - trueOff - 12.5) < 0.1, `viés antigo ${old.offsetMs - trueOff}`);
  assert.ok(Math.abs(old.offsetMs - trueOff) <= old.uncertaintyMs + 0.1);
});

test("revisão: salto de relógio (celular dormiu 30 s) é detectado e a estimativa recomeça na hora", () => {
  const rows = Array.from({ length: 12 }, () => ({ out: 2, back: 2, queueMs: 0, withPq: true }));
  // as 6 primeiras com o relógio antigo; depois o MONOTONIC "perdeu" 30 s (dormiu): celular − navegador cai 30 000 ms
  let i = 0;
  const p = probeRev(rows, () => (i++ < 6 ? 7000 : 7000 - 30_000));
  const c = p.clockOffset()!;
  assert.equal(c.jumps, 1);
  assert.equal(c.n, 6, "só as amostras depois do salto");
  assert.ok(Math.abs(c.offsetMs - (-7000 + 30_000)) < 0.05, `offset novo ${c.offsetMs}`);
});

test("revisão: deriva de 100 ppm por 20 s não é confundida com salto e o erro fica dentro da incerteza", () => {
  const rows = Array.from({ length: 20 }, () => ({ out: 1.5, back: 1.5, queueMs: 0, withPq: true }));
  const p = probeRev(rows, (t) => 7000 + t * 1e-4);
  const c = p.clockOffset()!;
  assert.equal(c.jumps, 0);
  assert.equal(c.n, 20);
  const trueNow = -(7000 + (1000 + 20 * 1003) * 1e-4);
  assert.ok(Math.abs(c.offsetMs - trueNow) <= c.uncertaintyMs + 2.1, `erro ${c.offsetMs - trueNow}`);
});

test("revisão: amostras com mais de 30 s saem da janela", () => {
  let clock = 0;
  const probe = new LinkProbe(() => clock);
  const one = (pm: number) => {
    const ping = probe.ping();
    clock += 2;
    probe.onPong({ type: "pong", t: ping.t, p: 0, d: -1, pm, pq: 0 });
  };
  one((clock + 1) * 1000);
  clock += 40_000;
  one((clock + 1) * 1000);
  assert.equal(probe.clockOffset()!.n, 1);
});

test("revisão: parser do pong lê pq (e ignora pq inválido)", () => {
  const a = parsePhoneCtrl('{"type":"pong","t":1.5,"p":80,"d":2,"pm":123,"pq":4567}') as PhonePong;
  assert.equal(a.pq, 4567);
  const b = parsePhoneCtrl('{"type":"pong","t":1.5,"p":80,"d":2,"pm":123,"pq":-3}') as PhonePong;
  assert.equal(b.pq, undefined);
});

test("revisão: flash ignora piscadas do conteúdo com duração errada e mede captura − pm sem o offset", () => {
  const d = new PulseDetector();
  const offset = 100; // browser = phone + 100
  const acks = [1, 2, 3].map((n) => ({ n, pm: (300 + (n - 1) * 600) * 1000 })); // pm em µs do celular
  const feed = (ms: number, luma: number, ptsUs = NaN) => d.push(ms, luma, ptsUs);
  feed(0, 10);
  // conteúdo do app piscando no canto: claro por 40 ms logo antes do pulso 1 (não é o quadrado)
  feed(380, 220, 280_000);
  feed(420, 10);
  // pulsos reais: o 1º quadro claro tem pts = pm + 5 ms (captura logo depois da apresentação estimada) e chega 60 ms depois
  for (const a of acks) {
    const tp = a.pm / 1000 + offset;
    feed(tp + 60, 230, a.pm + 5000);
    feed(tp + 360, 12);
  }
  const m = matchPulses(d.edges, acks, offset, 20, 2000, { highMs: d.highMs, edgePts: d.edgePts });
  assert.equal(m.rejected, 1);
  assert.deepEqual(m.pairs.map((p) => Math.round(p.latencyMs)), [60, 60, 60]);
  const r = summarizeFlash(m.pairs, 3, 2, offset, 0);
  assert.equal(r.captureLagMs, 5);
  assert.match(flashDetail(r), /captura − apresentação estimada 5 ms/);
  // sem o filtro de formato a piscada de 40 ms seria tomada como o pulso 1 (latência errada)
  const naive = matchPulses(d.edges, acks, offset);
  assert.notEqual(Math.round(naive.pairs[0].latencyMs), 60);
});

test("revisão: amostra colorida não é o quadrado (croma) e pulsos incoerentes são descartados", async () => {
  const { meanChromaRGBA, NEUTRAL_MAX_CHROMA } = await import("../lib/flashProbe.ts");
  const px = (r: number, g: number, b: number) => Uint8Array.from(Array.from({ length: 64 }, () => [r, g, b, 255]).flat());
  assert.equal(meanChromaRGBA(px(255, 255, 255)), 0);
  assert.ok(meanChromaRGBA(px(16, 18, 15)) < 5); // preto do H.264 (faixa limitada) continua neutro
  assert.ok(meanChromaRGBA(px(230, 200, 30)) > NEUTRAL_MAX_CHROMA); // amarelo do conteúdo
  // conteúdo colorido: escuro-azul → claro-amarelo NÃO é borda; o quadrado (preto → branco) é
  const d = new PulseDetector();
  d.push(0, 30, NaN, meanChromaRGBA(px(10, 20, 200))); // azul escuro (luma < 64) mas colorido
  assert.equal(d.push(16, 200, NaN, meanChromaRGBA(px(230, 200, 30))), false);
  assert.equal(d.state, "unknown");
  d.push(32, 5, NaN, 0);
  assert.equal(d.push(48, 250, NaN, 0), true);
  // um pulso branco que vira colorido no meio é invalidado (duração ∞ → rejeitado pelo formato)
  d.push(64, 200, NaN, 90);
  assert.equal(d.highMs[0], Infinity);
  // coerência: 3 pulsos coerentes + 2 bordas de outra coisa → só os 3 contam
  const r = summarizeFlash([60, 400, 62, 58, 900].map((latencyMs, i) => ({ n: i + 1, latencyMs })), 5, 2, 0, 0);
  assert.equal(r.ok, true);
  assert.equal(r.n, 3);
  assert.equal(r.outliers, 2);
  assert.equal(r.max, 62);
  // latências espalhadas (bordas aleatórias do conteúdo): sem maioria coerente → sem resultado
  const bad = summarizeFlash([20, 300, 520, 160].map((latencyMs, i) => ({ n: i + 1, latencyMs })), 5, 2, 0, 0);
  assert.equal(bad.ok, false);
});
