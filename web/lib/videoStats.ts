/**
 * Instrumentação de latência do VÍDEO no navegador (site 0.3.4). Módulo PURO (sem DOM), testado em
 * tests/videoLatency.test.ts. Sem alocação por quadro: janelas circulares de Float64Array e anéis de tamanho fixo;
 * nada de console.log. Os resumos (que ordenam uma cópia) são calculados ~1 vez por segundo pela UI.
 *
 * Linha do tempo de um quadro (tudo em ms; relógios: navegador = performance.now(); celular = pm/PTS convertido
 * com o offset de linkProbe.ts, `browser = phone + offset`):
 *   captura (pts) → [enc, medido no app] → saiu do MediaCodec → [cabo+fila] → chegou (submit ao decoder)
 *   → [decodificação] → saída do decoder (output) → [espera de desenho] → desenho no canvas
 *   idade do quadro no desenho = agora_navegador − offset − pts   (= soma de tudo, incerteza = assimetria/2)
 */

/** Janela de amostras por métrica. */
export const WINDOW_SIZE = 300;

export type Pct = { p50: number; p95: number; max: number; n: number };

/** Janela circular das últimas [WINDOW_SIZE] amostras (add sem alocação). */
export class Window {
  private v: Float64Array;
  private n = 0;
  private i = 0;
  private cap: number;

  constructor(cap = WINDOW_SIZE) {
    this.cap = cap;
    this.v = new Float64Array(cap);
  }

  add(x: number) {
    if (!Number.isFinite(x)) return;
    this.v[this.i] = x;
    this.i = (this.i + 1) % this.cap;
    if (this.n < this.cap) this.n++;
  }

  clear() {
    this.n = 0;
    this.i = 0;
  }

  get count() {
    return this.n;
  }

  /** p50 = s[(n-1)/2], p95 = s[(n-1)*95/100] (a mesma definição do app, VideoStats.pct). null sem amostras. */
  summary(): Pct | null {
    if (!this.n) return null;
    const s = Array.from(this.v.subarray(0, this.n)).sort((a, b) => a - b);
    const n = s.length;
    return { p50: s[Math.floor((n - 1) / 2)], p95: s[Math.floor(((n - 1) * 95) / 100)], max: s[n - 1], n };
  }
}

/** Idade (ms) de um quadro num instante do navegador: agora − offset − pts. `offsetMs` = browser − phone. */
export function frameAgeMs(nowMs: number, offsetMs: number, ptsUs: number): number {
  return nowMs - offsetMs - ptsUs / 1000;
}

/**
 * Contrapressão do decodificador. Em baixa latência (`max` 2): fila do decoder > 2 E o quadro mais velho esperando há
 * ≥ `minWaitMs` (uma rajada de 3 quadros que chegaram juntos e drenam em poucos ms NÃO derruba o fluxo), ou fila >
 * `hardMax` de qualquer jeito. No modo padrão (0.3.3): fila > 6, sem condição de tempo.
 */
export type BackpressureConfig = { max: number; minWaitMs: number; hardMax: number };
export const BACKPRESSURE_LOWLAT: BackpressureConfig = { max: 2, minWaitMs: 24, hardMax: 6 };
export const BACKPRESSURE_LEGACY: BackpressureConfig = { max: 6, minWaitMs: 0, hardMax: 6 };

export function shouldDropForBackpressure(queueSize: number, oldestWaitMs: number, cfg: BackpressureConfig, progressed = true): boolean {
  // Sem progresso desde o último descarte (nenhum quadro saiu do decoder reiniciado e ainda dentro do período de graça):
  // só um descarte extremo, para o decodificador não ser reiniciado de novo antes de entregar o quadro-chave que pedimos.
  if (!progressed) return queueSize > cfg.hardMax * 2;
  if (queueSize > cfg.hardMax) return true;
  return queueSize > cfg.max && oldestWaitMs >= cfg.minWaitMs;
}

/** Depois de um descarte, outro (que não seja extremo) só vale se o decoder entregou algo ou passou este tempo (ms). */
export const BACKPRESSURE_GRACE_MS = 500;

/** Texto ms com vírgula e 0/1 casa: 7,4 → "7"; 7,4 com 1 → "7,4". */
const ms = (v: number, d = 0) => v.toFixed(d).replace(".", ",");

const RING = 256; // quadros em voo cabem com folga (centenas de ms a 60 fps)

export type Rates = { recvFps: number; decFps: number; drawFps: number; kbps: number };

/**
 * Coletor por quadro. A UI passa o offset (null = sem sincronismo de relógio ou relógio do PTS não confirmado: a
 * idade fica sem amostras e a UI mostra "—").
 */
export class VideoMetrics {
  readonly age = new Window();
  /** captura → chegada ao navegador (inclui a codificação no celular). */
  readonly arrive = new Window();
  readonly decode = new Window();
  readonly drawWait = new Window();

  recv = 0;
  submitted = 0;
  decoded = 0;
  drawn = 0;
  bytes = 0;
  keyCount = 0;
  keyMaxBytes = 0;
  /** Quadros que o navegador jogou fora por contrapressão (ver [shouldDropForBackpressure]). */
  backpressureDrops = 0;
  backpressureResets = 0;
  /** Pico de decodeQueueSize visto no submit. */
  queuePeak = 0;
  /** Último decodeQueueSize visto. */
  queueNow = 0;

  // anel pts → (instante do submit, sequência): o decoder devolve o mesmo timestamp
  private slotPts = new Float64Array(RING).fill(-1);
  private slotAt = new Float64Array(RING);
  private slotSeq = new Float64Array(RING);
  private subAt = new Float64Array(RING); // instante do submit por sequência
  private outSeq = 0;

  private lastRates = { t: -1, recv: 0, dec: 0, draw: 0, bytes: 0 };
  private rates: Rates = { recvFps: 0, decFps: 0, drawFps: 0, kbps: 0 };

  /** Quadro de vídeo chegou do celular (antes de ir ao decoder). */
  onArrive(bytes: number, key: boolean) {
    this.recv++;
    this.bytes += bytes;
    if (key) {
      this.keyCount++;
      if (bytes > this.keyMaxBytes) this.keyMaxBytes = bytes;
    }
  }

  /** O quadro foi entregue ao decoder (EncodedVideoChunk). */
  onSubmit(ptsUs: number, nowMs: number, queueSize: number, offsetMs: number | null) {
    const slot = Math.floor(ptsUs / 1000) & (RING - 1);
    this.slotPts[slot] = ptsUs;
    this.slotAt[slot] = nowMs;
    this.slotSeq[slot] = this.submitted;
    this.subAt[this.submitted & (RING - 1)] = nowMs;
    this.submitted++;
    this.queueNow = queueSize;
    if (queueSize > this.queuePeak) this.queuePeak = queueSize;
    if (offsetMs !== null) this.arrive.add(frameAgeMs(nowMs, offsetMs, ptsUs));
  }

  /** Há quantos ms o quadro mais velho (ainda sem saída) espera no decoder. 0 sem pendentes. */
  oldestPendingWaitMs(nowMs: number): number {
    if (this.outSeq >= this.submitted) return 0;
    return Math.max(0, nowMs - this.subAt[this.outSeq & (RING - 1)]);
  }

  /** O decoder entregou um quadro (callback output). Devolve o instante do submit (-1 se o anel não o tem mais). */
  onOutput(ptsUs: number, nowMs: number): number {
    this.decoded++;
    const slot = Math.floor(ptsUs / 1000) & (RING - 1);
    if (this.slotPts[slot] !== ptsUs) return -1;
    const at = this.slotAt[slot];
    const seq = this.slotSeq[slot];
    if (seq + 1 > this.outSeq) this.outSeq = seq + 1; // saída em ordem: tudo o que veio antes já saiu (ou foi descartado)
    this.decode.add(nowMs - at);
    return at;
  }

  /** Desenhou no canvas: `outAt` = instante da saída do decoder desse quadro. */
  onDraw(ptsUs: number, outAt: number, drawAt: number, offsetMs: number | null) {
    this.drawn++;
    this.drawWait.add(drawAt - outAt);
    if (offsetMs !== null) this.age.add(frameAgeMs(drawAt, offsetMs, ptsUs));
  }

  /** O decoder foi reiniciado/fechado: nada do que estava em voo vai sair. */
  onDecoderReset() {
    this.outSeq = this.submitted;
    this.slotPts.fill(-1);
  }

  /** Nova conexão/INFO: zera janelas e contadores. */
  reset() {
    this.age.clear();
    this.arrive.clear();
    this.decode.clear();
    this.drawWait.clear();
    this.recv = this.submitted = this.decoded = this.drawn = this.bytes = 0;
    this.keyCount = this.keyMaxBytes = 0;
    this.backpressureDrops = this.backpressureResets = 0;
    this.queuePeak = this.queueNow = 0;
    this.slotPts.fill(-1);
    this.outSeq = 0;
    this.lastRates = { t: -1, recv: 0, dec: 0, draw: 0, bytes: 0 };
    this.rates = { recvFps: 0, decFps: 0, drawFps: 0, kbps: 0 };
  }

  /** FPS e bitrate desde a chamada anterior (chamar ~1 Hz). Entre chamadas curtas (< 400 ms) devolve o último. */
  ratesAt(nowMs: number): Rates {
    const l = this.lastRates;
    if (l.t < 0) {
      this.lastRates = { t: nowMs, recv: this.recv, dec: this.decoded, draw: this.drawn, bytes: this.bytes };
      return this.rates;
    }
    const dt = nowMs - l.t;
    if (dt < 400) return this.rates;
    this.rates = {
      recvFps: ((this.recv - l.recv) * 1000) / dt,
      decFps: ((this.decoded - l.dec) * 1000) / dt,
      drawFps: ((this.drawn - l.draw) * 1000) / dt,
      kbps: ((this.bytes - l.bytes) * 8) / dt, // bits/ms = kbit/s
    };
    this.lastRates = { t: nowMs, recv: this.recv, dec: this.decoded, draw: this.drawn, bytes: this.bytes };
    return this.rates;
  }
}

/** Resumo para a UI/diagnóstico (campos nulos = sem dados). */
export type VideoSummary = {
  /** Idade do quadro no desenho (ms). null = sem sincronismo de relógio, app antigo ou relógio do PTS não confirmado. */
  age: Pct | null;
  /** Codificação no celular (vstat.enc). */
  enc: Pct | null;
  /** captura → chegada − enc (p50 a p50; ≥ 0): cabo ADB + fila do app + leitura no navegador. */
  cableQueueMs: number | null;
  /** captura → chegada (inclui enc). */
  arrive: Pct | null;
  decode: Pct | null;
  drawWait: Pct | null;
  /** cabo+fila + decodificação (p50), o "cabo+dec." da linha. */
  cableDecMs: number | null;
  queueNow: number;
  queuePeak: number;
  backpressureDrops: number;
  backpressureResets: number;
  rates: Rates;
  keyMaxKB: number;
  /** Maior quadro-chave visto pelo app (vstat) se houver, senão o visto aqui. */
  keyMaxKBPhone: number | null;
};

export function summarize(m: VideoMetrics, enc: Pct | null, phoneKeyMaxKB: number | null, nowMs: number): VideoSummary {
  const arrive = m.arrive.summary();
  const decode = m.decode.summary();
  const cableQueue = arrive && enc ? Math.max(0, arrive.p50 - enc.p50) : null;
  return {
    age: m.age.summary(),
    enc,
    cableQueueMs: cableQueue,
    arrive,
    decode,
    drawWait: m.drawWait.summary(),
    cableDecMs: cableQueue !== null && decode ? cableQueue + decode.p50 : null,
    queueNow: m.queueNow,
    queuePeak: m.queuePeak,
    backpressureDrops: m.backpressureDrops,
    backpressureResets: m.backpressureResets,
    rates: m.ratesAt(nowMs),
    keyMaxKB: m.keyMaxBytes / 1024,
    keyMaxKBPhone: phoneKeyMaxKB,
  };
}

/**
 * Linha compacta da barra. Sem idade (app antigo/sem vstat): "Vídeo: idade na tela — (sem medição do app) · 60 fps".
 * Ex.: "Vídeo: idade na tela 52/70 ms · cod. 18 · cabo+dec. 12 · fila 0 · 59 fps"
 */
export function videoLineText(s: VideoSummary | null): string {
  if (!s) return "Vídeo: —";
  const fps = `${Math.round(s.rates.drawFps)} fps`;
  const fila = `fila ${s.queueNow}`;
  if (!s.age) return `Vídeo: idade na tela — · ${fila} · ${fps}`;
  const enc = s.enc ? ms(s.enc.p50) : "—";
  const cd = s.cableDecMs !== null ? ms(s.cableDecMs) : "—";
  return `Vídeo: idade na tela ${ms(s.age.p50)}/${ms(s.age.p95)} ms · cod. ${enc} · cabo+dec. ${cd} · ${fila} · ${fps}`;
}

// ------------------------------------------------------------------ opções do decodificador (diagnóstico)

export type DecOptions = { optimizeForLatency: boolean; hardwareAcceleration: HardwareAcceleration };
export const DEFAULT_DEC: DecOptions = { optimizeForLatency: true, hardwareAcceleration: "no-preference" };

/**
 * `?dec=` (diagnóstico, para comparar com "Medir latência do vídeo"): tokens separados por vírgula.
 *   lat1 | lat0   → optimizeForLatency true/false (padrão lat1)
 *   hw | nopref | sw → hardwareAcceleration "prefer-hardware" | "no-preference" (padrão) | "prefer-software"
 * Ex.: `?dec=lat0,sw`. Tokens desconhecidos são ignorados. Devolve null se nada mudou em relação ao padrão.
 */
export function parseDecOptions(search: string): DecOptions | null {
  let raw = "";
  try {
    raw = new URLSearchParams(search).get("dec") ?? "";
  } catch {}
  if (!raw) return null;
  const o: DecOptions = { ...DEFAULT_DEC };
  for (const tok of raw.toLowerCase().split(/[,;.\s]+/)) {
    if (tok === "lat0") o.optimizeForLatency = false;
    else if (tok === "lat1") o.optimizeForLatency = true;
    else if (tok === "hw") o.hardwareAcceleration = "prefer-hardware";
    else if (tok === "nopref") o.hardwareAcceleration = "no-preference";
    else if (tok === "sw") o.hardwareAcceleration = "prefer-software";
  }
  return o.optimizeForLatency === DEFAULT_DEC.optimizeForLatency && o.hardwareAcceleration === DEFAULT_DEC.hardwareAcceleration ? null : o;
}

export const decText = (o: DecOptions) => `lat${o.optimizeForLatency ? 1 : 0},${o.hardwareAcceleration === "prefer-hardware" ? "hw" : o.hardwareAcceleration === "prefer-software" ? "sw" : "nopref"}`;
