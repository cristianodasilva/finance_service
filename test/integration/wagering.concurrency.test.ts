import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { DomainError, FailureCode } from '../../src/domain/errors';
import { Currency } from '../../src/domain/money/currency';
import { Money } from '../../src/domain/money/money';
import type { WagerCommand } from '../../src/domain/wager/wager-rules';
import { ProcessWagerService } from '../../src/wagering/process-wager.service';
import { WalletsService } from '../../src/wallets/wallets.service';
import { createInstances, resetDatabase } from '../support/database';

/**
 * Testes de concorrência contra o PostgreSQL real.
 * Simulamos 3 instâncias da aplicação disputando a MESMA carteira ao mesmo tempo.
 */
let instances: MikroORM[];
let services: ProcessWagerService[];
let wallets: WalletsService;

beforeAll(async () => {
  instances = await createInstances(3);
  services = instances.map((orm) => new ProcessWagerService(orm.em));
  wallets = new WalletsService(instances[0]!.em);
});
afterAll(async () => {
  await Promise.all(instances.map((orm) => orm.close()));
});
beforeEach(async () => {
  await resetDatabase(instances[0]!);
});

const brl = (v: string) => Money.fromDecimal(v, Currency.BRL);
/** Distribui as chamadas entre as 3 "instâncias" (0, 1, 2, 0, 1, 2...). */
const instance = (i: number) => services[i % services.length]!;

function bet(walletId: string, id: string, amount: string): WagerCommand {
  return {
    provider: 'prov',
    providerTransactionId: id,
    kind: 'BET',
    playerId: 'player-1',
    walletId,
    amount: brl(amount),
    roundId: 'round-1',
    referenceProviderTransactionId: null,
  };
}

async function openWallet(balance: string): Promise<string> {
  const w = await wallets.create({ playerId: 'player-1', currency: 'BRL', initialBalance: balance });
  return w.id;
}

/** Lê do banco: saldo, extrato e o saldo "reconstruído" a partir do extrato. */
async function snapshot(walletId: string) {
  const em = instances[0]!.em.fork();
  const [wallet] = await em.execute(`select balance, version from wallets where id = ?`, [walletId]);
  const [ledger] = await em.execute(
    `select
       coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::text as rebuilt,
       count(*) filter (where direction = 'DEBIT')::int as debits
     from wallet_ledger_entries where wallet_id = ?`,
    [walletId],
  );
  if (!wallet || !ledger) throw new Error(`Wallet ${walletId} not found`);
  return {
    balance: wallet.balance as string,
    version: wallet.version as number,
    rebuiltFromLedger: Money.fromDecimal(ledger.rebuilt, Currency.BRL).toDecimal(),
    debits: ledger.debits as number,
  };
}

describe('Concorrência na mesma carteira', () => {
  test('CENÁRIO OBRIGATÓRIO: duas BETs de 80.00 simultâneas sobre 100.00 → 1 PROCESSED, 1 REJECTED, saldo 20.00', async () => {
    const walletId = await openWallet('100.00');

    const results = await Promise.all([
      instance(0).execute(bet(walletId, 'bet-A', '80.00'), { type: 'http', idempotencyKey: 'key-A' }),
      instance(1).execute(bet(walletId, 'bet-B', '80.00'), { type: 'http', idempotencyKey: 'key-B' }),
    ]);

    const statuses = results.map((r) => r.transaction.status).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    const rejected = results.find((r) => r.transaction.status === 'REJECTED')!;
    expect(rejected.transaction.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);

    const s = await snapshot(walletId);
    expect(s.balance).toBe('20.00');
    expect(s.debits).toBe(1);
    expect(s.rebuiltFromLedger).toBe('20.00'); // saldo == extrato
  });

  test('30 BETs de 10.00 simultâneas em 3 instâncias sobre 100.00 → exatamente 10 aceitas, saldo 0.00', async () => {
    const walletId = await openWallet('100.00');

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        instance(i).execute(bet(walletId, `bet-${i}`, '10.00'), { type: 'http', idempotencyKey: `key-${i}` }),
      ),
    );

    const processed = results.filter((r) => r.transaction.status === 'PROCESSED').length;
    const rejected = results.filter((r) => r.transaction.status === 'REJECTED');
    expect(processed).toBe(10);
    expect(rejected.length).toBe(20);
    expect(rejected.every((r) => r.transaction.failureCode === FailureCode.INSUFFICIENT_FUNDS)).toBe(true);

    const s = await snapshot(walletId);
    expect(s.balance).toBe('0.00');
    expect(s.debits).toBe(10);
    expect(s.rebuiltFromLedger).toBe(s.balance);
    expect(s.version).toBe(11); // 1 (abertura) + 10 débitos
  });

  test('ROLLBACK duplicado ao mesmo tempo → desfaz só UMA vez', async () => {
    const walletId = await openWallet('100.00');
    await instance(0).execute(bet(walletId, 'bet-1', '80.00'), { type: 'http', idempotencyKey: 'k-bet' });

    const rollback = (id: string): WagerCommand => ({
      ...bet(walletId, id, '80.00'),
      kind: 'ROLLBACK',
      referenceProviderTransactionId: 'bet-1',
    });
    const results = await Promise.all([
      instance(0).execute(rollback('rb-1'), { type: 'http', idempotencyKey: 'k-rb-1' }),
      instance(1).execute(rollback('rb-2'), { type: 'http', idempotencyKey: 'k-rb-2' }),
      instance(2).execute(rollback('rb-3'), { type: 'http', idempotencyKey: 'k-rb-3' }),
    ]);

    const statuses = results.map((r) => r.transaction.status).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED', 'REJECTED']);
    expect(results.filter((r) => r.transaction.failureCode === FailureCode.ALREADY_ROLLED_BACK).length).toBe(2);

    const s = await snapshot(walletId);
    expect(s.balance).toBe('100.00');
    expect(s.rebuiltFromLedger).toBe('100.00');
  });
});

describe('Idempotência', () => {
  test('mesma Idempotency-Key 5x ao mesmo tempo → processa uma vez, as outras são repetição', async () => {
    const walletId = await openWallet('100.00');
    const command = bet(walletId, 'bet-1', '30.00');

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => instance(i).execute(command, { type: 'http', idempotencyKey: 'same-key' })),
    );

    const ids = new Set(results.map((r) => r.transaction.id));
    expect(ids.size).toBe(1); // todas devolvem a MESMA transação
    expect(results.filter((r) => !r.replayed).length).toBe(1);
    expect((await snapshot(walletId)).balance).toBe('70.00'); // debitou uma vez só
  });

  test('mesma chave com conteúdo diferente → IDEMPOTENCY_KEY_REUSED (conflito, não repetição)', async () => {
    const walletId = await openWallet('100.00');
    await instance(0).execute(bet(walletId, 'bet-1', '30.00'), { type: 'http', idempotencyKey: 'k' });

    const error = await instance(1)
      .execute(bet(walletId, 'bet-1', '31.00'), { type: 'http', idempotencyKey: 'k' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(FailureCode.IDEMPOTENCY_KEY_REUSED);
  });

  test('mesmo id do provedor com outra chave → devolve a transação existente', async () => {
    const walletId = await openWallet('100.00');
    const first = await instance(0).execute(bet(walletId, 'bet-1', '30.00'), { type: 'http', idempotencyKey: 'k1' });
    const again = await instance(1).execute(bet(walletId, 'bet-1', '30.00'), { type: 'sqs', messageId: 'msg-1' });
    expect(again.transaction.id).toBe(first.transaction.id);
    expect(again.replayed).toBe(true);
    expect((await snapshot(walletId)).balance).toBe('70.00');
  });
});

describe('Referências', () => {
  test('WIN antes da BET → PENDING_REFERENCE, sem mexer no saldo', async () => {
    const walletId = await openWallet('100.00');
    const win: WagerCommand = { ...bet(walletId, 'win-1', '50.00'), kind: 'WIN', referenceProviderTransactionId: 'bet-x' };
    const result = await instance(0).execute(win, { type: 'http', idempotencyKey: 'k-win' });
    expect(result.transaction.status).toBe('PENDING_REFERENCE');
    expect(result.transaction.nextAttemptAt).toBeInstanceOf(Date);
    expect((await snapshot(walletId)).balance).toBe('100.00');
  });
});
