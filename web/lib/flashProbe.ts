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
 * Croma média (0–255) = média de max(R,G,B) − min(R,G,B). O quadrado de teste é preto ou branco (neutro, croma ~0
 * mesmo depois do H.264); conteúdo colorido no canto (o app/jogo por trás, se o overlay não entrar na captura) não é.
 */
export function meanChromaRGBA(d: ArrayLike<number>, pixels = Math.floor(d.length / 4)): number {
  if (pixels <= 0) return 0;
  let s = 0;
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    const r = d[o], g = d[o + 1], b = d[o + 2];
    s += Math.max(r, g, b) - Math.min(r, g, b);
  }
  return s / pixels;
}

/** Acima disto (croma média) a amostra não é o quadrado preto/branco. */
export const NEUTRAL_MAX_CHROMA = 48;

/**
 * Detector de borda de subida com histerese. Só conta uma subida depois de ter visto o escuro (o quadrado de teste
 * começa preto): um canto que já era branco antes do app desenhar o overlay não gera pulso falso.
 */
export class PulseDetector {
  state: "unknown" | "low" | "high" = "unknown";
  /** Instantes (ms, navegador) do 1º quadro desenhado com o canto claro, um por pulso. */
  edges: number[] = [];
  /** PTS (µs, relógio do celular) do quadro da borda: compara com o `pm` sem depender do offset de relógio. */
  edgePts: number[] = [];
  /** Quanto tempo (ms) o canto ficou claro em cada pulso (NaN até ver a descida): valida o formato do pulso. */
  highMs: number[] = [];
  samples = 0;
  minLuma = 255;
  maxLuma = 0;

  private low: number;
  private high: number;

  constructor(low = 64, high = 160) {
    this.low = low;
    this.high = high;
  }

  /**
   * @returns true se este quadro é uma borda de subida. `ptsUs` = PTS do quadro (NaN se desconhecido); `chroma` =
   * [meanChromaRGBA] (0 se desconhecida): amostra colorida não é o quadrado → volta a "unknown" (precisa ver o
   * preto de novo) e, se estava claro, aquele "pulso" é invalidado.
   */
  push(tMs: number, luma: number, ptsUs = NaN, chroma = 0): boolean {
    this.samples++;
    if (chroma > NEUTRAL_MAX_CHROMA) {
      if (this.state === "high") this.highMs[this.edges.length - 1] = Infinity;
      this.state = "unknown";
      return false;
    }
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
        this.edgePts.push(ptsUs);
        this.highMs.push(NaN);
        return true;
      }
      return false;
    }
    if (luma < this.low) {
      this.state = "low";
      const k = this.edges.length - 1;
      if (k >= 0) this.highMs[k] = tMs - this.edges[k];
    }
    return false;
  }
}

export type FlashAckSample = { n: number; pm: number };

/** `captureLagMs` = PTS do quadro da borda − pm (ambos no relógio do celular; NaN sem PTS). */
export type FlashPair = { n: number; latencyMs: number; captureLagMs?: number };

/**
 * Formato aceito de um pulso visto no navegador (o app deixa o quadrado branco por 300 ms): uma "borda" cujo claro
 * durou menos que isto, ou mais que [PULSE_HIGH_MAX_MS], não é o quadrado de teste (conteúdo do app piscando no
 * canto, overlay fora da captura) e é ignorada. Duração desconhecida (a descida não foi vista) é aceita.
 */
export const PULSE_HIGH_MIN_MS = 120;
export const PULSE_HIGH_MAX_MS = 700;

/**
 * Casa cada pulso do app com a primeira borda detectada a partir de (apresentação convertida − tolerância). Descarta
 * pares fora de [−tolMs, maxMs]. `offsetMs` = navegador − celular.
 */
export function matchPulses(
  edges: number[],
  acks: FlashAckSample[],
  offsetMs: number,
  tolMs = 20,
  maxMs = 2000,
  extra: { highMs?: number[]; edgePts?: number[] } = {}
): { pairs: FlashPair[]; unmatched: number; rejected: number } {
  const used = new Array<boolean>(edges.length).fill(false);
  let rejected = 0;
  if (extra.highMs) {
    extra.highMs.forEach((h, i) => {
      if (Number.isFinite(h) && (h < PULSE_HIGH_MIN_MS || h > PULSE_HIGH_MAX_MS)) {
        used[i] = true; // formato errado: não é o quadrado de teste
        rejected++;
      }
    });
  }
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
    const ep = extra.edgePts?.[found];
    pairs.push({ n: a.n, latencyMs: edges[found] - tPresent, captureLagMs: ep !== undefined && Number.isFinite(ep) ? (ep - a.pm) / 1000 : NaN });
  }
  return { pairs, unmatched, rejected };
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
  /**
   * Mediana de (PTS do 1º quadro com o pulso − pm), no relógio do celular, SEM depender do offset: ≈ 0 a 1 vsync se o
   * `pm` (vsync do Choreographer + 1) bate com o instante da composição capturada. Muito fora disso = estimativa do
   * `pm` ou base do relógio suspeitas. null sem PTS.
   */
  captureLagMs?: number | null;
  /** Bordas descartadas pelo formato (claro curto/longo demais ou colorido: não era o quadrado de teste). */
  rejectedEdges?: number;
  /** Pares descartados por incoerência (latência longe da mediana dos outros). */
  outliers?: number;
};

/** Pulsos a mais de tanto (ms) da mediana são descartados como incoerentes (borda que não era o pulso). */
export const FLASH_CONSISTENCY_MS = 50;

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/**
 * Resultado do teste. Coerência: o mesmo caminho de vídeo dá latências parecidas nos 5 pulsos (variação de ~1 quadro);
 * pares a mais de [FLASH_CONSISTENCY_MS] da mediana são descartados (`outliers`). Válido com ≥ 2 pulsos coerentes E
 * pelo menos 60 % dos pares coerentes (senão as bordas eram de outra coisa e o número seria inventado).
 */
export function summarizeFlash(pairs0: FlashPair[], pulses: number, uncertaintyMs: number, offsetMs: number | null, at: number): FlashResult {
  const m0 = median(pairs0.map((p) => p.latencyMs));
  const pairs = pairs0.filter((p) => Math.abs(p.latencyMs - m0) <= FLASH_CONSISTENCY_MS);
  const outliers = pairs0.length - pairs.length;
  const l = pairs.map((p) => p.latencyMs);
  const s = [...l].sort((a, b) => a - b);
  const med = median(l);
  const lags = pairs.map((p) => p.captureLagMs ?? NaN).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  const captureLagMs = lags.length ? (lags.length % 2 ? lags[(lags.length - 1) / 2] : (lags[lags.length / 2 - 1] + lags[lags.length / 2]) / 2) : null;
  const ok = l.length >= 2 && l.length >= 0.6 * pairs0.length;
  return { ok, latencies: l, median: med, min: s[0] ?? 0, max: s[s.length - 1] ?? 0, n: l.length, pulses, uncertaintyMs, offsetMs, at, captureLagMs, outliers };
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
  const lag = r.captureLagMs !== null && r.captureLagMs !== undefined ? `; captura − apresentação estimada ${Math.round(r.captureLagMs)} ms` : "";
  return `${r.n} pulsos medidos de ${r.pulses}; por pulso ${r.latencies.map((x) => Math.round(x)).join("/")} ms; erro máximo do relógio ±${Math.max(1, Math.round(r.uncertaintyMs))} ms (assimetria ida/volta)${lag}; não inclui o compositor do Chrome e o monitor`;
}
