import type { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import type { MoneyProps } from '../money/money';
import type { WagerTransaction } from '../wager/wager-transaction';
import type { Wallet } from '../wallet/wallet';
import { IntegrationEvent, type EventContext } from './integration-event';

// ---------------------------------------------------------------------------
// WalletBalanceChanged — SOMENTE quando o saldo muda
// ---------------------------------------------------------------------------
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      IntegrationEvent.props(
        wallet.id,
        {
          walletId: wallet.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: entry.walletVersion,
        },
        { occurredAt: entry.createdAt, ...ctx },
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Eventos de transação (aggregateId = id da transação)
// ---------------------------------------------------------------------------
export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string | null;
  gameId: string | null;
  kind: string;
  money: MoneyProps;
  status: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  /** Saldo observado no momento da decisão. */
  balance: MoneyProps;
}

function transactionData(tx: WagerTransaction, wallet: Wallet): WagerTransactionEventData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    referenceTransactionId: tx.referenceTransactionId,
    balance: wallet.balance.toJSON(),
  };
}

/** Qualquer transação aplicada — inclusive LOSS (que não move saldo). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, wallet: Wallet, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(IntegrationEvent.props(tx.id, transactionData(tx, wallet), ctx));
  }
}

/** Rejeitada por regra de negócio (inclui REFERENCE_NOT_FOUND ao esgotar as tentativas). */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionEventData & { failureCode: string }> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, wallet: Wallet, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(
      IntegrationEvent.props(tx.id, { ...transactionData(tx, wallet), failureCode: tx.failureCode ?? 'UNKNOWN' }, ctx),
    );
  }
}

/** A referência ainda não existe: a transação ficou aguardando. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, wallet: Wallet, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(IntegrationEvent.props(tx.id, transactionData(tx, wallet), ctx));
  }
}
