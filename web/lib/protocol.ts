/**
 * Pacote binário de entrada (DataChannel "input", não confiável/não ordenado).
 *
 *  offset  tipo      campo
 *  0       uint8     actionType
 *  1       uint8     keyId   (id do ponteiro/dedo, 0..9)
 *  2       float32   x       (0.0-1.0, relativo à largura da tela)
 *  6       float32   y       (0.0-1.0, relativo à altura da tela)
 *  10      float32   deltaX  (fração da altura da tela, só para LOOK)
 *  14      float32   deltaY
 *
 * Little-endian, 18 bytes. Mesma definição em InputProtocol.kt.
 */
export const Action = { DOWN: 1, MOVE: 2, UP: 3, LOOK: 4, RELEASE_ALL: 5 } as const;
export type ActionType = (typeof Action)[keyof typeof Action];

export const PACKET_SIZE = 18;

/** Ponteiros reservados. Botões usam 1..8. */
export const POINTER_JOYSTICK = 0;
export const POINTER_LOOK = 9;

const buffer = new ArrayBuffer(PACKET_SIZE);
const view = new DataView(buffer);

/** Reaproveita um único buffer: RTCDataChannel.send copia os bytes na chamada. */
export function encodePacket(
  action: ActionType,
  keyId: number,
  x = 0,
  y = 0,
  dx = 0,
  dy = 0
): ArrayBuffer {
  view.setUint8(0, action);
  view.setUint8(1, keyId);
  view.setFloat32(2, x, true);
  view.setFloat32(6, y, true);
  view.setFloat32(10, dx, true);
  view.setFloat32(14, dy, true);
  return buffer;
}

/**
 * Mensagens de controle (DataChannel "ctrl" no WebRTC; quadro CTRL no modo USB). JSON.
 * "keyframe" só é usada no modo USB (pede um quadro-chave ao encoder após perda/erro de decodificação).
 */
export type CtrlMessage = { type: "quality"; height: number; fps: number } | { type: "keyframe" };
