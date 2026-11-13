import { Currency } from '../domain/money/currency';
import { Money } from '../domain/money/money';
import { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry';
import { WagerTransaction } from '../domain/wager/wager-transaction';
import { Wallet } from '../domain/wallet/wallet';
import type { LedgerEntryRecord } from './entities/ledger-entry.record';
import type { WagerTransactionRecord } from './entities/wager-transaction.record';
import type { WalletRecord } from './entities/wallet.record';

/**
 * Conversores entre as LINHAS do banco (records: texto, números, datas)
 * e os OBJETOS de domínio (Money, Wallet, WagerTransaction...).
 * É o único lugar onde "100.00" (texto do banco) vira Money e vice-versa.
 */

export function walletFromRecord(r: WalletRecord): Wallet {
  const currency = Currency.of(r.currency);
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency,
    balance: Money.fromDecimal(r.balance, currency),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export function walletToRecord(w: Wallet): WalletRecord {
  return {
    id: w.id,
    playerId: w.playerId,
    currency: w.currency.code,
    balance: w.balance.toDecimal(),
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export function transactionFromRecord(r: WagerTransactionRecord): WagerTransaction {
  const currency = Currency.of(r.currency);
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId ?? null,
    gameId: r.gameId ?? null,
    kind: r.kind,
    money: Money.fromDecimal(r.amount, currency),
    referenceExternalTransactionId: r.referenceExternalTransactionId ?? null,
    createdAt: r.createdAt,
    status: r.status,
    referenceTransactionId: r.referenceTransactionId ?? null,
    failureCode: r.failureCode ?? null,
    processedAt: r.processedAt ?? null,
  });
}

/** Copia o estado do domínio para a linha (nova ou existente). */
export function transactionToRecord(
  tx: WagerTransaction,
  extra: { resultingBalance: Money; attempts: number; nextAttemptAt: Date | null; updatedAt: Date },
): WagerTransactionRecord {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    kind: tx.kind,
    status: tx.status,
    playerId: tx.playerId,
    walletId: tx.walletId,
    currency: tx.money.currency.code,
    amount: tx.money.toDecimal(),
    roundId: tx.roundId,
    gameId: tx.gameId,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    referenceTransactionId: tx.referenceTransactionId,
    failureCode: tx.failureCode,
    resultingBalance: extra.resultingBalance.toDecimal(),
    attempts: extra.attempts,
    nextAttemptAt: extra.nextAttemptAt,
    createdAt: tx.createdAt,
    updatedAt: extra.updatedAt,
    processedAt: tx.processedAt,
  };
}

export function entryToRecord(e: WalletLedgerEntry): LedgerEntryRecord {
  return {
    id: e.id,
    walletId: e.walletId,
    transactionId: e.transactionId,
    direction: e.direction,
    amount: e.money.toDecimal(),
    balanceBefore: e.balanceBefore.toDecimal(),
    balanceAfter: e.balanceAfter.toDecimal(),
    walletVersion: e.walletVersion,
    createdAt: e.createdAt,
  };
}

export function entryFromRecord(r: LedgerEntryRecord, currencyCode: string): WalletLedgerEntry {
  const currency = Currency.of(currencyCode);
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    direction: r.direction,
    money: Money.fromDecimal(r.amount, currency),
    balanceBefore: Money.fromDecimal(r.balanceBefore, currency),
    balanceAfter: Money.fromDecimal(r.balanceAfter, currency),
    walletVersion: r.walletVersion,
    createdAt: r.createdAt,
  });
}
