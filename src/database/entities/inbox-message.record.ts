import { EntitySchema } from '@mikro-orm/core';

/** Uma mensagem recebida da fila (`inbox_messages`). Chave: (consumerName, messageId). */
export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  transactionId!: string | null;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'text', primary: true },
    messageId: { type: 'text', primary: true },
    payloadHash: { type: 'text' },
    transactionId: { type: 'uuid', nullable: true },
    receivedAt: { type: 'Date', columnType: 'timestamptz' },
    processedAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
  },
});
