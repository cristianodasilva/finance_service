import { HttpStatus } from '@nestjs/common';
import type { WagerTransaction } from '../domain/wager/wager-transaction';
import type { WagerResult } from './process-wager.service';

/** Resposta do POST /wagering/transactions (contrato do desafio). */
export function submitView(r: WagerResult) {
  return {
    transactionId: r.transaction.id,
    status: r.transaction.status,
    ...(r.transaction.failureCode ? { failureCode: r.transaction.failureCode } : {}),
    balance: r.balance.toJSON(),
    idempotentReplay: r.replayed,
  };
}

/** Detalhe de uma transação (GETs). */
export function transactionView(t: WagerTransaction, balance?: { amount: string; currency: string }) {
  return {
    transactionId: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money.toJSON(),
    status: t.status,
    failureCode: t.failureCode,
    referenceExternalTransactionId: t.referenceExternalTransactionId,
    referenceTransactionId: t.referenceTransactionId,
    ...(balance ? { balance } : {}),
    createdAt: t.createdAt.toISOString(),
    processedAt: t.processedAt?.toISOString() ?? null,
  };
}

/**
 * Status HTTP por resultado (o mesmo no replay):
 *   201 PROCESSED · 202 PENDING/PENDING_REFERENCE (aceito, processamento pendente)
 *   422 REJECTED (regra de negócio) · 500 FAILED (falha permanente de infraestrutura)
 */
export function httpStatusFor(t: WagerTransaction): number {
  switch (t.status) {
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
