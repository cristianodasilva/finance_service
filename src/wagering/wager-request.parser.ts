import { DomainError, FailureCode } from '../domain/errors';
import { Money, type MoneyProps } from '../domain/money/money';
import { EXTERNAL_KINDS, type WagerKind } from '../domain/wager/wager-transaction';
import type { WagerRequest } from './process-wager.service';

/**
 * Converte o JSON recebido (corpo do HTTP ou `data` da mensagem da fila) em WagerRequest.
 * Usado pelas DUAS entradas → regras de validação idênticas.
 * Problemas → INVALID_REQUEST / INVALID_AMOUNT / UNSUPPORTED_CURRENCY (HTTP 400; na fila → DLQ).
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(message: string): never {
  throw new DomainError(FailureCode.INVALID_REQUEST, message);
}

function text(obj: Record<string, unknown>, field: string, required: true): string;
function text(obj: Record<string, unknown>, field: string, required: false): string | null;
function text(obj: Record<string, unknown>, field: string, required: boolean): string | null {
  const value = obj[field];
  if (value === undefined || value === null) {
    if (required) invalid(`"${field}" is required`);
    return null;
  }
  if (typeof value !== 'string' || value.trim() === '' || value.length > 128) {
    invalid(`"${field}" must be a non-empty string (max 128 chars)`);
  }
  return value;
}

export function parseObject(value: unknown, what = 'Body'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(`${what} must be a JSON object`);
  return value as Record<string, unknown>;
}

export function parseWagerRequest(body: unknown): WagerRequest {
  const obj = parseObject(body);

  const kind = text(obj, 'kind', true);
  // OPENING é interno: não pode ser submetido pela API nem pela fila.
  if (!EXTERNAL_KINDS.includes(kind as WagerKind)) invalid(`"kind" must be one of ${EXTERNAL_KINDS.join(', ')}`);

  const walletId = text(obj, 'walletId', true);
  if (!UUID_REGEX.test(walletId)) invalid('"walletId" must be a UUID');

  if (typeof obj.money !== 'object' || obj.money === null) invalid('"money" must be { amount, currency }');
  const money = Money.from(obj.money as MoneyProps);
  if (money.isZero() && kind !== 'LOSS') throw new DomainError(FailureCode.INVALID_AMOUNT, 'Amount must be greater than zero');

  const reference = text(obj, 'referenceExternalTransactionId', false);
  if ((kind === 'REFUND' || kind === 'ROLLBACK') && reference === null) {
    invalid(`"referenceExternalTransactionId" is required for ${kind}`);
  }
  if (kind === 'BET' && reference !== null) invalid('"referenceExternalTransactionId" is not allowed for BET');

  return {
    providerId: text(obj, 'providerId', true),
    externalTransactionId: text(obj, 'externalTransactionId', true),
    playerId: text(obj, 'playerId', true),
    walletId,
    roundId: text(obj, 'roundId', true),
    gameId: text(obj, 'gameId', true),
    kind: kind as WagerKind,
    money,
    referenceExternalTransactionId: reference,
  };
}

export function parseIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    invalid('Header "Idempotency-Key" is required (max 200 chars)');
  }
  return value;
}
