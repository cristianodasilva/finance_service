// Lista única de todas as entidades, usada na configuração do MikroORM.
import { InboxMessageSchema } from './inbox-message.record';
import { LedgerEntrySchema } from './ledger-entry.record';
import { OutboxMessageSchema } from './outbox-message.record';
import { WagerTransactionSchema } from './wager-transaction.record';
import { WalletSchema } from './wallet.record';

export const ALL_ENTITIES = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, OutboxMessageSchema, InboxMessageSchema];
