import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { DeleteMessageCommand, PurgeQueueCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { config } from '../../src/config';
import { Currency } from '../../src/domain/money/currency';
import { Money } from '../../src/domain/money/money';
import type { WagerCommand } from '../../src/domain/wager/wager-rules';
import { createSqsClient } from '../../src/messaging/sqs.client';
import { ProcessWagerService } from '../../src/wagering/process-wager.service';
import { WalletsService } from '../../src/wallets/wallets.service';
import { OutboxPublisherWorker } from '../../src/workers/outbox-publisher.worker';
import { PendingReferenceWorker } from '../../src/workers/pending-reference.worker';
import { createInstances, resetDatabase } from '../support/database';

let instances: MikroORM[];
let sqs: SQSClient;
let wallets: WalletsService;

beforeAll(async () => {
  instances = await createInstances(3);
  sqs = createSqsClient();
  wallets = new WalletsService(instances[0]!.em);
});
afterAll(async () => {
  await Promise.all(instances.map((o) => o.close()));
});
beforeEach(async () => {
  await resetDatabase(instances[0]!);
  await sqs.send(new PurgeQueueCommand({ QueueUrl: config.sqs.eventsQueueUrl })).catch(() => undefined);
});

const query = (sql: string, params: unknown[] = []) => instances[0]!.em.fork().execute(sql, params);

/** Lê (e apaga) todas as mensagens da fila de eventos. */
async function drainEvents(): Promise<{ eventId: string; eventType: string }[]> {
  const events: { eventId: string; eventType: string }[] = [];
  for (let empty = 0; empty < 2; ) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: config.sqs.eventsQueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0 }),
    );
    if (Messages.length === 0) empty++;
    for (const m of Messages) {
      events.push(JSON.parse(m.Body!));
      await sqs.send(new DeleteMessageCommand({ QueueUrl: config.sqs.eventsQueueUrl, ReceiptHandle: m.ReceiptHandle! }));
    }
  }
  return events;
}

describe('Publicador da outbox', () => {
  test('3 publicadores ao mesmo tempo publicam cada evento exatamente uma vez', async () => {
    // 40 carteiras com saldo → 40 eventos WalletBalanceChanged na outbox
    for (let i = 0; i < 40; i++) {
      await wallets.create({ playerId: `p-${i}`, currency: 'BRL', initialBalance: '10.00' });
    }
    const publishers = instances.map((orm) => new OutboxPublisherWorker(orm.em, sqs));

    // Cada publicador roda lotes pequenos até não sobrar nada — todos em paralelo.
    await Promise.all(
      publishers.map(async (p) => {
        while ((await p.runOnce(5)) > 0);
      }),
    );

    const [pending] = await query(`select count(*)::int as n from outbox_events where published_at is null`);
    expect(pending!.n).toBe(0);

    const events = await drainEvents();
    expect(events.length).toBe(40);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(40); // nenhum duplicado
    expect(events.every((e) => e.eventType === 'WalletBalanceChanged')).toBe(true);
  });
});

describe('Reprocessamento de PENDING_REFERENCE', () => {
  const brl = (v: string) => Money.fromDecimal(v, Currency.BRL);
  const wager = (walletId: string, kind: WagerCommand['kind'], id: string, amount: string, ref: string | null): WagerCommand => ({
    provider: 'prov',
    providerTransactionId: id,
    kind,
    playerId: 'player-1',
    walletId,
    amount: brl(amount),
    roundId: 'r1',
    referenceProviderTransactionId: ref,
  });
  /** "Adianta o relógio": torna as transações pendentes elegíveis agora. */
  const makeDue = () => query(`update wager_transactions set next_attempt_at = now() - interval '1 second' where status = 'PENDING_REFERENCE'`);

  test('WIN chega antes da BET → quando a BET chega, o worker processa o WIN', async () => {
    const service = new ProcessWagerService(instances[0]!.em);
    const w = await wallets.create({ playerId: 'player-1', currency: 'BRL', initialBalance: '100.00' });

    const win = await service.execute(wager(w.id, 'WIN', 'win-1', '50.00', 'bet-1'), { type: 'http', idempotencyKey: 'k-win' });
    expect(win.transaction.status).toBe('PENDING_REFERENCE');

    await service.execute(wager(w.id, 'BET', 'bet-1', '30.00', null), { type: 'http', idempotencyKey: 'k-bet' });
    await makeDue();

    // 3 workers ao mesmo tempo: o WIN deve ser aplicado UMA vez só.
    const workers = instances.map((orm) => new PendingReferenceWorker(orm.em, new ProcessWagerService(orm.em)));
    await Promise.all(workers.map((wk) => wk.runOnce()));

    const [tx] = await query(`select status, referenced_transaction_id from wager_transactions where provider_transaction_id = 'win-1'`);
    expect(tx!.status).toBe('PROCESSED');
    expect(tx!.referenced_transaction_id).not.toBeNull();
    const [wallet] = await query(`select balance from wallets where id = ?`, [w.id]);
    expect(wallet!.balance).toBe('120.00'); // 100 - 30 + 50
  });

  test('referência que nunca chega → REJECTED com REFERENCE_NOT_FOUND após o limite de tentativas', async () => {
    const service = new ProcessWagerService(instances[0]!.em);
    const worker = new PendingReferenceWorker(instances[0]!.em, service);
    const w = await wallets.create({ playerId: 'player-1', currency: 'BRL', initialBalance: '100.00' });
    await service.execute(wager(w.id, 'WIN', 'win-1', '50.00', 'nunca-chega'), { type: 'http', idempotencyKey: 'k' });

    for (let i = 0; i < config.pendingReference.maxAttempts; i++) {
      await makeDue();
      await worker.runOnce();
    }

    const [tx] = await query(`select status, failure_code, attempts from wager_transactions where provider_transaction_id = 'win-1'`);
    expect(tx).toEqual({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', attempts: config.pendingReference.maxAttempts });
    const [wallet] = await query(`select balance from wallets where id = ?`, [w.id]);
    expect(wallet!.balance).toBe('100.00');
  });
});
