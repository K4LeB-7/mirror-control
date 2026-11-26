/**
 * Protocolo do modo USB (ADB) — implementação de referência TS. Espec: docs/USB_PROTOCOLO.md.
 * Mesma definição em android/.../UsbWire.kt; os dois testes usam docs/usb-protocol-vectors.txt.
 *
 * Quadro: [type u8][len u32 LE][payload]. Sem dependências (roda no navegador e no `node --test`).
 */
export const FrameType = {
  VIDEO_CONFIG: 0x01,
  VIDEO_KEY: 0x02,
  VIDEO_DELTA: 0x03,
  INPUT: 0x10,
  CTRL: 0x11,
  HELLO: 0x20,
  INFO: 0x21,
  ERROR: 0x7f,
} as const;

/** Porta do ServerSocket do app no celular (127.0.0.1), alcançada pelo serviço ADB `tcp:27183`. */
export const USB_PORT = 27183;
export const HEADER_SIZE = 5;
export const INPUT_SIZE = 18;
export const MAX_VIDEO_PAYLOAD = 8 * 1024 * 1024;
export const MAX_CONTROL_PAYLOAD = 64 * 1024;
export const MAX_HELLO_PAYLOAD = 64;

export type Frame = { type: number; payload: Uint8Array };

export class WireError extends Error {}

/** Valida `len` para o tipo; lança WireError se estiver fora do limite. */
export function checkLength(type: number, len: number): void {
  let ok: boolean;
  switch (type) {
    case FrameType.INPUT:
      ok = len === INPUT_SIZE;
      break;
    case FrameType.HELLO:
      ok = len >= 1 && len <= MAX_HELLO_PAYLOAD;
      break;
    case FrameType.VIDEO_CONFIG:
      ok = len <= MAX_VIDEO_PAYLOAD;
      break;
    case FrameType.VIDEO_KEY:
    case FrameType.VIDEO_DELTA:
      ok = len >= 8 && len <= MAX_VIDEO_PAYLOAD;
      break;
    default: // INFO, CTRL, ERROR e tipos desconhecidos (ignorados pelo receptor)
      ok = len <= MAX_CONTROL_PAYLOAD;
  }
  if (!ok) throw new WireError(`tamanho inválido ${len} para o tipo 0x${type.toString(16)}`);
}

export function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
  checkLength(type, payload.length);
  const out = new Uint8Array(HEADER_SIZE + payload.length);
  const v = new DataView(out.buffer);
  v.setUint8(0, type);
  v.setUint32(1, payload.length, true);
  out.set(payload, HEADER_SIZE);
  return out;
}

/** u64 LE sem BigInt (pts em µs cabe com folga em 2^53). */
function writeU64(v: DataView, off: number, n: number) {
  v.setUint32(off, n % 0x100000000, true);
  v.setUint32(off + 4, Math.floor(n / 0x100000000), true);
}

export function encodeVideoFrame(type: number, ptsUs: number, data: Uint8Array): Uint8Array {
  const payload = new Uint8Array(8 + data.length);
  writeU64(new DataView(payload.buffer), 0, Math.max(0, Math.floor(ptsUs)));
  payload.set(data, 8);
  return encodeFrame(type, payload);
}

export function parseVideoPayload(payload: Uint8Array): { ptsUs: number; data: Uint8Array } {
  if (payload.length < 8) throw new WireError("quadro de vídeo sem pts");
  const v = new DataView(payload.buffer, payload.byteOffset, 8);
  const ptsUs = v.getUint32(0, true) + v.getUint32(4, true) * 0x100000000;
  return { ptsUs, data: payload.subarray(8) };
}

const enc = new TextEncoder();
const dec = new TextDecoder();
export const encodeText = (type: number, s: string) => encodeFrame(type, enc.encode(s));
export const decodeText = (p: Uint8Array) => dec.decode(p);

/**
 * Decodificador de fluxo: aceita pedaços de qualquer tamanho (inclusive 1 byte) e devolve os quadros completos.
 * Depois de um WireError o fluxo está corrompido: descarte o decodificador e feche a conexão.
 */
export class FrameDecoder {
  private buf = new Uint8Array(64 * 1024);
  private start = 0;
  private end = 0;

  /**
   * `zeroCopy` (site 0.3.4): quando o pedaço recebido começa num limite de quadro (nada guardado de antes), os
   * payloads devolvidos são VISTAS do próprio pedaço (sem as duas cópias do caminho normal: append + slice); só o
   * resto incompleto é copiado. Contrato: o chamador usa/copia cada payload antes de devolver o controle ao laço de
   * leitura (o UsbSession decodifica na hora e copia o que guarda, ex.: VIDEO_CONFIG).
   */
  private zeroCopy: boolean;

  constructor(zeroCopy = false) {
    this.zeroCopy = zeroCopy;
  }

  push(chunk: Uint8Array): Frame[] {
    if (this.zeroCopy && this.end === this.start) return this.pushZeroCopy(chunk);
    this.append(chunk);
    const frames: Frame[] = [];
    for (;;) {
      const avail = this.end - this.start;
      if (avail < HEADER_SIZE) break;
      const v = new DataView(this.buf.buffer, this.start, HEADER_SIZE);
      const type = v.getUint8(0);
      const len = v.getUint32(1, true);
      checkLength(type, len); // rejeita já no cabeçalho, sem esperar 4 GB chegarem
      if (avail < HEADER_SIZE + len) break;
      const p0 = this.start + HEADER_SIZE;
      frames.push({ type, payload: this.buf.slice(p0, p0 + len) });
      this.start = p0 + len;
    }
    if (this.start === this.end) this.start = this.end = 0;
    return frames;
  }

  private pushZeroCopy(chunk: Uint8Array): Frame[] {
    const frames: Frame[] = [];
    let off = 0;
    for (;;) {
      const avail = chunk.length - off;
      if (avail < HEADER_SIZE) break;
      const v = new DataView(chunk.buffer, chunk.byteOffset + off, HEADER_SIZE);
      const type = v.getUint8(0);
      const len = v.getUint32(1, true);
      checkLength(type, len);
      if (avail < HEADER_SIZE + len) break;
      frames.push({ type, payload: chunk.subarray(off + HEADER_SIZE, off + HEADER_SIZE + len) });
      off += HEADER_SIZE + len;
    }
    if (off < chunk.length) this.append(chunk.subarray(off)); // o resto incompleto é copiado para o buffer interno
    return frames;
  }

  /** Bytes guardados aguardando o resto do quadro. */
  get pending() {
    return this.end - this.start;
  }

  private append(chunk: Uint8Array) {
    const need = this.end - this.start + chunk.length;
    if (this.end + chunk.length > this.buf.length) {
      if (need <= this.buf.length && this.start > 0) {
        this.buf.copyWithin(0, this.start, this.end);
      } else {
        const next = new Uint8Array(Math.max(need, this.buf.length * 2));
        next.set(this.buf.subarray(this.start, this.end));
        this.buf = next;
      }
      this.end -= this.start;
      this.start = 0;
    }
    this.buf.set(chunk, this.end);
    this.end += chunk.length;
  }
}

/** Percorre as NALs de um buffer Annex B (start code de 3 ou 4 bytes). */
export function* nalUnits(b: Uint8Array): Generator<Uint8Array> {
  let i = 0;
  let start = -1;
  while (i + 2 < b.length) {
    if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1) {
      if (start >= 0) {
        let e = i;
        if (e > start && b[e - 1] === 0) e--; // start code de 4 bytes
        yield b.subarray(start, e);
      }
      i += 3;
      start = i;
    } else i++;
  }
  if (start >= 0 && start < b.length) yield b.subarray(start);
}

/** "avc1.PPCCLL" a partir da SPS (nal_unit_type 7) contida em Annex B; null se não houver SPS. */
export function codecFromAnnexB(b: Uint8Array): string | null {
  for (const nal of nalUnits(b)) {
    if ((nal[0] & 0x1f) === 7 && nal.length >= 4) {
      const h = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
      return `avc1.${h(nal[1])}${h(nal[2])}${h(nal[3])}`;
    }
  }
  return null;
}

export function hasNalType(b: Uint8Array, type: number): boolean {
  for (const nal of nalUnits(b)) if ((nal[0] & 0x1f) === type) return true;
  return false;
}
