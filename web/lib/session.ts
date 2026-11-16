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
  private input: RTCDataChannel | null = null;
  private ctrl: RTCDataChannel | null = null;
  private state: SessionState = { signaling: "connecting", peer: "waiting", log: [] };

  constructor(public roomId: string, private l: Listeners) {
    this.signaling = new Signaling(
      DEFAULT_SIGNALING,
      roomId,
      (m) => this.onSignal(m),
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
    if (this.ctrl?.readyState === "open") this.ctrl.send(JSON.stringify(msg));
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
      if (m.type === "OFFER" && m.src) {
        // Só aceita o par que já está conectado ou, se livre, o primeiro que ofertar.
        const busy = this.pc && this.pc.connectionState === "connected";
        if (busy && m.src !== this.peerId) return;
        this.note("Oferta recebida do celular");
        await this.handleOffer(m.src, m.payload);
      } else if (m.type === "CANDIDATE" && m.src === this.peerId && m.payload) {
        if (this.pc?.remoteDescription) await this.pc.addIceCandidate(m.payload);
        else this.pendingCandidates.push(m.payload);
      }
    } catch (e) {
      this.patch({ error: String(e) });
    }
  }

  private async handleOffer(src: string, offer: RTCSessionDescriptionInit) {
    this.teardownPc();
    this.peerId = src;
    this.patch({ peer: "connecting", error: undefined });

    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    this.pc = pc;

    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.signaling.send("CANDIDATE", src, ev.candidate.toJSON());
    };
    pc.ontrack = (ev) => {
      this.note("Vídeo do celular recebido");
      this.l.onStream(ev.streams[0] ?? new MediaStream([ev.track]));
    };
    pc.oniceconnectionstatechange = () => this.note(`ICE: ${pc.iceConnectionState}`);
    pc.ondatachannel = (ev) => {
      if (ev.channel.label === "input") {
        ev.channel.binaryType = "arraybuffer";
        this.input = ev.channel;
      } else if (ev.channel.label === "ctrl") {
        this.ctrl = ev.channel;
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

    await pc.setRemoteDescription(offer);
    for (const c of this.pendingCandidates) await pc.addIceCandidate(c);
    this.pendingCandidates = [];
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.signaling.send("ANSWER", src, pc.localDescription!.toJSON());
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
