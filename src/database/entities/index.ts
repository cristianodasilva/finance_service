// Lista única de todas as entidades, usada na configuração do MikroORM.
import { LedgerEntrySchema } from './ledger-entry.record';
import { OutboxEventSchema } from './outbox-event.record';
import { WagerTransactionSchema } from './wager-transaction.record';
import { WalletSchema } from './wallet.record';

export const ALL_ENTITIES = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, OutboxEventSchema];
