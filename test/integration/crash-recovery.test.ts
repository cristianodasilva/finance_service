import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  DeleteMessageCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { config } from '../../src/config';
import { createSqsClient } from '../../src/messaging/sqs.client';
import { WagerQueueConsumer } from '../../src/messaging/wager-queue.consumer';
import { ProcessWagerService } from '../../src/wagering/process-wager.service';
import { WalletsService } from '../../src/wallets/wallets.service';
import { OutboxPublisherWorker } from '../../src/workers/outbox-publisher.worker';
import { createInstances, resetDatabase } from '../support/database';

/**
 * Cenários de "crash depois do commit": o banco já gravou, mas o passo seguinte
 * (confirmar a mensagem / marcar o evento como publicado) não aconteceu.
 * Simulamos a falha com um cliente SQS "sabotado".
 */
let orm: MikroORM;
let realSqs: SQSClient;
let wallets: WalletsService;
const RUN = crypto.randomUUID();

/** Cliente SQS que FALHA na primeira vez que um tipo de comando é enviado. */
function sabotage(commandName: string, when: 'before' | 'after'): SQSClient {
  let failed = false;
  return {
    send: async (command: { constructor: { name: string } }, options?: unknown) => {
      const target = command.constructor.name === commandName && !failed;
      if (target && when === 'before') {
        failed = true;
        throw new Error(`simulated crash before ${commandName}`);
      }
      const result = await realSqs.send(command as never, options as never);
      if (target && when === 'after') {
        failed = true;
        throw new Error(`simulated crash after ${commandName}`);
      }
      return result;
    },
  } as unknown as SQSClient;
}

const query = (sql: string, params: unknown[] = []) => orm.em.fork().execute(sql, params);

beforeAll(async () => {
  [orm] = (await createInstances(1)) as [MikroORM];
  realSqs = createSqsClient();
  wallets = new WalletsService(orm.em);
});
afterAll(async () => {
  await orm.close();
});
beforeEach(async () => {
  await resetDatabase(orm);
  for (const url of [config.sqs.wagerQueueUrl, config.sqs.eventsQueueUrl]) {
    await realSqs.send(new PurgeQueueCommand({ QueueUrl: url })).catch(() => undefined);
  }
});

describe('Crash depois do commit', () => {
  test('consumidor: commit feito mas o ACK falha → mensagem volta e NÃO debita duas vezes', async () => {
    const w = await wallets.create({ playerId: 'p1', currency: 'BRL', initialBalance: '100.00' });
    await realSqs.send(
      new SendMessageCommand({
        QueueUrl: config.sqs.wagerQueueUrl,
        MessageBody: JSON.stringify({
          provider: 'prov', providerTransactionId: 'bet-1', kind: 'BET', playerId: 'p1',
          walletId: w.id, currency: 'BRL', amount: '40.00',
        }),
        MessageGroupId: w.id,
        MessageDeduplicationId: `${RUN}-bet-1`,
      }),
    );

    // 1ª entrega: processa e faz COMMIT, mas o DeleteMessage (ack) "cai".
    const consumer = new WagerQueueConsumer(sabotage('DeleteMessageCommand', 'before'), new ProcessWagerService(orm.em));
    expect(await consumer.pollOnce(0)).toBe(1);
    expect((await query(`select balance::text from wallets where id = ?`, [w.id]))[0]!.balance).toBe('60.00');

    // A mensagem não foi confirmada → volta para a fila (após o tempo de visibilidade, ~2s).
    let redelivered = 0;
    for (let i = 0; i < 10 && redelivered === 0; i++) redelivered = await consumer.pollOnce(1);
    expect(redelivered).toBe(1);

    // 2ª entrega: a inbox reconhece a mensagem → nada é debitado de novo.
    expect((await query(`select balance::text from wallets where id = ?`, [w.id]))[0]!.balance).toBe('60.00');
    expect((await query(`select count(*)::int as n from wallet_ledger_entries where direction = 'DEBIT'`))[0]!.n).toBe(1);
    expect(await consumer.pollOnce(0)).toBe(0); // agora sim foi confirmada
  }, 30_000);

  test('outbox: evento enviado mas não marcado como publicado → é reenviado (nunca perdido)', async () => {
    await wallets.create({ playerId: 'p1', currency: 'BRL', initialBalance: '10.00' }); // gera 1 evento

    // 1ª tentativa: o envio para a fila acontece, mas "cai" antes de marcar como publicado.
    const publisher = new OutboxPublisherWorker(orm.em, sabotage('SendMessageCommand', 'after'));
    await publisher.runOnce();
    const [afterCrash] = await query(`select published_at, attempts from outbox_events`);
    expect(afterCrash!.published_at).toBeNull(); // continua pendente
    expect(afterCrash!.attempts).toBe(1);

    // 2ª tentativa (quando chega a hora): publica e marca.
    await query(`update outbox_events set available_at = now()`);
    await publisher.runOnce();
    const [recovered] = await query(`select published_at from outbox_events`);
    expect(recovered!.published_at).not.toBeNull();

    // Na fila: o mesmo eventId. (O SQS FIFO descarta a cópia dentro de 5 min pelo
    // MessageDeduplicationId; fora dessa janela, quem consome descarta pelo eventId.)
    const { Messages = [] } = await realSqs.send(
      new ReceiveMessageCommand({ QueueUrl: config.sqs.eventsQueueUrl, MaxNumberOfMessages: 10 }),
    );
    const ids = new Set(Messages.map((m) => JSON.parse(m.Body!).eventId));
    expect(ids.size).toBe(1);
    for (const m of Messages) {
      await realSqs.send(new DeleteMessageCommand({ QueueUrl: config.sqs.eventsQueueUrl, ReceiptHandle: m.ReceiptHandle! }));
    }
  });
});
