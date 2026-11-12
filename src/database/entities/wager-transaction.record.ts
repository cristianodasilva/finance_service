import { EntitySchema } from '@mikro-orm/core';

/** Tipos de transação. OPENING é interno (saldo inicial ao abrir a carteira). */
export type WagerKind = 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

/** PROCESSED, REJECTED e FAILED são estados finais: nunca mudam depois. */
export type WagerStatus = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';

/** Uma linha da tabela `wager_transactions`. */
export class WagerTransactionRecord {
  id!: string;
  provider!: string;
  providerTransactionId!: string;
  kind!: WagerKind;
  status!: WagerStatus;
  playerId!: string;
  walletId!: string;
  currency!: string;
  amount!: string;
  roundId?: string | null;
  referenceProviderTransactionId?: string | null;
  referencedTransactionId?: string | null;
  failureCode?: string | null;
  attempts!: number;
  nextAttemptAt?: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
  processedAt?: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    provider: { type: 'text' },
    providerTransactionId: { type: 'text' },
    kind: { type: 'text' },
    status: { type: 'text' },
    playerId: { type: 'text' },
    walletId: { type: 'uuid' },
    currency: { type: 'string', columnType: 'char(3)' },
    amount: { type: 'decimal', columnType: 'numeric(20,2)' },
    roundId: { type: 'text', nullable: true },
    referenceProviderTransactionId: { type: 'text', nullable: true },
    referencedTransactionId: { type: 'uuid', nullable: true },
    failureCode: { type: 'text', nullable: true },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
    createdAt: { type: 'Date', columnType: 'timestamptz' },
    updatedAt: { type: 'Date', columnType: 'timestamptz' },
    processedAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
  },
});
