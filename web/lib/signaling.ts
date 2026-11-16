/**
 * Sinalização via protocolo do PeerServer (PeerJS). Usamos apenas o relay de
 * OFFER/ANSWER/CANDIDATE do servidor — o app nativo Android não tem cliente
 * PeerJS, então ambos os lados falam o protocolo WebSocket diretamente.
 */
export type SignalingConfig = {
  host: string;
  port: number;
  path: string;
  key: string;
  secure: boolean;
};

export const DEFAULT_SIGNALING: SignalingConfig = {
  host: process.env.NEXT_PUBLIC_PEER_HOST || "0.peerjs.com",
  port: Number(process.env.NEXT_PUBLIC_PEER_PORT || 443),
  path: process.env.NEXT_PUBLIC_PEER_PATH || "/",
  key: process.env.NEXT_PUBLIC_PEER_KEY || "peerjs",
  secure: (process.env.NEXT_PUBLIC_PEER_SECURE || "true") === "true",
};

export type SignalMessage = { type: string; src?: string; dst?: string; payload?: any };

export class Signaling {
  private ws: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private closed = false;
  private token = Math.random().toString(36).slice(2);

  constructor(
    private cfg: SignalingConfig,
    private id: string,
    private onMessage: (m: SignalMessage) => void,
    private onStatus: (s: "connecting" | "open" | "closed" | "error", detail?: string) => void
  ) {}

  connect() {
    if (this.closed) return;
    const { host, port, path, key, secure } = this.cfg;
    const url = `${secure ? "wss" : "ws"}://${host}:${port}${path}peerjs?key=${key}&id=${this.id}&token=${this.token}`;
    this.onStatus("connecting");
    const ws = new WebSocket(url);
    this.ws = ws;
    let answered = false;
    let assumeOpen: ReturnType<typeof setTimeout> | null = null;
    ws.onopen = () => {
      // O PeerServer não manda "OPEN" quando o mesmo id+token reconecta antes de notar a queda
      // do socket antigo; nesse caso ele só troca o socket e a sala continua nossa.
      assumeOpen = setTimeout(() => {
        if (this.ws === ws && !answered) {
          answered = true;
          this.attempts = 0;
          this.onStatus("open");
        }
      }, 2000);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg: SignalMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "OPEN") {
        answered = true;
        this.attempts = 0;
        this.onStatus("open");
      } else if (msg.type === "ID-TAKEN") {
        // Normalmente é o socket antigo desta mesma aba (recarregou) que o servidor ainda não
        // derrubou; ele cai sozinho, então tentamos de novo em vez de desistir para sempre.
        answered = true;
        this.onStatus("error", "ID da sala em uso (outra aba aberta?). Tentando de novo…");
      } else if (msg.type === "ERROR") {
        answered = true;
        this.onStatus("error", msg.payload?.msg || "Erro do servidor de sinalização");
      } else {
        this.onMessage(msg);
      }
    };
    ws.onclose = () => {
      if (assumeOpen) clearTimeout(assumeOpen);
      if (this.ws !== ws) return;
      this.stopHeartbeat();
      if (this.closed) return;
      this.onStatus("closed");
      const delay = Math.min(1000 * 2 ** this.attempts++, 15000);
      this.retry = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => this.ws === ws && this.onStatus("error", "Falha no servidor de sinalização");
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => this.raw({ type: "HEARTBEAT" }), 5000);
  }

  send(type: string, dst: string, payload: unknown) {
    this.raw({ type, dst, payload });
  }

  close() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.stopHeartbeat();
    this.ws?.close();
  }

  private raw(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}
