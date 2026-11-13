import { createHash } from 'node:crypto';
import type { MoneyProps } from '../money/money';

/**
 * Subconjunto de NEGÓCIO usado no hash. Ficam de fora: o header Idempotency-Key,
 * o messageId/occurredAt da fila e qualquer metadado de transporte.
 */
export interface WagerBusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | null;
}

/**
 * JSON CANÔNICO: mesmas informações → exatamente o mesmo texto.
 *  - chaves de objetos em ordem alfabética (em todos os níveis);
 *  - sem espaços;
 *  - campos `undefined`/`null` omitidos (ausente e nulo significam o mesmo);
 *  - arrays mantêm a ordem.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * payloadHash = "sha256:" + hex(SHA-256(JSON canônico do payload de negócio)).
 * O valor deve chegar já normalizado (ex.: "80" → "80.00") para "80" e "80.00" darem o mesmo hash.
 */
export function payloadHash(payload: object): string {
  return `sha256:${createHash('sha256').update(canonicalJson(payload)).digest('hex')}`;
}
