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
  /** Mensagem JSON do celular no canal "ctrl" (app 0.3.0+: status de rotate/nav; 0.3.1+: caps). */
  onCtrl?: (text: string) => void;
  /** Canal ctrl de uma conexão nova apareceu (antes do "caps" do celular). */
  onConnect?: () => void;
};

/** Acima disto (bytes na fila do canal "input") MOVE/LOOK esperam o próximo quadro: ~450 pacotes. */
const INPUT_CONGESTED_BYTES = 8 * 1024;

// TURN público de teste (Open Relay, projeto Metered): retransmite o tráfego JÁ CRIPTOGRAFADO (DTLS-SRTP) quando a
// conexão direta é bloqueada (firewall, isolamento de clientes do Wi-Fi, VPN, 4G/CGNAT). Para uso sério, defina o seu
// próprio TURN em NEXT_PUBLIC_TURN_URL (várias URLs separadas por vírgula), NEXT_PUBLIC_TURN_USER e NEXT_PUBLIC_TURN_PASS.
const DEFAULT_TURN = [
  "turn:openrelay.metered.ca:80",
  "turn:openrelay.metered.ca:443",
  "turn:openrelay.metered.ca:443?transport=tcp",
  "turns:openrelay.metered.ca:443?transport=tcp",
];

function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  const custom = process.env.NEXT_PUBLIC_TURN_URL;
  servers.push({
    urls: custom ? custom.split(",").map((u) => u.trim()) : DEFAULT_TURN,
    username: custom ? process.env.NEXT_PUBLIC_TURN_USER : "openrelayproject",
    credential: custom ? process.env.NEXT_PUBLIC_TURN_PASS : "openrelayproject",
  });
  return servers;
}

function candType(c: string): string {
  return /\btyp (\w+)/.exec(c)?.[1] ?? "?";
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
  private remoteCounts: Record<string, number> | null = null;
  private dumpStats: (() => Promise<void>) | null = null;
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

  congested() {
    const ch = this.input;
    return !!ch && ch.readyState === "open" && ch.bufferedAmount > INPUT_CONGESTED_BYTES;
  }

  /** Com o canal fechado só a qualidade fica guardada (é reenviada ao abrir); rotate/nav sem conexão não fazem sentido. */
  sendCtrl(msg: CtrlMessage) {
    if (this.ctrl?.readyState === "open") {
      this.ctrl.send(JSON.stringify(msg));
      if (msg.type === "quality") this.pendingCtrl = null;
    } else if (msg.type === "quality") {
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
      if (c.candidate && this.remoteCounts) {
        const t = candType(c.candidate);
        this.remoteCounts[t] = (this.remoteCounts[t] ?? 0) + 1;
      }
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
    const local: Record<string, number> = {};
    const remote: Record<string, number> = {};
    this.remoteCounts = remote;
    const fmt = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(" ") || "nenhum";
    pc.onicegatheringstatechange = () => {
      if (this.pc === pc && pc.iceGatheringState === "complete") this.note(`Candidatos locais: ${fmt(local)}`);
    };
    pc.onicecandidateerror = (e) => {
      const ev = e as RTCPeerConnectionIceErrorEvent;
      if (this.pc === pc) this.note(`Erro ICE ${ev.errorCode}: ${ev.errorText} (${ev.url})`);
    };
    // Mostra por que não conectou: estado dos pares de candidatos depois de 12 s e ao falhar.
    const dump = async () => {
      if (this.pc !== pc || pc.connectionState === "connected") return;
      try {
        const stats = await pc.getStats();
        const byId = new Map<string, any>();
        stats.forEach((r) => byId.set(r.id, r));
        const pairs: string[] = [];
        stats.forEach((r: any) => {
          if (r.type !== "candidate-pair") return;
          const l = byId.get(r.localCandidateId), rm = byId.get(r.remoteCandidateId);
          pairs.push(`${l?.candidateType ?? "?"}→${rm?.candidateType ?? "?"}:${r.state}`);
        });
        this.note(`Pares de candidatos: ${pairs.length ? pairs.join(", ") : "nenhum"}; remotos: ${fmt(remote)}`);
      } catch {}
    };
    setTimeout(dump, 12000);
    this.dumpStats = dump;
    pc.onicecandidate = (ev) => {
      if (this.pc !== pc || !ev.candidate || !ev.candidate.candidate) return;
      local[candType(ev.candidate.candidate)] = (local[candType(ev.candidate.candidate)] ?? 0) + 1;
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
        this.l.onConnect?.();
        ch.onmessage = (m) => {
          if (this.ctrl === ch && typeof m.data === "string") this.l.onCtrl?.(m.data);
        };
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
      if (s === "failed") void this.dumpStats?.();
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
