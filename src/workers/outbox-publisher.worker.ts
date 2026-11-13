import { Inject, Injectable, Logger } from '@nestjs/common';
import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
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

      const messages = rows.map((row) =>
        OutboxMessage.rehydrate({
          id: row.id,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          payload: row.payload,
          occurredAt: new Date(row.occurred_at),
          attempts: row.attempts,
          nextAttemptAt: new Date(row.next_attempt_at),
          publishedAt: null,
        }),
      );

      // Medido no teste de carga: o custo dominante é a LATÊNCIA de cada chamada ao SQS.
      // Então os eventos são divididos em "faixas" por entidade (aggregateId): os eventos de
      // uma mesma entidade caem SEMPRE na mesma faixa e saem em ordem; faixas diferentes saem
      // EM PARALELO. Cada chamada leva até 10 eventos (SendMessageBatch).
      const lanes = new Map<number, OutboxMessage[]>();
      for (const msg of messages) {
        const lane = laneOf(msg.aggregateId, PUBLISH_LANES);
        lanes.set(lane, [...(lanes.get(lane) ?? []), msg]);
      }
      const outcomes = await Promise.all([...lanes.values()].map((lane) => this.publishLane(lane)));
      const published = outcomes.flatMap((o) => o.published);
      const failed = outcomes.flatMap((o) => o.failed);
      const now = new Date();

      // Uma única instrução para marcar todos os publicados (antes: um UPDATE por evento).
      if (published.length > 0) {
        await tx.execute(
          `update outbox_events set published_at = ?, attempts = attempts + 1, last_error = null
            where id in (${published.map(() => '?').join(',')})`,
          [now, ...published.map((m) => m.id)],
        );
        for (const m of published) metrics.outboxPublished.inc({ event_type: m.eventType });
      }
      for (const { msg, reason } of failed) {
        msg.scheduleRetry(now); // attempts + 1 e próxima tentativa com espera exponencial
        await tx.execute(`update outbox_events set attempts = ?, next_attempt_at = ?, last_error = ? where id = ?`, [
          msg.attempts,
          msg.nextAttemptAt,
          reason.slice(0, 500),
          msg.id,
        ]);
        metrics.outboxPublishFailures.inc();
        this.logger.warn(`Failed to publish event ${msg.id} (${msg.eventType}): ${reason}`);
      }
      return rows.length;
    });
  }

  /** Publica uma faixa em ordem, em lotes de até 10. Um lote pode falhar parcialmente. */
  private async publishLane(lane: OutboxMessage[]): Promise<{ published: OutboxMessage[]; failed: { msg: OutboxMessage; reason: string }[] }> {
    const published: OutboxMessage[] = [];
    const failed: { msg: OutboxMessage; reason: string }[] = [];
    for (let i = 0; i < lane.length; i += 10) {
      const chunk = lane.slice(i, i + 10);
      let failures = new Map<string, string>();
      try {
        const result = await this.sqs.send(
          new SendMessageBatchCommand({
            QueueUrl: config.sqs.eventsQueueUrl,
            Entries: chunk.map((msg) => ({
              Id: msg.id,
              MessageBody: JSON.stringify(msg.payload),
              MessageGroupId: msg.aggregateId, // eventos da mesma entidade em ordem
              MessageDeduplicationId: msg.id, // o FIFO também descarta a cópia (janela de 5 min)
              MessageAttributes: { eventType: { DataType: 'String', StringValue: msg.eventType } },
            })),
          }),
        );
        failures = new Map((result.Failed ?? []).map((f) => [f.Id!, f.Message ?? f.Code ?? 'failed']));
      } catch (error) {
        failures = new Map(chunk.map((msg) => [msg.id, (error as Error).message]));
      }
      for (const msg of chunk) {
        const reason = failures.get(msg.id);
        if (reason === undefined) published.push(msg);
        else failed.push({ msg, reason });
      }
      // Se um lote da faixa falhou, os seguintes esperam (não ultrapassam eventos da mesma entidade).
      if (failures.size > 0) {
        for (const msg of lane.slice(i + 10)) failed.push({ msg, reason: 'previous batch in lane failed' });
        break;
      }
    }
    return { published, failed };
  }
}

/** Quantas faixas paralelas de publicação por lote. */
const PUBLISH_LANES = 10;

/** Faixa estável de uma entidade (o mesmo aggregateId sempre na mesma faixa). */
function laneOf(aggregateId: string, lanes: number): number {
  let hash = 0;
  for (let i = 0; i < aggregateId.length; i++) hash = (hash * 31 + aggregateId.charCodeAt(i)) | 0;
  return Math.abs(hash) % lanes;
}
