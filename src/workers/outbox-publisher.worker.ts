import { Inject, Injectable, Logger } from '@nestjs/common';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { config } from '../config';
import { OutboxMessage } from '../domain/messaging/outbox-message';
import { SQS_CLIENT } from '../messaging/sqs.client';
import { metrics } from '../observability/metrics';
import { PollingWorker } from './polling-worker';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date;
}

/**
 * Publicador da OUTBOX. Vários podem rodar ao mesmo tempo (um por instância):
 * `FOR UPDATE SKIP LOCKED` faz cada um pegar linhas diferentes, sem esperar nem repetir.
 *
 * Entrega "pelo menos uma vez": se morrer entre enviar e o COMMIT da marcação, o evento
 * é reenviado (por outra instância, inclusive). Quem consome descarta repetições pelo eventId.
 */
@Injectable()
export class OutboxPublisherWorker extends PollingWorker {
  protected readonly logger = new Logger(OutboxPublisherWorker.name);
  protected readonly enabled = config.outbox.publisherEnabled;
  protected readonly intervalMs = config.outbox.pollIntervalMs;

  constructor(
    private readonly em: EntityManager,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {
    super();
  }

  async runOnce(batchSize = config.outbox.batchSize): Promise<number> {
    return this.em.fork().transactional(async (tx) => {
      const rows = await tx.execute<OutboxRow[]>(
        `select id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at
           from outbox_events
          where published_at is null and next_attempt_at <= now()
          order by occurred_at, id
          limit ?
          for update skip locked`,
        [batchSize],
      );

      for (const row of rows) {
        const msg = OutboxMessage.rehydrate({
          id: row.id,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          payload: row.payload,
          occurredAt: new Date(row.occurred_at),
          attempts: row.attempts,
          nextAttemptAt: new Date(row.next_attempt_at),
          publishedAt: null,
        });
        const now = new Date();
        try {
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: config.sqs.eventsQueueUrl,
              MessageBody: JSON.stringify(msg.payload),
              MessageGroupId: msg.aggregateId, // eventos da mesma entidade em ordem
              MessageDeduplicationId: msg.id, // o FIFO também descarta a cópia (janela de 5 min)
              MessageAttributes: { eventType: { DataType: 'String', StringValue: msg.eventType } },
            }),
          );
          msg.markPublished(now);
          await tx.execute(`update outbox_events set published_at = ?, attempts = ?, last_error = null where id = ?`, [
            msg.publishedAt,
            msg.attempts,
            msg.id,
          ]);
          metrics.outboxPublished.inc({ event_type: msg.eventType });
        } catch (error) {
          msg.scheduleRetry(now); // attempts + 1 e próxima tentativa com espera exponencial
          await tx.execute(`update outbox_events set attempts = ?, next_attempt_at = ?, last_error = ? where id = ?`, [
            msg.attempts,
            msg.nextAttemptAt,
            (error as Error).message.slice(0, 500),
            msg.id,
          ]);
          metrics.outboxPublishFailures.inc();
          this.logger.warn(`Failed to publish event ${msg.id} (${msg.eventType}): ${(error as Error).message}`);
        }
      }
      return rows.length;
    });
  }
}
