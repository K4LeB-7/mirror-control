import type { PhonePong } from "./protocol.ts";

/**
 * Medição do enlace site ↔ app (site/app 0.3.3). Módulo PURO (sem DOM), testado em tests/input.test.ts.
 *
 * A cada ~1 s o site manda CTRL `{"type":"ping","t":performance.now()}`; o app responde na hora
 * `{"type":"pong","t":<o mesmo>,"p":<µs no app>,"d":<mediana DOWN→dispatchGesture no celular, ms>}`. RTT = agora − t.
 * Estimativa "tecla → celular" ≈ RTT/2 (ida) + p (o app tratando a mensagem). "d" é a espera do planejador de toques
 * medida no celular (do pacote chegar ao dispatchGesture). App antigo não responde: [summary] fica sem dados ("—").
 *
 * Observações: o ping viaja pelo canal de CONTROLE (USB: o mesmo socket da entrada; WebRTC: o canal "ctrl",
 * confiável); a volta (pong) passa pela fila de saída do celular atrás de quadros de vídeo já enfileirados, então o
 * RTT/2 tende a SUPERestimar a ida da entrada.
 */
export const PING_INTERVAL_MS = 1000;
export const PING_WINDOW = 20;
/** Amostras (ping com `pm`) consideradas na estimativa do offset de relógio. */
export const CLOCK_WINDOW = 20;

/**
 * Offset de relógio navegador ↔ celular (app 0.3.4+, pong com `pm` = relógio do celular em µs, na base do PTS).
 * `browserMs = phoneMs + offsetMs`. Estimativa NTP: o celular recebeu o ping em `pm − pq` e mandou o pong em `pm`,
 * então `offset = (t_envio + t_recv)/2 + pq/2 − pm` e o erro é (atraso de ida − atraso de volta)/2, no pior caso
 * (todo o atraso de um lado só) ±(RTT − pq)/2 — a "incerteza" mostrada.
 * - `pq` (app 0.3.4 revisado): o pong é carimbado na hora de ir ao socket e `pq` inclui a espera atrás dos quadros de
 *   vídeo na fila do app; essa espera sai da assimetria. Sem `pq`, usa `p` (o pong carimbado antes da fila: a espera
 *   entra no RTT, a incerteza cresce e cobre o viés, para mais).
 * - Filtro de mínimo: usa o ping de MENOR RTT entre os últimos [CLOCK_WINDOW] (no máximo [CLOCK_MAX_AGE_MS] de idade):
 *   pings que esbarraram em vídeo no cabo, ou num engasgo do USB, têm RTT e assimetria maiores e ficam de fora.
 * - Salto de relógio (o celular dormiu: CLOCK_MONOTONIC para; ou a base mudou): cada amostra confina o offset real a
 *   [off − u, off + u]; se a amostra nova não cruza a melhor (com folga de deriva de 100 ppm), as antigas são
 *   descartadas e a estimativa recomeça (`jumps` conta).
 */
export const CLOCK_MAX_AGE_MS = 30_000;
const CLOCK_SLACK_MS = 0.5;
const CLOCK_DRIFT = 1e-4;

export type ClockOffset = {
  /** browser = celular + offsetMs. */
  offsetMs: number;
  /** Erro máximo possível por assimetria (ms) = (RTT mínimo − pq)/2. */
  uncertaintyMs: number;
  /** RTT do ping escolhido (ms). */
  rttMs: number;
  /** Amostras na janela. */
  n: number;
  /** Saltos de relógio detectados desde a conexão (a estimativa recomeçou). */
  jumps?: number;
};

export type LinkSummary = {
  /** Amostras na janela (0 = app antigo/sem resposta ainda). */
  n: number;
  rttP50: number;
  rttP95: number;
  rttMax: number;
  /** Tempo do app tratando o ping (ms, mediana). */
  appMs: number;
  /** Mediana DOWN→dispatchGesture medida no celular (ms; -1 = sem dados). */
  phoneDispatchMs: number;
  /** ≈ RTT/2 + app (ms). */
  keyToPhoneMs: number;
};

type ClockSample = { rtt: number; off: number; u: number; at: number };

export class LinkProbe {
  private rtts: number[] = [];
  private apps: number[] = [];
  private lastD = -1;
  private outstanding = new Set<number>();
  private clk: ClockSample[] = [];
  private jumps = 0;

  private now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  /** Mensagem de ping (registra o t enviado; no máximo 8 sem resposta guardados). */
  ping(): { type: "ping"; t: number } {
    const t = Math.round(this.now() * 1000) / 1000;
    this.outstanding.add(t);
    if (this.outstanding.size > 8) this.outstanding.delete(this.outstanding.values().next().value as number);
    return { type: "ping", t };
  }

  /** Pong do celular. Ignora respostas a pings que não são deste site/desta conexão. */
  onPong(p: PhonePong): boolean {
    const t = [...this.outstanding].find((x) => Math.abs(x - p.t) < 0.01);
    if (t === undefined) return false;
    this.outstanding.delete(t);
    const rtt = this.now() - t;
    if (!(rtt >= 0 && rtt < 10_000)) return false;
    this.rtts.push(rtt);
    this.apps.push(Math.max(0, p.p) / 1000);
    if (this.rtts.length > PING_WINDOW) this.rtts.shift();
    if (this.apps.length > PING_WINDOW) this.apps.shift();
    this.lastD = p.d;
    if (p.pm !== undefined && Number.isFinite(p.pm)) {
      const now = t + rtt;
      // pq (0.3.4 revisado) = recebimento → ida ao socket; sem ele, p (recebimento → tratamento).
      const hold = Math.min(rtt, Math.max(0, p.pq ?? p.p) / 1000);
      const off = (t + now) / 2 + hold / 2 - p.pm / 1000; // (t_envio + t_recv)/2 + pq/2 − pm
      const u = Math.max(0, (rtt - hold) / 2);
      this.clk = this.clk.filter((c) => now - c.at <= CLOCK_MAX_AGE_MS);
      const best = this.bestClock();
      if (best) {
        const slack = CLOCK_SLACK_MS + CLOCK_DRIFT * (now - best.at);
        if (Math.abs(off - best.off) > u + best.u + slack) {
          // intervalos disjuntos: o relógio do celular saltou (dormiu/acordou) ou mudou de base → recomeça
          this.clk = [];
          this.jumps++;
        }
      }
      this.clk.push({ rtt, off, u, at: now });
      if (this.clk.length > CLOCK_WINDOW) this.clk.shift();
    }
    return true;
  }

  private bestClock() {
    let best: ClockSample | null = null;
    for (const c of this.clk) if (!best || c.u < best.u) best = c;
    return best;
  }

  /** Offset de relógio pelo ping de menor incerteza (= menor RTT − pq) (null = app sem `pm` ou ainda sem pong). */
  clockOffset(): ClockOffset | null {
    const best = this.bestClock();
    if (!best) return null;
    return { offsetMs: best.off, uncertaintyMs: best.u, rttMs: best.rtt, n: this.clk.length, jumps: this.jumps };
  }

  /** Conexão nova: esquece tudo. */
  reset() {
    this.rtts = [];
    this.apps = [];
    this.lastD = -1;
    this.outstanding.clear();
    this.clk = [];
    this.jumps = 0;
  }

  summary(): LinkSummary | null {
    if (!this.rtts.length) return null;
    const s = [...this.rtts].sort((a, b) => a - b);
    const q = (p: number) => s[Math.min(s.length - 1, Math.round((s.length - 1) * p))];
    const a = [...this.apps].sort((x, y) => x - y);
    const appMs = a[Math.floor((a.length - 1) / 2)];
    const rttP50 = q(0.5);
    return { n: s.length, rttP50, rttP95: q(0.95), rttMax: s[s.length - 1], appMs, phoneDispatchMs: this.lastD, keyToPhoneMs: rttP50 / 2 + appMs };
  }
}

/** Texto curto para a barra: "RTT 3,1 ms (p95 4,0 · máx 6,2) · tecla→celular ≈ 1,6 ms · celular→toque 2,0 ms". */
export function linkText(s: LinkSummary | null): string {
  if (!s) return "Enlace: —";
  const f = (v: number) => v.toFixed(1).replace(".", ",");
  const d = s.phoneDispatchMs >= 0 ? ` · celular→toque ${f(s.phoneDispatchMs)} ms` : "";
  return `Enlace: RTT ${f(s.rttP50)} ms (p95 ${f(s.rttP95)} · máx ${f(s.rttMax)}) · tecla→celular ≈ ${f(s.keyToPhoneMs)} ms${d}`;
}
