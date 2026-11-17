import { Action, CtrlMessage } from "./protocol";
import { ByteChannel, ChannelOpener, UsbConnectError } from "./usbTransport";
import {
  Frame,
  FrameDecoder,
  FrameType,
  decodeText,
  encodeFrame,
  encodeText,
  hasNalType,
  parseVideoPayload,
} from "./usbWire";

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
  /** CTRL do celular (JSON; app 0.3.0+: status de rotate/nav). */
  onCtrl?: (text: string) => void;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  private writeChain: Promise<void> = Promise.resolve();
  private pendingWrites = 0;

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
  readonly stats = { received: 0, decoded: 0, drawn: 0, dropped: 0, skipped: 0, keyRequests: 0, connects: 0 };

  constructor(private opener: ChannelOpener, private pin: string, private l: Listeners) {
    void this.run();
  }

  get snapshot() {
    return this.state;
  }

  get inputReady() {
    return this.state.peer === "connected";
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
    // Com o canal aberto (inclusive logo após o HELLO, antes do INFO) já pode ir; senão vai no próximo HELLO.
    if (this.channel) this.write(encodeText(FrameType.CTRL, JSON.stringify(msg)));
  }

  setCanvas(c: HTMLCanvasElement | null) {
    if (c === this.canvas) return;
    this.canvas = c;
    this.ctx2d = c ? c.getContext("2d", { alpha: false, desynchronized: true }) : null;
    this.sizeCanvas();
    if (this.pendingFrame && !this.raf) this.raf = requestAnimationFrame(this.draw);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
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
      this.channel = ch;
      this.stats.connects++;
      const fatal = await this.serve(ch);
      if (this.channel === ch) this.channel = null;
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
    this.write(encodeText(FrameType.HELLO, this.pin));
    if (this.quality) this.write(encodeText(FrameType.CTRL, JSON.stringify(this.quality)));
    const slow = setTimeout(() => this.note("O app ainda não respondeu ao PIN (tela do celular bloqueada?)"), 8000);
    const decoder = new FrameDecoder();
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
        this.config = f.payload;
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
      case FrameType.CTRL:
        this.l.onCtrl?.(decodeText(f.payload));
        return undefined;
      default:
        return undefined; // tipos futuros: ignorados
    }
  }

  private write(bytes: Uint8Array, droppable = false) {
    const ch = this.channel;
    if (!ch) return;
    if (droppable && this.pendingWrites > 32) return; // USB engasgado: perde um MOVE/LOOK, nunca DOWN/UP
    this.pendingWrites++;
    this.writeChain = this.writeChain
      .then(() => (this.channel === ch ? ch.write(bytes) : undefined))
      .catch(() => {}) // a leitura percebe a queda e reconecta
      .finally(() => this.pendingWrites--);
  }

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
    const cfg: VideoDecoderConfig = { codec: info.codec, optimizeForLatency: true, hardwareAcceleration: "no-preference" };
    this.decoderConfig = cfg;
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
    if (!key) {
      if (this.waitingKey) {
        this.stats.dropped++;
        this.requestKeyFrame();
        return;
      }
      if (d.decodeQueueSize > 6) {
        // Decodificador atrasado: joga fora o que está na fila e espera um quadro-chave novo.
        this.stats.dropped++;
        d.reset();
        d.configure(this.decoderConfig!);
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
    if (this.pendingFrame) {
      this.pendingFrame.close(); // só o quadro mais novo é desenhado
      this.stats.skipped++;
    }
    this.pendingFrame = frame;
    if (!this.raf && this.ctx2d) this.raf = requestAnimationFrame(this.draw);
  }

  private draw = () => {
    this.raf = 0;
    const f = this.pendingFrame;
    this.pendingFrame = null;
    if (!f) return;
    const c = this.canvas;
    if (c && this.ctx2d) {
      this.ctx2d.drawImage(f, 0, 0, c.width, c.height);
      this.stats.drawn++;
      if (!this.firstDrawn) {
        this.firstDrawn = true;
        this.note("Primeiros quadros de vídeo na tela");
      }
    }
    f.close();
  };

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
    this.pendingFrame?.close();
    this.pendingFrame = null;
    this.config = null;
    this.waitingKey = true;
  }
}
