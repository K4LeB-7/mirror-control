import { Action, type CtrlMessage, type PhoneVstat, type VideoMode, parsePhoneCtrl } from "./protocol.ts";
import type { ClockOffset } from "./linkProbe.ts";
import {
  BACKPRESSURE_GRACE_MS,
  BACKPRESSURE_LEGACY,
  BACKPRESSURE_LOWLAT,
  DEFAULT_DEC,
  type DecOptions,
  type VideoSummary,
  VideoMetrics,
  shouldDropForBackpressure,
  summarize,
} from "./videoStats.ts";
import {
  type FlashAckSample,
  type FlashResult,
  PulseDetector,
  flashRegion,
  matchPulses,
  meanLumaRGBA,
  summarizeFlash,
} from "./flashProbe.ts";
import { type ByteChannel, type ChannelOpener, UsbConnectError } from "./usbTransport.ts";
import {
  type Frame,
  FrameDecoder,
  FrameType,
  decodeText,
  encodeFrame,
  encodeText,
  hasNalType,
  parseVideoPayload,
} from "./usbWire.ts";

export type UsbInfo = { width: number; height: number; fps: number; codec: string };

export type UsbSessionState = {
  peer: "waiting" | "connecting" | "connected" | "disconnected" | "failed";
  /** Mensagem acionável para o usuário (PIN errado, adb ocupado, app parado…). */
  error?: string;
  /** Últimos eventos (mais novos por último) para diagnóstico na tela. */
  log: string[];
  /** Formato do vídeo (do INFO do celular); fica com o último valor durante a reconexão. */
  info?: UsbInfo;
};

type Listeners = {
  onState: (s: UsbSessionState) => void;
  /** CTRL do celular (JSON; app 0.3.0+: status de rotate/nav; 0.3.1+: caps). */
  onCtrl?: (text: string) => void;
  /** Conexão nova (antes do HELLO e do "caps" do celular). */
  onConnect?: () => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opções do UsbSession (diagnóstico). */
export type UsbSessionOptions = {
  /** `?dec=`: optimizeForLatency / hardwareAcceleration do VideoDecoder (padrão: lat1, no-preference). */
  dec?: DecOptions | null;
};

/** vstat mais velho que isto é ignorado (o app antigo nunca manda; o novo manda a ~1 Hz). */
const VSTAT_FRESH_MS = 3500;
/** Teste de latência: sem `end` do app em tanto tempo, termina com o que houver. */
const FLASH_TIMEOUT_MS = 7000;
/** Depois do `end` do app, espera os últimos quadros decodificados antes de fechar a conta. */
const FLASH_TAIL_MS = 400;

const FATAL: Record<string, string> = {
  PIN_INVALID: "PIN errado. Confira o PIN mostrado no app (\"PIN do modo USB\") e conecte de novo.",
  LOCKED: "Muitas tentativas com PIN errado: o app bloqueou novas tentativas por um tempo.",
  REPLACED: "Outra aba/navegador conectou ao celular com o PIN; esta foi desconectada.",
};

/**
 * Lado "notebook" do modo USB (ADB). Mesma superfície que o RemoteSession usa na UI (sendInput, sendCtrl, close,
 * estado + log), mas o vídeo vem como H.264 Annex B pelo protocolo de docs/USB_PROTOCOLO.md e é decodificado com
 * WebCodecs e desenhado num <canvas>. Reconecta sozinho se o cabo for solto e recolocado.
 */
export class UsbSession {
  private state: UsbSessionState = { peer: "connecting", log: [] };
  private channel: ByteChannel | null = null;
  private closed = false;
  private quality: CtrlMessage | null = null;
  /**
   * Fila de escrita (site 0.3.3): quadros esperando o write em andamento. Um write por vez no canal; o que chega
   * enquanto ele está em andamento sai TODO junto no próximo (um write ADB = um WRTE + transferências USB e, em
   * adbd sem "delayed ack", a espera do OKAY). Ordem estrita (FIFO único). Com o canal livre, o 1º quadro sai numa
   * microtarefa: tudo o que o mesmo evento gera (ex.: DOWN + MOVE do joystick) vai num write só, sem esperar
   * timer nem quadro.
   */
  private outQ: Uint8Array[] = [];
  private outBytes = 0;
  private writing = false;
  private flushQueued = false;
  /** Geração da fila: cada conexão nova começa com a fila vazia; um write antigo que termina depois não mexe nela. */
  private wgen = 0;

  private video: Extract<CtrlMessage, { type: "video" }> | null = null;
  /** Perfil de vídeo escolhido (efeito local): "lowlat" = desenho direto no output do decoder + contrapressão curta. */
  private videoMode: VideoMode = "legacy";
  private decOpts: DecOptions;

  /** Métricas de latência do vídeo (por quadro, sem alocação) e o último vstat do app (0.3.4+). */
  readonly metrics = new VideoMetrics();
  private vstat: PhoneVstat | null = null;
  private vstatAt = 0;
  private clock: (() => ClockOffset | null) | null = null;
  private lastFlash: FlashResult | null = null;
  private flash: {
    detector: PulseDetector;
    acks: FlashAckSample[];
    pulses: number;
    resolve: (r: FlashResult) => void;
    timer: ReturnType<typeof setTimeout>;
    startedAt: number;
  } | null = null;
  private sampleCtx: (CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) | null = null;
  private pendingOutAt = 0;
  private bpAt = 0;
  private bpDecodedAt = -1;
  private microQueued = false;

  private canvas: HTMLCanvasElement | null = null;
  private ctx2d: CanvasRenderingContext2D | null = null;
  private decoder: VideoDecoder | null = null;
  private decoderConfig: VideoDecoderConfig | null = null;
  private config: Uint8Array | null = null;
  private waitingKey = true;
  private pendingFrame: VideoFrame | null = null;
  private raf = 0;
  private lastKeyRequest = 0;
  private decodeErrors: number[] = [];
  private firstDrawn = false;

  /** Contadores para diagnóstico/testes. */
  readonly stats = {
    received: 0, decoded: 0, drawn: 0, dropped: 0, skipped: 0, keyRequests: 0, connects: 0, writes: 0, frames: 0, droppedMoves: 0,
    /** Contrapressão: descartes e reinícios do decoder; desenhos feitos no callback output (sem rAF) e no rAF. */
    bpResets: 0, directDraws: 0, rafDraws: 0,
  };

  /** Canal confiável e ordenado (TCP pelo ADB): a entrada dispensa redundância/keepalive/deadman. */
  readonly reliable = true;

  private opener: ChannelOpener;
  private pin: string;
  private l: Listeners;

  constructor(opener: ChannelOpener, pin: string, l: Listeners, opts: UsbSessionOptions = {}) {
    this.opener = opener;
    this.pin = pin;
    this.l = l;
    this.decOpts = opts.dec ?? DEFAULT_DEC;
    void this.run();
  }

  /** Quem fornece o offset de relógio navegador↔celular (LinkProbe.clockOffset do site). */
  setClock(fn: (() => ClockOffset | null) | null) {
    this.clock = fn;
  }

  private offsetMs(): number | null {
    // Idade/chegada só fazem sentido com o offset E com o relógio do PTS confirmado pelo app (vstat.clk != "unk").
    const v = this.vstat;
    if (!v || performance.now() - this.vstatAt > VSTAT_FRESH_MS || v.clk === "unk" || v.enc === null) return null;
    return this.clock?.()?.offsetMs ?? null;
  }

  /** Perfil de vídeo local (e o que foi pedido ao app). */
  get mode(): VideoMode {
    return this.videoMode;
  }

  get decoderOptions(): DecOptions {
    return this.decOpts;
  }

  /** Último vstat do app, se recente (null = app antigo/sem medição). */
  get phoneVstat(): PhoneVstat | null {
    const v = this.vstat;
    return v && performance.now() - this.vstatAt <= VSTAT_FRESH_MS ? v : null;
  }

  get lastFlashResult(): FlashResult | null {
    return this.lastFlash;
  }

  /** Resumo das métricas de vídeo (chamar ~1 Hz). */
  videoSummary(): VideoSummary {
    const v = this.phoneVstat;
    return summarize(this.metrics, v?.enc ? { ...v.enc, n: v.n } : null, v ? v.keyMaxKB : null, performance.now());
  }

  get snapshot() {
    return this.state;
  }

  get inputReady() {
    return this.state.peer === "connected";
  }

  /** Quadros esperando o USB: MOVE/LOOK esperam o próximo quadro de tela em vez de enfileirar. */
  congested() {
    return this.outQ.length > 8;
  }

  /** O mesmo pacote de 18 bytes do WebRTC, num quadro INPUT. MOVE/LOOK podem ser descartados se o USB engasgar. */
  sendInput(buf: ArrayBuffer) {
    if (this.state.peer !== "connected") return;
    const bytes = new Uint8Array(buf); // encodeFrame copia: o InputController reaproveita o buffer
    const a = bytes[0];
    this.write(encodeFrame(FrameType.INPUT, bytes), a === Action.MOVE || a === Action.LOOK);
  }

  sendCtrl(msg: CtrlMessage) {
    if (msg.type === "quality") this.quality = msg;
    if (msg.type === "video") {
      this.video = msg;
      this.videoMode = msg.mode; // vale já para os próximos quadros (desenho direto + limite da fila do decoder)
    }
    // Com o canal aberto (inclusive logo após o HELLO, antes do INFO) já pode ir; senão vai no próximo HELLO.
    if (this.channel) this.write(encodeText(FrameType.CTRL, JSON.stringify(msg)));
  }

  setCanvas(c: HTMLCanvasElement | null) {
    if (c === this.canvas) return;
    this.canvas = c;
    this.ctx2d = c ? c.getContext("2d", { alpha: false, desynchronized: true }) : null;
    this.sizeCanvas();
    if (this.pendingFrame) this.scheduleDraw();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.finishFlash("Sessão encerrada.");
    this.channel?.close();
    this.channel = null;
    this.resetVideo();
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.opener.dispose();
  }

  // ---------------------------------------------------------------- conexão

  private patch(p: Partial<UsbSessionState>) {
    this.state = { ...this.state, ...p };
    this.l.onState(this.state);
  }

  private note(msg: string) {
    const t = new Date().toLocaleTimeString("pt-BR");
    this.patch({ log: [...this.state.log, `${t}  ${msg}`].slice(-14) });
  }

  private async run() {
    let attempt = 0;
    while (!this.closed) {
      let ch: ByteChannel;
      try {
        ch = await this.opener.open((m) => !this.closed && this.note(m));
      } catch (e) {
        if (this.closed) return;
        const err = e instanceof UsbConnectError ? e : new UsbConnectError("OTHER", String(e));
        if (err.message !== this.state.error) this.note(err.message);
        this.patch({ error: err.message, peer: err.fatal ? "failed" : attempt ? "disconnected" : "connecting" });
        if (err.fatal) return;
        attempt++;
        await sleep(err.code === "BUSY" ? 3000 : 1500);
        continue;
      }
      if (this.closed) {
        ch.close();
        return;
      }
      this.resetOut();
      this.channel = ch;
      this.stats.connects++;
      const fatal = await this.serve(ch);
      if (this.channel === ch) {
        this.channel = null;
        this.resetOut();
      }
      ch.close();
      this.resetVideo();
      if (this.closed) return;
      if (fatal) {
        this.note(fatal);
        this.patch({ peer: "failed", error: fatal });
        this.opener.dispose(); // libera o aparelho: o usuário vai conectar de novo com outro PIN
        return;
      }
      attempt++;
      this.patch({ peer: "disconnected" });
      this.note("Conexão USB caiu; reconectando…");
      await sleep(1000);
    }
  }

  /** Atende uma conexão até ela cair. Devolve a mensagem de erro se não for para reconectar. */
  private async serve(ch: ByteChannel): Promise<string | undefined> {
    this.note("Conectado ao app pelo ADB; enviando o PIN…");
    this.l.onConnect?.();
    this.write(encodeText(FrameType.HELLO, this.pin));
    if (this.quality) this.write(encodeText(FrameType.CTRL, JSON.stringify(this.quality)));
    if (this.video) this.write(encodeText(FrameType.CTRL, JSON.stringify(this.video))); // app/site antigos ignoram
    const slow = setTimeout(() => this.note("O app ainda não respondeu ao PIN (tela do celular bloqueada?)"), 8000);
    const decoder = new FrameDecoder(true); // payloads são vistas do pedaço lido: usados/copiados na hora (onFrame)
    this.vstat = null;
    this.metrics.reset();
    try {
      for (;;) {
        const chunk = await ch.read();
        if (!chunk || this.closed) return undefined;
        let frames: Frame[];
        try {
          frames = decoder.push(chunk);
        } catch (e) {
          this.note(`Erro de protocolo: ${String(e)}`);
          return undefined;
        }
        for (const f of frames) {
          if (f.type === FrameType.INFO) clearTimeout(slow);
          const fatal = this.onFrame(f);
          if (fatal !== undefined) return fatal || undefined;
        }
      }
    } finally {
      clearTimeout(slow);
      this.finishFlash("A conexão USB caiu durante o teste.");
    }
  }

  /** undefined = continua; "" = fecha e reconecta; texto = fecha sem reconectar (mostra o texto). */
  private onFrame(f: Frame): string | undefined {
    switch (f.type) {
      case FrameType.INFO: {
        let info: UsbInfo;
        try {
          const j = JSON.parse(decodeText(f.payload));
          info = { width: Number(j.width), height: Number(j.height), fps: Number(j.fps), codec: String(j.codec) };
          if (!(info.width > 0 && info.height > 0) || !/^avc1\.[0-9A-Fa-f]{6}$/.test(info.codec)) throw new Error("campos inválidos");
        } catch (e) {
          this.note(`INFO inválido do celular: ${String(e)}`);
          return "";
        }
        if (this.state.peer !== "connected") this.note("PIN aceito ✔");
        this.note(`Vídeo ${info.width}×${info.height} ${info.fps} fps (${info.codec})`);
        this.patch({ peer: "connected", error: undefined, info });
        this.setupDecoder(info);
        return undefined;
      }
      case FrameType.VIDEO_CONFIG:
        this.config = f.payload.slice(); // o payload é uma vista do pedaço lido: guarda uma cópia
        return undefined;
      case FrameType.VIDEO_KEY:
      case FrameType.VIDEO_DELTA:
        this.stats.received++;
        this.decodeVideo(f.type === FrameType.VIDEO_KEY, f.payload);
        return undefined;
      case FrameType.ERROR: {
        const text = decodeText(f.payload);
        const code = text.split(":")[0].trim();
        this.note(`Celular recusou: ${text}`);
        if (FATAL[code]) return `${FATAL[code]} (${text})`;
        return "";
      }
      case FrameType.CTRL: {
        const text = decodeText(f.payload);
        this.onPhoneCtrl(text);
        this.l.onCtrl?.(text);
        return undefined;
      }
      default:
        return undefined; // tipos futuros: ignorados
    }
  }

  private write(bytes: Uint8Array, droppable = false) {
    if (!this.channel) return;
    if (droppable && this.outQ.length > 32) {
      this.stats.droppedMoves++; // USB engasgado: perde um MOVE/LOOK, nunca DOWN/UP
      return;
    }
    this.outQ.push(bytes);
    this.outBytes += bytes.length;
    if (!this.writing && !this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(this.flush);
    }
  }

  private resetOut() {
    this.wgen++;
    this.writing = false;
    this.outQ = [];
    this.outBytes = 0;
  }

  private flush = () => {
    this.flushQueued = false;
    const ch = this.channel;
    if (this.writing || !this.outQ.length) return;
    if (!ch) {
      this.outQ = [];
      this.outBytes = 0;
      return;
    }
    let buf: Uint8Array;
    if (this.outQ.length === 1) buf = this.outQ[0];
    else {
      buf = new Uint8Array(this.outBytes);
      let o = 0;
      for (const b of this.outQ) {
        buf.set(b, o);
        o += b.length;
      }
    }
    this.stats.frames += this.outQ.length;
    this.stats.writes++;
    this.outQ = [];
    this.outBytes = 0;
    this.writing = true;
    const g = this.wgen;
    const done = () => {
      if (g !== this.wgen) return; // conexão antiga
      this.writing = false;
      if (this.outQ.length) this.flush(); // o que chegou durante o write sai já, junto
    };
    let p: Promise<void>;
    try {
      p = ch.write(buf);
    } catch {
      done();
      return;
    }
    p.then(done, done); // erro: a leitura percebe a queda e reconecta
  };

  // ---------------------------------------------------------------- vídeo

  private setupDecoder(info: UsbInfo) {
    this.closeDecoder();
    this.waitingKey = true;
    this.sizeCanvas();
    if (typeof VideoDecoder === "undefined") {
      this.patch({ error: "Este navegador não tem WebCodecs (VideoDecoder). Use o Chrome ou o Edge atualizados." });
      return;
    }
    // Sem `description`: o fluxo é Annex B (SPS/PPS em banda, juntados a cada quadro-chave).
    // `?dec=` (diagnóstico) troca optimizeForLatency/hardwareAcceleration; o padrão é o da 0.3.3.
    const cfg: VideoDecoderConfig = {
      codec: info.codec,
      optimizeForLatency: this.decOpts.optimizeForLatency,
      hardwareAcceleration: this.decOpts.hardwareAcceleration,
    };
    this.decoderConfig = cfg;
    this.metrics.onDecoderReset();
    const d = new VideoDecoder({
      output: (frame) => this.onDecoded(d, frame),
      error: (e) => this.onDecodeError(d, e),
    });
    this.decoder = d;
    try {
      d.configure(cfg);
    } catch (e) {
      this.onDecodeError(d, e);
    }
  }

  private decodeVideo(key: boolean, payload: Uint8Array) {
    const d = this.decoder;
    if (!d || d.state !== "configured") return;
    const { ptsUs, data } = parseVideoPayload(payload);
    const now = performance.now();
    this.metrics.onArrive(payload.length, key);
    if (!key) {
      if (this.waitingKey) {
        this.stats.dropped++;
        this.requestKeyFrame();
        return;
      }
      const cfg = this.videoMode === "lowlat" ? BACKPRESSURE_LOWLAT : BACKPRESSURE_LEGACY;
      const progressed = this.stats.decoded > this.bpDecodedAt || now - this.bpAt > BACKPRESSURE_GRACE_MS;
      if (shouldDropForBackpressure(d.decodeQueueSize, this.metrics.oldestPendingWaitMs(now), cfg, progressed)) {
        // Decodificador atrasado: joga fora o que está na fila e espera um quadro-chave novo. Contado: a fila nunca
        // cresce em silêncio (stats.bpResets / metrics.backpressureDrops no diagnóstico).
        this.stats.dropped++;
        this.stats.bpResets++;
        this.metrics.backpressureDrops += d.decodeQueueSize + 1;
        this.metrics.backpressureResets++;
        this.bpAt = now;
        this.bpDecodedAt = this.stats.decoded;
        d.reset();
        d.configure(this.decoderConfig!);
        this.metrics.onDecoderReset();
        this.waitingKey = true;
        this.requestKeyFrame();
        return;
      }
    }
    let chunk = data;
    if (key && this.config && !hasNalType(data, 7)) {
      chunk = new Uint8Array(this.config.length + data.length);
      chunk.set(this.config);
      chunk.set(data, this.config.length);
    }
    try {
      d.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: ptsUs, data: chunk }));
      this.metrics.onSubmit(ptsUs, now, d.decodeQueueSize, this.offsetMs());
      if (key) this.waitingKey = false;
    } catch (e) {
      this.onDecodeError(d, e);
    }
  }

  private onDecodeError(d: VideoDecoder, e: unknown) {
    if (d !== this.decoder) return;
    const now = performance.now();
    this.decodeErrors = [...this.decodeErrors.filter((t) => now - t < 10_000), now];
    this.note(`Erro no decodificador de vídeo: ${String(e)}`);
    this.closeDecoder();
    const info = this.state.info;
    if (this.decodeErrors.length > 5) {
      this.patch({
        error: `O navegador não está conseguindo decodificar o H.264 (${info?.codec}). Atualize o Chrome/Edge ou tente 720p.`,
      });
      return;
    }
    if (info) {
      this.setupDecoder(info); // recria e espera o próximo quadro-chave
      this.requestKeyFrame();
    }
  }

  private requestKeyFrame() {
    const now = performance.now();
    if (now - this.lastKeyRequest < 500) return;
    this.lastKeyRequest = now;
    this.stats.keyRequests++;
    this.write(encodeText(FrameType.CTRL, JSON.stringify({ type: "keyframe" })));
  }

  private onDecoded(d: VideoDecoder, frame: VideoFrame) {
    if (d !== this.decoder) {
      frame.close();
      return;
    }
    this.stats.decoded++;
    const now = performance.now();
    this.metrics.onOutput(frame.timestamp, now);
    if (this.pendingFrame) {
      this.pendingFrame.close(); // só o quadro mais novo é desenhado
      this.stats.skipped++;
    }
    this.pendingFrame = frame;
    this.pendingOutAt = now;
    this.scheduleDraw();
  }

  /**
   * Baixa latência: desenha no microtask do próprio callback `output` do decoder (sem esperar o rAF, que custa de 0 a
   * 1 quadro do monitor); se vários quadros saírem no MESMO tick só o último é desenhado. Trade-off: pode desenhar mais
   * de uma vez por quadro do monitor (os desenhos extras são sobrescritos antes de aparecer; o canvas é desynchronized,
   * então o Chrome apresenta o último sem esperar o vsync). Padrão (0.3.3): um desenho por rAF.
   */
  private scheduleDraw() {
    if (!this.ctx2d) return;
    if (this.videoMode === "lowlat") {
      if (this.microQueued) return;
      this.microQueued = true;
      queueMicrotask(this.drawDirect);
    } else if (!this.raf) this.raf = requestAnimationFrame(this.draw);
  }

  private drawDirect = () => {
    this.microQueued = false;
    if (!this.pendingFrame) return;
    this.stats.directDraws++;
    this.drawPending();
  };

  private draw = () => {
    this.raf = 0;
    if (!this.pendingFrame) return;
    this.stats.rafDraws++;
    this.drawPending();
  };

  private drawPending() {
    const f = this.pendingFrame;
    this.pendingFrame = null;
    if (!f) return;
    const outAt = this.pendingOutAt;
    const c = this.canvas;
    if (c && this.ctx2d) {
      this.ctx2d.drawImage(f, 0, 0, c.width, c.height);
      const tDraw = performance.now();
      this.stats.drawn++;
      this.metrics.onDraw(f.timestamp, outAt, tDraw, this.offsetMs());
      if (this.flash) this.sampleFlash(f, tDraw);
      if (!this.firstDrawn) {
        this.firstDrawn = true;
        this.note("Primeiros quadros de vídeo na tela");
      }
    }
    f.close();
  }

  // ---------------------------------------------------------------- vstat e teste de latência do vídeo

  /** CTRL do celular que a sessão consome (o resto segue para o onCtrl da página). */
  private onPhoneCtrl(text: string) {
    if (text.indexOf('"vstat"') < 0 && text.indexOf('"flashAck"') < 0 && text.indexOf('"flash"') < 0) return;
    const m = parsePhoneCtrl(text);
    if (!m) return;
    if (m.type === "vstat") {
      this.vstat = m;
      this.vstatAt = performance.now();
    } else if (m.type === "flashAck" && this.flash) {
      if (m.end) setTimeout(() => this.finishFlash(), FLASH_TAIL_MS);
      else this.flash.acks.push({ n: m.n, pm: m.pm });
    } else if (m.type === "status" && m.scope === "flash" && !m.ok) {
      this.finishFlash(m.text);
    }
  }

  /**
   * "Medir latência do vídeo": o app pisca um quadrado no canto da tela e responde `flashAck` por pulso branco; aqui
   * detectamos o pulso na luminância do canto dos quadros decodificados, no instante do desenho. Resolve sempre (com
   * `ok:false` e `error` quando não deu).
   */
  startFlashTest(): Promise<FlashResult> {
    const fail = (error: string): FlashResult => ({ ok: false, error, latencies: [], median: 0, min: 0, max: 0, n: 0, pulses: 0, uncertaintyMs: 0, offsetMs: null, at: Date.now() });
    if (this.state.peer !== "connected" || !this.channel) return Promise.resolve(fail("Conecte pelo USB antes de medir."));
    if (this.flash) return Promise.resolve(fail("Já há uma medição em andamento."));
    if (!this.clock?.()) {
      return Promise.resolve(
        fail("Relógio do celular ainda não sincronizado: o teste precisa do app 0.3.4+ (pong com relógio). Aguarde alguns segundos; se a mensagem não sumir, atualize o app.")
      );
    }
    return new Promise<FlashResult>((resolve) => {
      const timer = setTimeout(() => this.finishFlash(), FLASH_TIMEOUT_MS);
      this.flash = { detector: new PulseDetector(), acks: [], pulses: 5, resolve, timer, startedAt: performance.now() };
      this.write(encodeText(FrameType.CTRL, JSON.stringify({ type: "flash" })));
    });
  }

  private finishFlash(error?: string) {
    const fl = this.flash;
    if (!fl) return;
    this.flash = null;
    clearTimeout(fl.timer);
    const clk = this.clock?.() ?? null;
    let res: FlashResult;
    if (error) res = { ok: false, error, latencies: [], median: 0, min: 0, max: 0, n: 0, pulses: fl.pulses, uncertaintyMs: clk?.uncertaintyMs ?? 0, offsetMs: clk?.offsetMs ?? null, at: Date.now() };
    else if (!fl.acks.length) {
      res = { ok: false, error: "O app não respondeu ao teste (app anterior à 0.3.4?). Atualize o app para medir a latência do vídeo.", latencies: [], median: 0, min: 0, max: 0, n: 0, pulses: fl.pulses, uncertaintyMs: clk?.uncertaintyMs ?? 0, offsetMs: clk?.offsetMs ?? null, at: Date.now() };
    } else if (!clk) {
      res = { ok: false, error: "Sem sincronismo de relógio ao fechar a conta.", latencies: [], median: 0, min: 0, max: 0, n: 0, pulses: fl.pulses, uncertaintyMs: 0, offsetMs: null, at: Date.now() };
    } else {
      const { pairs } = matchPulses(fl.detector.edges, fl.acks, clk.offsetMs);
      res = summarizeFlash(pairs, fl.acks.length, clk.uncertaintyMs, clk.offsetMs, Date.now());
      if (!res.ok) {
        res.error = `Só ${pairs.length} de ${fl.acks.length} pulsos apareceram no vídeo (luminância do canto: ${Math.round(fl.detector.minLuma)}–${Math.round(fl.detector.maxLuma)}). O quadrado branco pode não estar entrando na captura de tela.`;
      }
    }
    this.lastFlash = res;
    fl.resolve(res);
  }

  /** Luminância do miolo do quadrado no canto do quadro decodificado (só durante o teste: ~1 ms por quadro). */
  private sampleFlash(f: VideoFrame, tDraw: number) {
    const fl = this.flash;
    if (!fl) return;
    try {
      if (!this.sampleCtx) {
        const cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(8, 8) : Object.assign(document.createElement("canvas"), { width: 8, height: 8 });
        this.sampleCtx = cv.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
      }
      const g = this.sampleCtx;
      const r = flashRegion(f.displayWidth, f.displayHeight);
      g.drawImage(f, r.x, r.y, r.w, r.h, 0, 0, 8, 8);
      fl.detector.push(tDraw, meanLumaRGBA(g.getImageData(0, 0, 8, 8).data));
    } catch {
      // sem amostra neste quadro (ex.: quadro já fechado): o teste termina por tempo
    }
  }

  /** Diagnóstico bruto da sessão (usado por "Copiar diagnóstico"). */
  diagnostics() {
    return {
      mode: this.videoMode,
      decoder: this.decoderConfig,
      stats: { ...this.stats },
      canvas: this.canvas ? { w: this.canvas.width, h: this.canvas.height } : null,
      info: this.state.info ?? null,
      clock: this.clock?.() ?? null,
      lastFlash: this.lastFlash,
    };
  }

  private sizeCanvas() {
    const c = this.canvas;
    const info = this.state.info;
    if (!c || !info) return;
    if (c.width !== info.width) c.width = info.width;
    if (c.height !== info.height) c.height = info.height;
  }

  private closeDecoder() {
    const d = this.decoder;
    this.decoder = null;
    if (d && d.state !== "closed") {
      try {
        d.close();
      } catch {}
    }
  }

  private resetVideo() {
    this.closeDecoder();
    this.metrics.onDecoderReset();
    this.pendingFrame?.close();
    this.pendingFrame = null;
    this.config = null;
    this.waitingKey = true;
  }
}
