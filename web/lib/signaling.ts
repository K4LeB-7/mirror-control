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
    ws.onmessage = (ev) => {
      let msg: SignalMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "OPEN") {
        this.attempts = 0;
        this.onStatus("open");
      } else if (msg.type === "ID-TAKEN") {
        this.closed = true;
        this.onStatus("error", "ID da sala já em uso. Gere um novo ID.");
        ws.close();
      } else {
        this.onMessage(msg);
      }
    };
    ws.onclose = () => {
      this.stopHeartbeat();
      if (this.closed) return;
      this.onStatus("closed");
      const delay = Math.min(1000 * 2 ** this.attempts++, 15000);
      this.retry = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => this.onStatus("error", "Falha no servidor de sinalização");
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
