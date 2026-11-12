import { EntitySchema } from '@mikro-orm/core';

export type LedgerDirection = 'CREDIT' | 'DEBIT';

/** Uma linha do extrato (`wallet_ledger_entries`). Só é inserida, nunca alterada. */
export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: LedgerDirection;
  amount!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'text' },
    amount: { type: 'decimal', columnType: 'numeric(20,2)' },
    balanceAfter: { type: 'decimal', columnType: 'numeric(20,2)' },
    walletVersion: { type: 'integer' },
    createdAt: { type: 'Date', columnType: 'timestamptz' },
  },
});
