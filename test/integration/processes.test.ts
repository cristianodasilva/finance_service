import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { Subprocess } from 'bun';
import { config } from '../../src/config';
import { createSqsClient } from '../../src/messaging/sqs.client';
import { assertLedgerInvariant, createInstances, resetDatabase, TEST_DATABASE_URL } from '../support/database';
import { balanceOf, count, envelope, openWallet, PLAYER, request } from '../support/fixtures';
import { ensureTestQueues } from '../support/queues';

/**
 * ≥ 3 PROCESSOS REAIS da aplicação (API + consumidor + workers em cada um),
 * apontando para o mesmo PostgreSQL e as mesmas filas — e um deles morto com SIGKILL.
 */
const PORTS = [4101, 4102, 4103];
const apps = new Map<number, Subprocess>();
let orm: MikroORM;

function start(port: number): Subprocess {
  const proc = Bun.spawn([process.execPath, 'run', 'src/main.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: TEST_DATABASE_URL,
      SQS_WAIT_TIME_SECONDS: '1',
      OUTBOX_POLL_INTERVAL_MS: '200',
      PENDING_REFERENCE_POLL_INTERVAL_MS: '300',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  apps.set(port, proc);
  return proc;
}

async function waitReady(port: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(`http://localhost:${port}/health/ready`).then((r) => r.ok).catch(() => false);
    if (ok) return;
    await Bun.sleep(200);
  }
  throw new Error(`app on ${port} not ready`);
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(250);
  }
  throw new Error('condition not met in time');
}

const post = (port: number, body: unknown, key: string) =>
  fetch(`http://localhost:${port}/wagering/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));

const httpBody = (walletId: string, externalTransactionId: string, amount: string) => ({
  providerId: 'provider-a', externalTransactionId, playerId: PLAYER, walletId,
  roundId: 'round-1', gameId: 'fortune-chimp', kind: 'BET', money: { amount, currency: 'BRL' },
});

beforeAll(async () => {
  await ensureTestQueues();
  [orm] = (await createInstances(1)) as [MikroORM];
  await resetDatabase(orm);
  PORTS.forEach(start);
  await Promise.all(PORTS.map(waitReady));
}, 60_000);

afterAll(async () => {
  for (const p of apps.values()) p.kill('SIGTERM');
  await Promise.all([...apps.values()].map((p) => p.exited));
  await orm.close();
}, 30_000);

describe('3 processos da aplicação', () => {
  test('cenário obrigatório pela API, em processos diferentes', async () => {
    const w = await openWallet(orm, '100.00');
    const [a, b] = await Promise.all([
      post(PORTS[0]!, httpBody(w, 'bet-A', '80.00'), 'provider-a:bet-A'),
      post(PORTS[1]!, httpBody(w, 'bet-B', '80.00'), 'provider-a:bet-B'),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    const ok = a.status === 201 ? a.body : b.body;
    expect(Object.keys(ok).sort()).toEqual(['balance', 'idempotentReplay', 'status', 'transactionId']);
    expect(ok).toMatchObject({ status: 'PROCESSED', balance: { amount: '20.00', currency: 'BRL' }, idempotentReplay: false });
    expect(await balanceOf(orm, w)).toBe('20.00');
    await assertLedgerInvariant(orm);
  });

  test('a mesma aposta 50 vezes, espalhada pelos 3 processos → 1 débito, 49 replays idênticos', async () => {
    const w = await openWallet(orm, '100.00', 'player-50x');
    const body = { ...httpBody(w, 'bet-50x', '30.00'), playerId: 'player-50x' };
    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => post(PORTS[i % 3]!, body, 'provider-a:bet-50x')));
    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(responses.filter((r) => r.body.idempotentReplay === false)).toHaveLength(1);
    expect(responses.every((r) => (r.body.balance as { amount: string }).amount === '70.00')).toBe(true);
    expect(await balanceOf(orm, w)).toBe('70.00');
    await assertLedgerInvariant(orm);
  });

  test('SIGKILL em um processo durante o consumo da fila → após o reinício, consistência final', async () => {
    const wallets = await Promise.all([0, 1, 2, 3].map((i) => openWallet(orm, '100.00', `player-k${i}`)));
    const sqs = createSqsClient();
    // 4 carteiras × 10 mensagens: 4 grupos FIFO processados em paralelo pelos 3 processos.
    await Promise.all(
      wallets.flatMap((w, i) =>
        Array.from({ length: 10 }, (_, j) =>
          sqs.send(
            new SendMessageCommand({
              QueueUrl: config.sqs.wagerQueueUrl,
              MessageBody: envelope(request(w, 'BET', `k${i}-bet-${j}`, '1.00', { playerId: `player-k${i}` }), `k-${w}-${j}`),
              MessageGroupId: w,
              MessageDeduplicationId: crypto.randomUUID(),
            }),
          ),
        ),
      ),
    );

    // Mata um processo SEM aviso (kill -9) assim que o consumo começou.
    await waitUntil(async () => (await count(orm, `wager_transactions where external_transaction_id like 'k%-bet-%'`)) >= 3, 20_000);
    apps.get(PORTS[0]!)!.kill('SIGKILL');
    await apps.get(PORTS[0]!)!.exited;

    // "Reinício do serviço": sobe de novo no mesmo lugar.
    start(PORTS[0]!);
    await waitReady(PORTS[0]!);

    // Consistência final: todas as 40 aplicadas UMA vez e todos os eventos publicados.
    await waitUntil(async () => (await count(orm, `wager_transactions where external_transaction_id like 'k%-bet-%'`)) === 40, 60_000);
    await waitUntil(async () => (await count(orm, `outbox_events where published_at is null`)) === 0, 20_000);
    for (const w of wallets) expect(await balanceOf(orm, w)).toBe('90.00');
    expect(await count(orm, `wallet_ledger_entries l join wallets w on w.id = l.wallet_id where w.player_id like 'player-k%' and l.direction = 'DEBIT'`)).toBe(40);
    expect(await count(orm, `inbox_messages where message_id like 'k-%'`)).toBe(40);
    await assertLedgerInvariant(orm);
  }, 120_000);
});
