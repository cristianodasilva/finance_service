import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { config } from '../../src/config';
import { createSqsClient } from '../../src/messaging/sqs.client';
import { WagerQueueConsumer } from '../../src/messaging/wager-queue.consumer';
import { ProcessWagerService } from '../../src/wagering/process-wager.service';
import { OutboxPublisherWorker } from '../../src/workers/outbox-publisher.worker';
import { assertLedgerInvariant, createInstances, resetDatabase } from '../support/database';
import { drainEvents } from '../support/events-queue';
import { balanceOf, count, envelope, openWallet, request } from '../support/fixtures';
import { ensureTestQueues } from '../support/queues';

/** "Crash depois do commit": o banco confirmou, mas o passo seguinte não aconteceu. */
let instances: MikroORM[];
let sqs: SQSClient;

beforeAll(async () => {
  await ensureTestQueues();
  instances = await createInstances(2);
  sqs = createSqsClient();
});
afterAll(async () => {
  await Promise.all(instances.map((o) => o.close().catch(() => undefined)));
});
beforeEach(async () => {
  await resetDatabase(instances[0]!);
});
afterEach(async () => {
  await assertLedgerInvariant(instances[0]!);
});

/** Cliente SQS que falha (antes ou depois de executar) na 1ª vez que um comando é enviado. */
function sabotage(commandName: string, when: 'before' | 'after' | 'hang'): SQSClient {
  let done = false;
  return {
    send: async (command: { constructor: { name: string } }, options?: unknown) => {
      const hit = command.constructor.name === commandName && !done;
      if (hit && when === 'hang') return new Promise(() => undefined); // nunca responde (processo "travado")
      if (hit && when === 'before') {
        done = true;
        throw new Error(`simulated crash before ${commandName}`);
      }
      const result = await sqs.send(command as never, options as never);
      if (hit && when === 'after') {
        done = true;
        throw new Error(`simulated crash after ${commandName}`);
      }
      return result;
    },
  } as unknown as SQSClient;
}

describe('Crash depois do commit', () => {
  test('worker morto depois do commit e antes do ack → redelivery sem débito duplicado', async () => {
    const db = instances[0]!;
    const w = await openWallet(db, '100.00');
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: config.sqs.wagerQueueUrl,
        MessageBody: envelope(request(w, 'BET', 'bet-1', '40.00'), `msg-${w}`),
        MessageGroupId: w,
        MessageDeduplicationId: crypto.randomUUID(),
      }),
    );
    // 1ª entrega: COMMIT feito, mas o ack (DeleteMessage) "cai".
    const crashing = new WagerQueueConsumer(sabotage('DeleteMessageCommand', 'before'), new ProcessWagerService(db.em));
    let first = 0;
    for (let i = 0; i < 5 && first === 0; i++) first = await crashing.pollOnce(1);
    expect(first).toBe(1);
    expect(await balanceOf(db, w)).toBe('60.00');

    // Outra instância recebe a mensagem de novo (volta após a visibilidade) e a inbox reconhece.
    const healthy = new WagerQueueConsumer(sqs, new ProcessWagerService(instances[1]!.em));
    let redelivered = 0;
    for (let i = 0; i < 15 && redelivered === 0; i++) redelivered = await healthy.pollOnce(1);
    expect(redelivered).toBe(1);
    expect(await balanceOf(db, w)).toBe('60.00');
    expect(await count(db, `wallet_ledger_entries where direction = 'DEBIT'`)).toBe(1);
  }, 60_000);

  test('publicador morre antes de publicar → outra instância assume; reenvio duplicado é seguro', async () => {
    const [a, b] = instances as [MikroORM, MikroORM];
    const w = await openWallet(a, '10.00'); // 2 eventos na outbox
    const mine = (e: { data: Record<string, unknown> }) => e.data.walletId === w;

    // Instância A trava as linhas (FOR UPDATE) e "morre" sem publicar.
    const stuck = new OutboxPublisherWorker(a.em, sabotage('SendMessageBatchCommand', 'hang'));
    void stuck.runOnce().catch(() => undefined);
    await Bun.sleep(300);
    // Morte do processo = a conexão dele cai. O PostgreSQL desfaz a transação e solta os locks.
    const killed = await b.em.fork().execute(
      `select pg_terminate_backend(pid) from pg_stat_activity
        where datname = current_database() and state = 'idle in transaction' and pid <> pg_backend_pid()`,
    );
    expect(killed.length).toBeGreaterThan(0);

    // Instância B assume e publica tudo.
    const publisherB = new OutboxPublisherWorker(b.em, sqs);
    while ((await publisherB.runOnce()) > 0);
    expect(await count(b, `outbox_events where published_at is null`)).toBe(0);
    const events = await drainEvents(sqs, mine);
    expect(events.length).toBe(2);

    // Reenvio: publicado mas "morre" antes de marcar → enviado de novo com o MESMO eventId.
    await b.em.fork().execute(`update outbox_events set published_at = null`);
    const flaky = new OutboxPublisherWorker(b.em, sabotage('SendMessageBatchCommand', 'after'));
    await flaky.runOnce();
    await b.em.fork().execute(`update outbox_events set next_attempt_at = now()`);
    while ((await flaky.runOnce()) > 0);
    const again = await drainEvents(sqs, mine);
    // Toda cópia tem um eventId já conhecido: o consumidor descarta pelo eventId.
    expect(again.every((e) => events.some((x) => x.eventId === e.eventId))).toBe(true);

    // A instância A "morreu" (fica abandonada, como um processo morto). Repomos uma nova no lugar.
    instances[0] = (await createInstances(1))[0]!;
  }, 60_000);
});
