/**
 * Pool de ponteiros (dedos) dos BOTÕES. Módulo PURO (sem DOM), testado em tests/input.test.ts.
 *
 * O Android injeta no máximo 10 dedos (ids 0..9; `GestureDescription.getMaxStrokeCount()` = 10). Os ponteiros do
 * protocolo são: 0 joystick, 1..7 botões, 8 mouse no modo livre (toque/rolagem), 9 câmera. Um layout pode ter até
 * 20 botões (MAX_BUTTONS), então o ponteiro de um botão NÃO é fixo: ele é pego aqui quando o botão é pressionado e
 * devolvido quando o botão solta. No máximo 7 botões ficam pressionados ao mesmo tempo (limite do Android).
 *
 * Regras:
 * - `acquire` devolve o MENOR ponteiro livre em 1..7 que está "descansado" (solto há pelo menos `restMs`); se todos
 *   os livres foram soltos agora há pouco, devolve o menor livre mesmo assim (o celular separa os toques pela
 *   geração do protocolo v2; o descanso só evita fila no celular — um toque precisa durar ≥ 50 ms lá — e mantém os
 *   pacotes repetidos do toque anterior longe do seguinte). Sem nenhum livre: null (o botão é ignorado; nunca
 *   "rouba" o dedo de outro botão).
 * - `release` só aceita um ponteiro que está em uso (soltar duas vezes ou soltar 0/8/9 não faz nada).
 * - Nunca devolve 0, 8 ou 9.
 */
export const BUTTON_POINTER_FIRST = 1;
export const BUTTON_POINTER_LAST = 7;
/** Botões pressionados ao mesmo tempo (ponteiros 1..7). Limite físico do Android, não do site. */
export const MAX_SIMULTANEOUS_BUTTONS = BUTTON_POINTER_LAST - BUTTON_POINTER_FIRST + 1;
/** Descanso preferido de um ponteiro depois de solto (≥ última cópia redundante do UP, 60 ms, e toque mínimo do app). */
export const POINTER_REST_MS = 80;

export class PointerPool {
  private used = new Set<number>();
  private freedAt = new Map<number, number>();
  readonly restMs: number;

  constructor(restMs = POINTER_REST_MS) {
    this.restMs = restMs;
  }

  /** Pega um ponteiro (ver regras acima) ou null se os 7 estão ocupados. */
  acquire(now: number): number | null {
    let fallback: number | null = null;
    for (let p = BUTTON_POINTER_FIRST; p <= BUTTON_POINTER_LAST; p++) {
      if (this.used.has(p)) continue;
      const at = this.freedAt.get(p);
      if (at === undefined || now - at >= this.restMs) {
        this.used.add(p);
        return p;
      }
      if (fallback === null) fallback = p;
    }
    if (fallback !== null) this.used.add(fallback);
    return fallback;
  }

  /** Devolve um ponteiro em uso. Devolve false (e não faz nada) se ele não estava em uso. */
  release(pointer: number, now: number): boolean {
    if (!this.used.delete(pointer)) return false;
    this.freedAt.set(pointer, now);
    return true;
  }

  /** Devolve todos (releaseAll). */
  releaseAll(now: number) {
    for (const p of this.used) this.freedAt.set(p, now);
    this.used.clear();
  }

  inUse(): number[] {
    return [...this.used].sort((a, b) => a - b);
  }

  get freeCount(): number {
    return MAX_SIMULTANEOUS_BUTTONS - this.used.size;
  }
}
