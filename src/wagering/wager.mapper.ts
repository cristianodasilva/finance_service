import { HttpStatus } from '@nestjs/common';
import type { WagerTransactionRecord } from '../database/entities/wager-transaction.record';

/** Formato devolvido pela API para uma transação. */
export function toWagerResponse(r: WagerTransactionRecord) {
  return {
    id: r.id,
    provider: r.provider,
    providerTransactionId: r.providerTransactionId,
    kind: r.kind,
    status: r.status,
    failureCode: r.failureCode ?? null,
    playerId: r.playerId,
    walletId: r.walletId,
    currency: r.currency,
    amount: r.amount,
    roundId: r.roundId ?? null,
    referenceProviderTransactionId: r.referenceProviderTransactionId ?? null,
    referencedTransactionId: r.referencedTransactionId ?? null,
    createdAt: r.createdAt.toISOString(),
    processedAt: r.processedAt?.toISOString() ?? null,
  };
}

/**
 * Status HTTP conforme o resultado:
 *   201 Created              → PROCESSED (aplicada)
 *   202 Accepted             → PENDING_REFERENCE (aceita, mas ainda aguardando)
 *   422 Unprocessable Entity → REJECTED (regra de negócio recusou)
 *   500                      → FAILED (falha técnica permanente)
 */
export function httpStatusFor(r: WagerTransactionRecord): number {
  switch (r.status) {
    case 'PROCESSED':
      return HttpStatus.CREATED;
    case 'PENDING':
    case 'PENDING_REFERENCE':
      return HttpStatus.ACCEPTED;
    case 'REJECTED':
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case 'FAILED':
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}
