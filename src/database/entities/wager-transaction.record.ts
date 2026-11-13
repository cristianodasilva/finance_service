import { EntitySchema } from '@mikro-orm/core';
import type { WagerKind, WagerStatus } from '../../domain/wager/wager-transaction';

/** Uma linha de `wager_transactions`, do jeito que está no banco (texto, datas, sem regras). */
export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  kind!: WagerKind;
  status!: WagerStatus;
  playerId!: string;
  walletId!: string;
  currency!: string;
  amount!: string;
  roundId!: string | null;
  gameId!: string | null;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  failureCode!: string | null;
  /** Saldo observado no momento da decisão (devolvido no replay). */
  resultingBalance!: string;
  /** Controle do worker de PENDING_REFERENCE. */
  attempts!: number;
  nextAttemptAt!: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
  processedAt!: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'text' },
    externalTransactionId: { type: 'text' },
    idempotencyKey: { type: 'text' },
    payloadHash: { type: 'text' },
    kind: { type: 'text' },
    status: { type: 'text' },
    playerId: { type: 'text' },
    walletId: { type: 'uuid' },
    currency: { type: 'string', columnType: 'char(3)' },
    amount: { type: 'decimal', columnType: 'numeric(20,2)' },
    roundId: { type: 'text', nullable: true },
    gameId: { type: 'text', nullable: true },
    referenceExternalTransactionId: { type: 'text', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    failureCode: { type: 'text', nullable: true },
    resultingBalance: { type: 'decimal', columnType: 'numeric(20,2)' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
    createdAt: { type: 'Date', columnType: 'timestamptz' },
    updatedAt: { type: 'Date', columnType: 'timestamptz' },
    processedAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
  },
});
