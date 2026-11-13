import { DomainError, FailureCode } from '../domain/errors';
import { payloadHash } from '../domain/wager/payload-hash';
import type { WagerRequest } from '../wagering/process-wager.service';
import { businessPayload } from '../wagering/process-wager.service';
import { parseIdempotencyKey, parseObject, parseWagerRequest } from '../wagering/wager-request.parser';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

export interface WagerMessage {
  messageId: string;
  occurredAt: string;
  idempotencyKey: string;
  request: WagerRequest;
  /** Hash do conteúdo da mensagem (para detectar o mesmo messageId com conteúdo diferente). */
  payloadHash: string;
}

/**
 * Lê o envelope da fila:
 * { messageId, type: "WagerTransactionRequested", occurredAt, data: { ...campos do POST, idempotencyKey } }
 * O `data` passa pelo MESMO parser do HTTP. Qualquer problema → erro permanente (DLQ).
 */
export function parseWagerMessage(body: string): WagerMessage {
  const envelope = parseObject(JSON.parse(body), 'Message');
  if (typeof envelope.messageId !== 'string' || envelope.messageId.trim() === '' || envelope.messageId.length > 200) {
    throw new DomainError(FailureCode.INVALID_REQUEST, '"messageId" is required');
  }
  if (envelope.type !== WAGER_MESSAGE_TYPE) {
    throw new DomainError(FailureCode.INVALID_REQUEST, `Unsupported message type "${String(envelope.type)}"`);
  }
  if (typeof envelope.occurredAt !== 'string' || Number.isNaN(Date.parse(envelope.occurredAt))) {
    throw new DomainError(FailureCode.INVALID_REQUEST, '"occurredAt" must be an ISO-8601 date');
  }
  const data = parseObject(envelope.data, '"data"');
  const request = parseWagerRequest(data);
  const idempotencyKey = parseIdempotencyKey(data.idempotencyKey);
  return {
    messageId: envelope.messageId,
    occurredAt: envelope.occurredAt,
    idempotencyKey,
    request,
    payloadHash: payloadHash({ ...businessPayload(request), idempotencyKey }),
  };
}
