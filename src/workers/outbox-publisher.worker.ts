import { Inject, Injectable, Logger } from '@nestjs/common';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { config } from '../config';
import { SQS_CLIENT } from '../messaging/sqs.client';
import { PollingWorker } from './polling-worker';

interface OutboxRow {
  id: string;
  event_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  attempts: number;
}

/**
 * Publicador da OUTBOX: lê eventos ainda não publicados e envia para a fila de eventos.
 *
 * Vários publicadores podem rodar ao mesmo tempo (um por instância) com segurança,
 * graças ao `FOR UPDATE SKIP LOCKED`: cada um TRAVA as linhas que pegou,
 * e os outros PULAM essas linhas em vez de esperar. Ninguém pega o mesmo evento.
 *
 * Garantia: "pelo menos uma vez" (at-least-once). Se o processo morrer DEPOIS de enviar
 * e ANTES do COMMIT, o evento será enviado de novo. Por isso todo evento tem um
 * `eventId` único: quem consome usa esse id para ignorar repetições.
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
        `select id, event_type, aggregate_id, payload, attempts
           from outbox_events
          where published_at is null and available_at <= now()
          order by occurred_at, id
          limit ?
          for update skip locked`,
        [batchSize],
      );

      for (const row of rows) {
        try {
          await this.sqs.send(
            new SendMessageCommand({
              QueueUrl: config.sqs.eventsQueueUrl,
              MessageBody: JSON.stringify(row.payload),
              // Mesmo grupo = mesma entidade → eventos dela chegam em ordem.
              MessageGroupId: row.aggregate_id,
              // O próprio SQS também descarta repetições do mesmo evento (janela de 5 min).
              MessageDeduplicationId: row.id,
              MessageAttributes: { eventType: { DataType: 'String', StringValue: row.event_type } },
            }),
          );
          await tx.execute(
            `update outbox_events set published_at = now(), attempts = attempts + 1, last_error = null where id = ?`,
            [row.id],
          );
        } catch (error) {
          // Falhou: registra o erro e agenda nova tentativa com espera crescente (até 5 min).
          const delaySeconds = Math.min(2 ** (row.attempts + 1), 300);
          await tx.execute(
            `update outbox_events
                set attempts = attempts + 1, last_error = ?, available_at = now() + (? * interval '1 second')
              where id = ?`,
            [(error as Error).message.slice(0, 500), delaySeconds, row.id],
          );
          this.logger.warn(`Failed to publish event ${row.id} (${row.event_type}): ${(error as Error).message}`);
        }
      }
      return rows.length;
    });
  }
}
