import type { EntityManager } from '@mikro-orm/postgresql';
import type { IntegrationEvent } from '../domain/events/integration-event';
import { OutboxMessage } from '../domain/messaging/outbox-message';
import { OutboxMessageRecord } from './entities/outbox-message.record';

/**
 * Grava eventos na outbox USANDO O `em` DA TRANSAÇÃO EM ANDAMENTO:
 * o evento só existe se a mudança de saldo também for confirmada (COMMIT).
 * Quem publica na fila é o worker, depois.
 */
export function addToOutbox(em: EntityManager, events: IntegrationEvent<unknown>[]): void {
  for (const event of events) {
    const msg = OutboxMessage.enqueue(event);
    em.persist(
      em.create(OutboxMessageRecord, {
        id: msg.id,
        eventType: msg.eventType,
        aggregateId: msg.aggregateId,
        payload: msg.payload as Record<string, unknown>,
        occurredAt: msg.occurredAt,
        publishedAt: null,
        attempts: msg.attempts,
        lastError: null,
        nextAttemptAt: msg.nextAttemptAt ?? msg.occurredAt,
      }),
    );
  }
}
