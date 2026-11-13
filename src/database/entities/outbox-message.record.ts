import { EntitySchema } from '@mikro-orm/core';

/** Um evento esperando para ser publicado (`outbox_events`). */
export class OutboxMessageRecord {
  id!: string;
  eventType!: string;
  aggregateId!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  publishedAt!: Date | null;
  attempts!: number;
  lastError!: string | null;
  nextAttemptAt!: Date;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_events',
  properties: {
    id: { type: 'uuid', primary: true },
    eventType: { type: 'text' },
    aggregateId: { type: 'text' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'Date', columnType: 'timestamptz' },
    publishedAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
    attempts: { type: 'integer' },
    lastError: { type: 'text', nullable: true },
    nextAttemptAt: { type: 'Date', columnType: 'timestamptz' },
  },
});
