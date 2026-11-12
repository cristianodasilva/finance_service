import { DomainEvent } from './domain-event';

/** Dados comuns a todos os eventos de transação. */
export interface WagerTransactionEventPayload {
  transactionId: string;
  provider: string;
  providerTransactionId: string;
  kind: string;
  playerId: string;
  walletId: string;
  currency: string;
  amount: string;
  roundId: string | null;
}

/** Transação aceita e aplicada (o saldo pode ou não ter mudado, ex.: LOSS). */
export class WagerTransactionProcessed extends DomainEvent<WagerTransactionEventPayload> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly aggregateType = 'WagerTransaction';
  constructor(payload: WagerTransactionEventPayload, occurredAt?: Date) {
    super(payload.transactionId, payload, occurredAt);
  }
}

/** Transação recusada por regra de negócio (com o código do motivo). */
export class WagerTransactionRejected extends DomainEvent<WagerTransactionEventPayload & { failureCode: string }> {
  readonly eventType = 'WagerTransactionRejected';
  readonly aggregateType = 'WagerTransaction';
  constructor(payload: WagerTransactionEventPayload & { failureCode: string }, occurredAt?: Date) {
    super(payload.transactionId, payload, occurredAt);
  }
}

/** Transação aguardando a chegada da transação referenciada. */
export class WagerTransactionPendingReference extends DomainEvent<
  WagerTransactionEventPayload & { referenceProviderTransactionId: string | null }
> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly aggregateType = 'WagerTransaction';
  constructor(payload: WagerTransactionEventPayload & { referenceProviderTransactionId: string | null }, occurredAt?: Date) {
    super(payload.transactionId, payload, occurredAt);
  }
}
