import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { config } from '../../src/config';
import { createSqsClient } from '../../src/messaging/sqs.client';
import { ProcessWagerService } from '../../src/wagering/process-wager.service';
import { OutboxPublisherWorker } from '../../src/workers/outbox-publisher.worker';
import { PendingReferenceWorker } from '../../src/workers/pending-reference.worker';
import { assertLedgerInvariant, createInstances, resetDatabase } from '../support/database';
import { drainEvents } from '../support/events-queue';
import { balanceOf, count, openWallet, request, submit } from '../support/fixtures';
import { ensureTestQueues } from '../support/queues';

let instances: MikroORM[];
let sqs: SQSClient;

beforeAll(async () => {
  await ensureTestQueues();
  instances = await createInstances(3);
  sqs = createSqsClient();
});
afterAll(async () => {
  await Promise.all(instances.map((o) => o.close()));
});
beforeEach(async () => {
  await resetDatabase(instances[0]!);
});
afterEach(async () => {
  await assertLedgerInvariant(instances[0]!);
});

const db = () => instances[0]!;
const makeDue = () =>
  db().em.fork().execute(`update wager_transactions set next_attempt_at = now() - interval '1 second' where status = 'PENDING_REFERENCE'`);

describe('Publicadores concorrentes da outbox', () => {
  test('3 publicadores ao mesmo tempo: cada evento publicado exatamente uma vez', async () => {
    const wallets = new Set<string>();
    for (let i = 0; i < 20; i++) wallets.add(await openWallet(db(), '10.00', `p-${i}`)); // 2 eventos cada
    const publishers = instances.map((orm) => new OutboxPublisherWorker(orm.em, sqs));
    await Promise.all(publishers.map(async (p) => {
      while ((await p.runOnce(5)) > 0);
    }));

    expect(await count(db(), `outbox_events where published_at is null`)).toBe(0);
    const events = await drainEvents(sqs, (e) => wallets.has(String(e.data.walletId)));
    expect(events.length).toBe(40);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(40);
    expect(events.filter((e) => e.eventType === 'WalletBalanceChanged').length).toBe(20);
  }, 60_000);
});

describe('PENDING_REFERENCE (referência fora de ordem)', () => {
  const worker = () => new PendingReferenceWorker(db().em, new ProcessWagerService(db().em));

  test.each(['REFUND', 'ROLLBACK'] as const)('%s entregue ANTES da BET → aplicado quando a BET chega', async (kind) => {
    const svc = new ProcessWagerService(db().em);
    const w = await openWallet(db(), '100.00');
    const early = await submit(svc, request(w, kind, `${kind}-1`, '30.00', { referenceExternalTransactionId: 'bet-1' }));
    expect(early.transaction.status).toBe('PENDING_REFERENCE');
    expect(await balanceOf(db(), w)).toBe('100.00');

    await submit(svc, request(w, 'BET', 'bet-1', '30.00'));
    await makeDue();
    // 3 workers disputando: aplicado UMA vez (FOR UPDATE SKIP LOCKED + versão da carteira).
    const workers = instances.map((orm) => new PendingReferenceWorker(orm.em, new ProcessWagerService(orm.em)));
    await Promise.all(workers.map((wk) => wk.runOnce()));

    const [tx] = await db().em.fork().execute(`select status, reference_transaction_id from wager_transactions where external_transaction_id = ?`, [`${kind}-1`]);
    expect(tx!.status).toBe('PROCESSED');
    expect(tx!.reference_transaction_id).not.toBeNull();
    expect(await balanceOf(db(), w)).toBe('100.00'); // -30 da BET, +30 da reversão
  });

  test('referência que nunca chega → REJECTED com REFERENCE_NOT_FOUND e evento publicado na outbox', async () => {
    const w = await openWallet(db(), '100.00');
    await submit(new ProcessWagerService(db().em), request(w, 'REFUND', 'refund-1', '30.00', { referenceExternalTransactionId: 'nunca' }));
    for (let i = 0; i < config.pendingReference.maxAttempts; i++) {
      await makeDue();
      await worker().runOnce();
    }
    const [tx] = await db().em.fork().execute(`select id, status, failure_code, attempts from wager_transactions where external_transaction_id = 'refund-1'`);
    expect(tx).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', attempts: config.pendingReference.maxAttempts });
    expect(await count(db(), `outbox_events where aggregate_id = ? and event_type = 'WagerTransactionRejected'`, [tx!.id])).toBe(1);
    expect(await balanceOf(db(), w)).toBe('100.00');
  });
});
