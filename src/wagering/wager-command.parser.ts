import { DomainError, FailureCode } from '../domain/errors';
import { Currency } from '../domain/money/currency';
import { Money } from '../domain/money/money';
import { EXTERNAL_WAGER_KINDS, requiresReference, type ExternalWagerKind } from '../domain/wager/wager-kind';
import type { WagerCommand } from '../domain/wager/wager-rules';

/**
 * Converte o JSON recebido (do HTTP ou da fila) em um WagerCommand validado.
 * Usado pelos DOIS caminhos de entrada, para que as regras sejam idênticas.
 * Qualquer problema → DomainError INVALID_REQUEST / INVALID_AMOUNT (HTTP 400).
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalid(message: string): never {
  throw new DomainError(FailureCode.INVALID_REQUEST, message);
}

function str(obj: Record<string, unknown>, field: string, required: boolean): string | null {
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

export function parseWagerCommand(body: unknown): WagerCommand {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) invalid('Body must be a JSON object');
  const obj = body as Record<string, unknown>;

  const kind = str(obj, 'kind', true)!;
  if (!(EXTERNAL_WAGER_KINDS as readonly string[]).includes(kind)) {
    invalid(`"kind" must be one of ${EXTERNAL_WAGER_KINDS.join(', ')}`);
  }
  const walletId = str(obj, 'walletId', true)!;
  if (!UUID_REGEX.test(walletId)) invalid('"walletId" must be a UUID');

  const currency = Currency.of(str(obj, 'currency', true)!);
  const amount = Money.fromDecimal(obj.amount as string, currency); // recusa number, "1.234", etc.

  // Valor precisa ser > 0. Exceção: LOSS pode ser 0 (perda não movimenta saldo).
  if (amount.isNegative() || (amount.isZero() && kind !== 'LOSS')) {
    throw new DomainError(FailureCode.INVALID_AMOUNT, 'Amount must be greater than zero');
  }

  const reference = str(obj, 'referenceProviderTransactionId', false);
  if (requiresReference(kind as ExternalWagerKind) && reference === null) {
    invalid(`"referenceProviderTransactionId" is required for ${kind}`);
  }

  return {
    provider: str(obj, 'provider', true)!,
    providerTransactionId: str(obj, 'providerTransactionId', true)!,
    kind: kind as ExternalWagerKind,
    playerId: str(obj, 'playerId', true)!,
    walletId,
    amount,
    roundId: str(obj, 'roundId', false),
    referenceProviderTransactionId: kind === 'BET' ? null : reference,
  };
}
