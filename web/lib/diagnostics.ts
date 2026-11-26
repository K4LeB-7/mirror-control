import type { FlashResult } from "./flashProbe.ts";
import type { ClockOffset, LinkSummary } from "./linkProbe.ts";
import type { PhoneVstat } from "./protocol.ts";
import { decText, type DecOptions, type VideoSummary } from "./videoStats.ts";

/**
 * "Copiar diagnóstico": reúne TODAS as métricas (entrada + vídeo + perfis + resolução/fps/bitrate + versões) num JSON
 * para o usuário colar numa conversa. Módulo PURO (testado em tests/videoLatency.test.ts). Sem dados pessoais: nada de
 * PIN, número de série, sala ou URL.
 */
export type DiagInput = {
  siteVersion: string;
  userAgent: string;
  transport: "usb" | "webrtc";
  quality: { height: number; fps: number };
  fluidity: string;
  phoneFluidity: string;
  videoMode: string;
  dec: DecOptions;
  info: { width: number; height: number; fps: number; codec: string } | null;
  link: LinkSummary | null;
  clock: ClockOffset | null;
  video: VideoSummary | null;
  vstat: PhoneVstat | null;
  session: Record<string, unknown> | null;
  flash: FlashResult | null;
  adb: Record<string, unknown> | null;
  now: Date;
};

const r1 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const pct = (p: { p50: number; p95: number; max: number; n?: number } | null) => (p ? { p50: r1(p.p50), p95: r1(p.p95), max: r1(p.max), n: p.n ?? null } : null);

export function buildDiagnostics(i: DiagInput) {
  const v = i.video;
  const f = i.flash;
  const resumo: string[] = [
    `Mirror Control site ${i.siteVersion} · app ${i.vstat?.mode !== undefined ? "0.3.4+" : "sem vstat (anterior à 0.3.4?)"} · ${i.transport.toUpperCase()}`,
    i.info ? `Vídeo ${i.info.width}×${i.info.height} @ ${i.info.fps} fps (${i.info.codec}), qualidade pedida ${i.quality.height}p${i.quality.fps}` : "Sem INFO de vídeo",
    `Perfil de vídeo: ${i.videoMode} · decodificador ${decText(i.dec)} · fluidez ${i.fluidity} (celular: ${i.phoneFluidity})`,
    v?.age
      ? `Idade do quadro na tela p50/p95/máx: ${r1(v.age.p50)}/${r1(v.age.p95)}/${r1(v.age.max)} ms · cod. ${r1(v.enc?.p50)} · cabo+fila ${r1(v.cableQueueMs)} · decod. ${r1(v.decode?.p50)} · espera de desenho ${r1(v.drawWait?.p50)}`
      : "Idade do quadro na tela: — (app sem vstat, relógio do celular não sincronizado ou PTS não confirmado)",
    f?.ok ? `Latência real do vídeo (flash): mediana ${r1(f.median)} ms (mín ${r1(f.min)} · máx ${r1(f.max)} · ${f.n}/${f.pulses} pulsos)` : f ? `Teste de flash falhou: ${f.error}` : "Teste de flash: não executado",
    i.link ? `Entrada: RTT ${r1(i.link.rttP50)} ms (p95 ${r1(i.link.rttP95)}) · tecla→celular ≈ ${r1(i.link.keyToPhoneMs)} ms · celular→toque ${i.link.phoneDispatchMs >= 0 ? r1(i.link.phoneDispatchMs) + " ms" : "—"}` : "Entrada (ping/pong): —",
  ];
  return {
    resumo,
    geradoEm: i.now.toISOString(),
    site: { versao: i.siteVersion, navegador: i.userAgent },
    app: i.vstat
      ? { modo: i.vstat.mode, nivelEncoder: i.vstat.tier, chaveRecusada: i.vstat.rej || null, relogioPts: i.vstat.clk, gopSegundos: i.vstat.gop, bitrateAlvoKbps: i.vstat.targetKbps, fpsAlvo: i.vstat.capFps }
      : null,
    transporte: i.transport,
    qualidade: i.quality,
    video: {
      info: i.info,
      perfil: i.videoMode,
      decodificador: { opcoes: decText(i.dec), ...i.dec },
      idadeNaTelaMs: pct(v?.age ?? null),
      codificacaoNoCelularMs: pct(v?.enc ?? null),
      chegadaDesdeCapturaMs: pct(v?.arrive ?? null),
      caboMaisFilaMs: r1(v?.cableQueueMs),
      decodificacaoMs: pct(v?.decode ?? null),
      esperaDesenhoMs: pct(v?.drawWait ?? null),
      caboMaisDecodMs: r1(v?.cableDecMs),
      filaDecoder: { agora: v?.queueNow ?? null, pico: v?.queuePeak ?? null },
      descartesPorContrapressao: { quadros: v?.backpressureDrops ?? null, reinicios: v?.backpressureResets ?? null },
      fps: v ? { recebido: r1(v.rates.recvFps), decodificado: r1(v.rates.decFps), desenhado: r1(v.rates.drawFps) } : null,
      bitrateRecebidoKbps: r1(v?.rates.kbps),
      maiorQuadroChaveKB: { navegador: r1(v?.keyMaxKB), celular: r1(v?.keyMaxKBPhone) },
      vstatDoApp: i.vstat
        ? {
            seq: i.vstat.seq, fps: i.vstat.fps, kbps: i.vstat.kbps, filaSaidaMs: pct(i.vstat.q), writeMs: pct(i.vstat.wr),
            queueDrops: i.vstat.queueDrops, queueOverflows: i.vstat.queueOverflows, queuePeak: i.vstat.queuePeak,
            versaoApp: i.vstat.ver || null,
          }
        : null,
      sessao: i.session,
    },
    relogio: i.clock
      ? { offsetMs: r1(i.clock.offsetMs), incertezaMs: r1(i.clock.uncertaintyMs), rttMinMs: r1(i.clock.rttMs), amostras: i.clock.n }
      : null,
    entrada: i.link
      ? { rttMs: { p50: r1(i.link.rttP50), p95: r1(i.link.rttP95), max: r1(i.link.rttMax) }, teclaParaCelularMs: r1(i.link.keyToPhoneMs), celularParaToqueMs: i.link.phoneDispatchMs >= 0 ? r1(i.link.phoneDispatchMs) : null, appMs: r1(i.link.appMs), amostras: i.link.n }
      : null,
    fluidez: { site: i.fluidity, celular: i.phoneFluidity },
    testeFlash: f
      ? { ok: f.ok, erro: f.error ?? null, medianaMs: r1(f.median), minMs: r1(f.min), maxMs: r1(f.max), pulsosMedidos: f.n, pulsosPedidos: f.pulses, porPulsoMs: f.latencies.map((x) => r1(x)), incertezaRelogioMs: r1(f.uncertaintyMs), quando: new Date(f.at).toISOString() }
      : null,
    adb: i.adb,
  };
}

export const diagnosticsText = (d: ReturnType<typeof buildDiagnostics>) => JSON.stringify(d, null, 2);
