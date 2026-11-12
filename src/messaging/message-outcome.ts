import { ConnectionException, DriverException } from '@mikro-orm/core';
import { TransientError } from '../common/transient-error';
import { DomainError } from '../domain/errors';

/**
 * Classifica o resultado do processamento de uma mensagem em 3 tipos de erro:
 *
 *  - business:  a regra recusou (ex.: saldo insuficiente). NÃO é erro para a fila:
 *               a transação foi gravada como REJECTED → confirmamos (apagamos) a mensagem.
 *               (Isso nem chega aqui: o serviço devolve o resultado normalmente.)
 *
 *  - permanent: a mensagem NUNCA vai dar certo, não importa quantas vezes tentar
 *               (JSON inválido, carteira inexistente, conflito de conteúdo).
 *               → mandamos direto para a DLQ, com o motivo.
 *
 *  - transient: problema TEMPORÁRIO (banco fora, muitos conflitos seguidos).
 *               → NÃO confirmamos: a mensagem volta para a fila e é tentada de novo.
 *               Depois de N tentativas, o próprio SQS move para a DLQ.
 */
export type FailureKind = 'permanent' | 'transient';

export function classifyError(error: unknown): { kind: FailureKind; code: string } {
  if (error instanceof SyntaxError) return { kind: 'permanent', code: 'INVALID_JSON' };
  if (error instanceof DomainError) return { kind: 'permanent', code: error.code };
  if (error instanceof TransientError) return { kind: 'transient', code: error.code };
  if (error instanceof ConnectionException) return { kind: 'transient', code: 'DATABASE_UNAVAILABLE' };
  if (error instanceof DriverException) return { kind: 'transient', code: 'DATABASE_ERROR' };
  // Erro desconhecido (provável bug): tratamos como temporário. Se persistir, o SQS manda para a DLQ.
  return { kind: 'transient', code: 'UNEXPECTED_ERROR' };
}
