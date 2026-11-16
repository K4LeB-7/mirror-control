import { CtrlMessage } from "./protocol";
import { DEFAULT_SIGNALING, Signaling, SignalMessage } from "./signaling";

export type SessionState = {
  signaling: "connecting" | "open" | "closed" | "error";
  peer: "waiting" | "connecting" | "connected" | "disconnected" | "failed";
  error?: string;
  /** Últimos eventos (mais novos por último) para diagnóstico na tela. */
  log: string[];
};

type Listeners = {
  onState: (s: SessionState) => void;
  onStream: (s: MediaStream | null) => void;
};

function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  const url = process.env.NEXT_PUBLIC_TURN_URL;
  if (url) {
    servers.push({
      urls: url,
      username: process.env.NEXT_PUBLIC_TURN_USER,
      credential: process.env.NEXT_PUBLIC_TURN_PASS,
    });
  }
  return servers;
}

/**
 * Lado "notebook". Fica aguardando a OFFER do celular (que tem a track de vídeo
 * e cria os DataChannels), responde com ANSWER e expõe o stream + canais.
 */
export class RemoteSession {
  private signaling: Signaling;
  private pc: RTCPeerConnection | null = null;
  private peerId: string | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  /** Candidatos que chegaram antes da OFFER do mesmo celular (src → lista). */
  private earlyCandidates = new Map<string, RTCIceCandidateInit[]>();
  /** "sid" da oferta atual (app >= 0.1.4); devolvido no ANSWER/CANDIDATE. */
  private offerSid: unknown = undefined;
  /** Mensagens de sinalização são tratadas uma de cada vez, na ordem em que chegaram. */
  private queue: Promise<void> = Promise.resolve();
  private input: RTCDataChannel | null = null;
  private ctrl: RTCDataChannel | null = null;
  /** Último ctrl pedido enquanto o canal não estava aberto; enviado quando abrir. */
  private pendingCtrl: CtrlMessage | null = null;
  private state: SessionState = { signaling: "connecting", peer: "waiting", log: [] };

  constructor(public roomId: string, private l: Listeners) {
    this.signaling = new Signaling(
      DEFAULT_SIGNALING,
      roomId,
      (m) => {
        this.queue = this.queue.then(() => this.onSignal(m));
      },
      (s, detail) => {
        this.patch({ signaling: s, error: s === "error" ? detail : undefined });
        this.note(`Sinalização: ${s}${detail ? " — " + detail : ""}`);
      }
    );
    this.signaling.connect();
  }

  get inputReady() {
    return this.input?.readyState === "open";
  }

  sendInput(buf: ArrayBuffer) {
    if (this.input?.readyState === "open") this.input.send(buf);
  }

  sendCtrl(msg: CtrlMessage) {
    if (this.ctrl?.readyState === "open") {
      this.ctrl.send(JSON.stringify(msg));
      this.pendingCtrl = null;
    } else {
      this.pendingCtrl = msg;
    }
  }

  close() {
    this.signaling.close();
    this.teardownPc();
  }

  private patch(p: Partial<SessionState>) {
    this.state = { ...this.state, ...p };
    this.l.onState(this.state);
  }

  private note(msg: string) {
    const t = new Date().toLocaleTimeString("pt-BR");
    this.patch({ log: [...this.state.log, `${t}  ${msg}`].slice(-12) });
  }

  private async onSignal(m: SignalMessage) {
    try {
      if (m.type === "OFFER" && m.src && m.payload?.sdp) {
        // Só aceita o par que já está conectado ou, se livre, o primeiro que ofertar.
        const busy = this.pc && this.pc.connectionState === "connected";
        if (busy && m.src !== this.peerId) {
          this.earlyCandidates.delete(m.src);
          return;
        }
        this.note("Oferta recebida do celular");
        await this.handleOffer(m.src, m.payload);
      } else if (m.type === "CANDIDATE" && m.src && m.payload?.candidate !== undefined) {
        const { sid, ...cand } = m.payload;
        if (m.src === this.peerId && this.pc) {
          // Candidato de uma oferta anterior (app >= 0.1.4 manda "sid"): não é desta conexão.
          if (sid !== undefined && this.offerSid !== undefined && sid !== this.offerSid) return;
          if (this.pc.remoteDescription) await this.addCandidate(this.pc, cand);
          else this.pendingCandidates.push(cand);
        } else {
          // Chegou antes da OFFER (ou de um celular ainda desconhecido): guarda para quando ela vier.
          const list = this.earlyCandidates.get(m.src) ?? [];
          list.push(m.payload); // mantém o "sid" para filtrar quando a OFFER chegar
          this.earlyCandidates.set(m.src, list.slice(-50));
        }
      }
    } catch (e) {
      this.patch({ error: String(e) });
      this.note(`Erro: ${String(e)}`);
    }
  }

  /** Um candidato ruim (de outra negociação) não pode impedir o resto da negociação. */
  private async addCandidate(pc: RTCPeerConnection, c: RTCIceCandidateInit) {
    try {
      await pc.addIceCandidate(c);
    } catch (e) {
      console.warn("addIceCandidate falhou", e);
    }
  }

  private async handleOffer(src: string, offer: RTCSessionDescriptionInit) {
    this.teardownPc();
    this.peerId = src;
    this.offerSid = (offer as { sid?: unknown }).sid;
    const early = this.earlyCandidates.get(src) ?? [];
    this.earlyCandidates.clear();
    this.pendingCandidates = early
      .filter((c) => {
        const cs = (c as { sid?: unknown }).sid;
        return cs === undefined || this.offerSid === undefined || cs === this.offerSid;
      })
      .map(({ sid: _sid, ...c }: RTCIceCandidateInit & { sid?: unknown }) => c);
    this.patch({ peer: "connecting", error: undefined });

    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    this.pc = pc;

    const sid = this.offerSid;
    pc.onicecandidate = (ev) => {
      if (this.pc !== pc || !ev.candidate || !ev.candidate.candidate) return;
      this.signaling.send("CANDIDATE", src, sid === undefined ? ev.candidate.toJSON() : { ...ev.candidate.toJSON(), sid });
    };
    pc.ontrack = (ev) => {
      if (this.pc !== pc) return;
      this.note("Vídeo do celular recebido");
      ev.track.onunmute = () => this.pc === pc && this.note("Primeiros quadros de vídeo chegando");
      this.l.onStream(ev.streams[0] ?? new MediaStream([ev.track]));
    };
    pc.oniceconnectionstatechange = () => this.pc === pc && this.note(`ICE: ${pc.iceConnectionState}`);
    pc.ondatachannel = (ev) => {
      if (this.pc !== pc) return;
      if (ev.channel.label === "input") {
        ev.channel.binaryType = "arraybuffer";
        this.input = ev.channel;
      } else if (ev.channel.label === "ctrl") {
        const ch = ev.channel;
        this.ctrl = ch;
        const flush = () => {
          if (this.ctrl === ch && this.pendingCtrl) this.sendCtrl(this.pendingCtrl);
        };
        if (ch.readyState === "open") flush();
        else ch.addEventListener("open", flush);
      }
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      const s = pc.connectionState;
      this.note(`Conexão: ${s}`);
      if (s === "connected") this.patch({ peer: "connected" });
      else if (s === "disconnected") this.patch({ peer: "disconnected" });
      else if (s === "failed" || s === "closed") {
        this.patch({ peer: "failed" });
        this.l.onStream(null);
      }
    };

    await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
    if (this.pc !== pc) return; // outra OFFER chegou no meio do caminho
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const c of pending) await this.addCandidate(pc, c);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    if (this.pc !== pc) return;
    const desc = pc.localDescription!.toJSON();
    this.signaling.send("ANSWER", src, sid === undefined ? desc : { ...desc, sid });
    this.note("Resposta enviada ao celular");
  }

  private teardownPc() {
    this.input = null;
    this.ctrl = null;
    this.pendingCandidates = [];
    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }
  }
}
