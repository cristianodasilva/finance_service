import { DomainEvent } from './domain-event';

export interface WalletBalanceChangedPayload {
  walletId: string;
  playerId: string;
  currency: string;
  /** Saldo antes e depois, como texto decimal ("100.00"). */
  previousBalance: string;
  newBalance: string;
  walletVersion: number;
  transactionId: string;
}

/** Publicado SOMENTE quando o saldo de uma carteira realmente muda. */
export class WalletBalanceChanged extends DomainEvent<WalletBalanceChangedPayload> {
  readonly eventType = 'WalletBalanceChanged';
  readonly aggregateType = 'Wallet';

  constructor(payload: WalletBalanceChangedPayload, occurredAt?: Date) {
    super(payload.walletId, payload, occurredAt);
  }
}
