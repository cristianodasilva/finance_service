import { ConnectionException, DriverException } from '@mikro-orm/core';
import { TransientError } from '../common/transient-error';
import { DomainError } from '../domain/errors';

/**
 * Classifica a FALHA ao processar uma mensagem:
 *  - permanent: nunca vai dar certo (JSON/envelope inválido, carteira inexistente, conflito) → DLQ com o motivo;
 *  - transient: temporária (banco fora, conflitos esgotados) → volta para a fila com espera; após o limite, DLQ.
 *
 * Rejeição de NEGÓCIO (ex.: saldo insuficiente) não chega aqui: é um resultado válido,
 * a transação é gravada como REJECTED e a mensagem é confirmada (ack).
 */
export type FailureKind = 'permanent' | 'transient';

export function classifyError(error: unknown): { kind: FailureKind; code: string } {
  if (error instanceof SyntaxError) return { kind: 'permanent', code: 'INVALID_JSON' };
  if (error instanceof DomainError) return { kind: 'permanent', code: error.code };
  if (error instanceof TransientError) return { kind: 'transient', code: error.code };
  if (error instanceof ConnectionException) return { kind: 'transient', code: 'DATABASE_UNAVAILABLE' };
  if (error instanceof DriverException) return { kind: 'transient', code: 'DATABASE_ERROR' };
  // Desconhecido (provável bug): temporário. Se persistir, o redrive do SQS leva para a DLQ.
  return { kind: 'transient', code: 'UNEXPECTED_ERROR' };
}
