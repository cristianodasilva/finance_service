import type { EntityManager } from '@mikro-orm/postgresql';
import { OutboxEventRecord } from '../database/entities/outbox-event.record';
import type { DomainEvent } from '../events/domain-event';

/**
 * Grava eventos na tabela outbox.
 *
 * IMPORTANTE: recebe o `em` da transação EM ANDAMENTO. Assim, o evento é salvo
 * junto com a mudança de saldo: ou os dois são gravados, ou nenhum.
 * Quem publica na fila é outro processo (o worker), depois do commit.
 */
export function addToOutbox(em: EntityManager, events: DomainEvent[]): void {
  for (const event of events) {
    const record = em.create(OutboxEventRecord, {
      id: event.eventId,
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.toEnvelope(),
      occurredAt: event.occurredAt,
      publishedAt: null,
      attempts: 0,
      lastError: null,
      availableAt: event.occurredAt,
    });
    em.persist(record);
  }
}
