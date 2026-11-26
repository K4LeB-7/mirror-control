/**
 * Teste de latência do vídeo (site 0.3.4): detecção dos pulsos brancos nos quadros DECODIFICADOS e conta de latência.
 * Módulo PURO (sem DOM), testado em tests/videoLatency.test.ts. O app (FlashController) mostra um quadrado preto/branco
 * no canto superior esquerdo da tela e manda `flashAck{n, pm}` por pulso branco (instante de apresentação, µs, relógio
 * do celular); aqui procuramos a borda de subida na luminância do canto de cada quadro desenhado:
 *
 *   latência_vídeo(n) = t_detecção_no_desenho(n) − (pm_n/1000 + offset)
 *
 * Inclui: captura (até 1 vsync depois da apresentação) + codificação + cabo/fila + decodificação + espera de desenho.
 * NÃO inclui o que acontece depois do desenho no canvas (compositor do Chrome + monitor ≈ 1 quadro do monitor).
 */

/** Lado do quadrado = esta fração do menor lado do vídeo (a mesma do app, FlashPlan.SQUARE_FRACTION). */
export const FLASH_SQUARE_FRACTION = 0.1;
/** Região amostrada: o miolo do quadrado (20 %–80 % do lado), em coordenadas do vídeo, sempre dentro dele. */
export function flashRegion(videoW: number, videoH: number): { x: number; y: number; w: number; h: number } {
  const side = FLASH_SQUARE_FRACTION * Math.min(videoW, videoH);
  const x = Math.max(0, Math.floor(side * 0.2));
  const w = Math.max(2, Math.floor(side * 0.6));
  return { x, y: x, w, h: w };
}

/** Luminância média (0–255, Rec. 709) de pixels RGBA (como o getImageData devolve). */
export function meanLumaRGBA(d: ArrayLike<number>, pixels = Math.floor(d.length / 4)): number {
  if (pixels <= 0) return 0;
  let s = 0;
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    s += 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2];
  }
  return s / pixels;
}

/**
 * Detector de borda de subida com histerese. Só conta uma subida depois de ter visto o escuro (o quadrado de teste
 * começa preto): um canto que já era branco antes do app desenhar o overlay não gera pulso falso.
 */
export class PulseDetector {
  state: "unknown" | "low" | "high" = "unknown";
  /** Instantes (ms, navegador) do 1º quadro desenhado com o canto claro, um por pulso. */
  edges: number[] = [];
  samples = 0;
  minLuma = 255;
  maxLuma = 0;

  private low: number;
  private high: number;

  constructor(low = 64, high = 160) {
    this.low = low;
    this.high = high;
  }

  /** @returns true se este quadro é uma borda de subida. */
  push(tMs: number, luma: number): boolean {
    this.samples++;
    if (luma < this.minLuma) this.minLuma = luma;
    if (luma > this.maxLuma) this.maxLuma = luma;
    if (this.state === "unknown") {
      if (luma < this.low) this.state = "low";
      return false;
    }
    if (this.state === "low") {
      if (luma > this.high) {
        this.state = "high";
        this.edges.push(tMs);
        return true;
      }
      return false;
    }
    if (luma < this.low) this.state = "low";
    return false;
  }
}

export type FlashAckSample = { n: number; pm: number };

export type FlashPair = { n: number; latencyMs: number };

/**
 * Casa cada pulso do app com a primeira borda detectada a partir de (apresentação convertida − tolerância). Descarta
 * pares fora de [−tolMs, maxMs]. `offsetMs` = navegador − celular.
 */
export function matchPulses(edges: number[], acks: FlashAckSample[], offsetMs: number, tolMs = 20, maxMs = 2000): { pairs: FlashPair[]; unmatched: number } {
  const used = new Array<boolean>(edges.length).fill(false);
  const pairs: FlashPair[] = [];
  let unmatched = 0;
  const sorted = [...acks].sort((x, y) => x.n - y.n);
  for (let k = 0; k < sorted.length; k++) {
    const a = sorted[k];
    const tPresent = a.pm / 1000 + offsetMs;
    // A borda do pulso n não pode vir depois da apresentação do pulso n+1 (senão uma borda perdida roubaria a do próximo).
    const next = sorted[k + 1];
    const hi = Math.min(tPresent + maxMs, next ? next.pm / 1000 + offsetMs - tolMs : Infinity);
    let found = -1;
    for (let i = 0; i < edges.length; i++) {
      if (used[i]) continue;
      if (edges[i] >= tPresent - tolMs && edges[i] <= hi) {
        found = i;
        break;
      }
    }
    if (found < 0) {
      unmatched++;
      continue;
    }
    used[found] = true;
    pairs.push({ n: a.n, latencyMs: edges[found] - tPresent });
  }
  return { pairs, unmatched };
}

export type FlashResult = {
  ok: boolean;
  error?: string;
  /** Latência por pulso, na ordem (ms). */
  latencies: number[];
  median: number;
  min: number;
  max: number;
  /** Pulsos medidos / pedidos. */
  n: number;
  pulses: number;
  /** Erro máximo possível do offset de relógio (assimetria/2) no momento da conta (ms). */
  uncertaintyMs: number;
  offsetMs: number | null;
  at: number;
};

export function summarizeFlash(pairs: FlashPair[], pulses: number, uncertaintyMs: number, offsetMs: number | null, at: number): FlashResult {
  const l = pairs.map((p) => p.latencyMs);
  const s = [...l].sort((a, b) => a - b);
  const median = s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
  return { ok: l.length >= 2, latencies: l, median, min: s[0] ?? 0, max: s[s.length - 1] ?? 0, n: l.length, pulses, uncertaintyMs, offsetMs, at };
}

/** Texto curto da barra: "Latência real do vídeo: 62 ms (mín 55 · máx 70)". Pulsos e margem de relógio: [flashDetail]. */
export function flashText(r: FlashResult): string {
  if (!r.ok) return r.error ?? "Teste de latência sem resultado";
  const f = (v: number) => Math.round(v).toString();
  return `Latência real do vídeo: ${f(r.median)} ms (mín ${f(r.min)} · máx ${f(r.max)})`;
}

/** Detalhe (tooltip/diagnóstico): "5 pulsos medidos de 5; por pulso 60/62/58/64/61 ms; margem do relógio ±4 ms". */
export function flashDetail(r: FlashResult): string {
  if (!r.ok) return r.error ?? "";
  return `${r.n} pulsos medidos de ${r.pulses}; por pulso ${r.latencies.map((x) => Math.round(x)).join("/")} ms; erro máximo do relógio ±${Math.max(1, Math.round(r.uncertaintyMs))} ms (assimetria ida/volta); não inclui o compositor do Chrome e o monitor`;
}
