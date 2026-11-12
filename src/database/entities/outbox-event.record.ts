import { EntitySchema } from '@mikro-orm/core';

/** Um evento esperando para ser publicado (`outbox_events`). */
export class OutboxEventRecord {
  id!: string;
  eventType!: string;
  aggregateType!: string;
  aggregateId!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  publishedAt?: Date | null;
  attempts!: number;
  lastError?: string | null;
  availableAt!: Date;
}

export const OutboxEventSchema = new EntitySchema<OutboxEventRecord>({
  class: OutboxEventRecord,
  tableName: 'outbox_events',
  properties: {
    id: { type: 'uuid', primary: true },
    eventType: { type: 'text' },
    aggregateType: { type: 'text' },
    aggregateId: { type: 'text' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'Date', columnType: 'timestamptz' },
    publishedAt: { type: 'Date', columnType: 'timestamptz', nullable: true },
    attempts: { type: 'integer' },
    lastError: { type: 'text', nullable: true },
    availableAt: { type: 'Date', columnType: 'timestamptz' },
  },
});
