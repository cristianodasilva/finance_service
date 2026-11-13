import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { DomainError, FailureCode } from '../../src/domain/errors';
import type { ProcessWagerService } from '../../src/wagering/process-wager.service';
import { assertLedgerInvariant, createInstances, resetDatabase } from '../support/database';
import { balanceOf, count, openWallet, request, services, submit } from '../support/fixtures';

/**
 * Concorrência com PARALELISMO REAL contra o PostgreSQL: 3 "instâncias"
 * (pools de conexão independentes) disputando as mesmas carteiras.
 */
let instances: MikroORM[];
let svc: ProcessWagerService[];
const on = (i: number) => svc[i % svc.length]!;

beforeAll(async () => {
  instances = await createInstances(3);
  svc = services(instances);
});
afterAll(async () => {
  await Promise.all(instances.map((o) => o.close()));
});
beforeEach(async () => {
  await resetDatabase(instances[0]!);
});
// Invariante final de TODOS os testes: saldo == extrato reconstruído.
afterEach(async () => {
  await assertLedgerInvariant(instances[0]!);
});

const db = () => instances[0]!;

describe('Cenário obrigatório (seção 8)', () => {
  test('100.00 BRL, duas BETs de 80.00 simultâneas → 1 PROCESSED, 1 REJECTED, saldo 20.00, 1 DEBIT', async () => {
    const w = await openWallet(db(), '100.00');
    const results = await Promise.all([
      submit(on(0), request(w, 'BET', 'bet-A', '80.00')),
      submit(on(1), request(w, 'BET', 'bet-B', '80.00')),
    ]);
    expect(results.map((r) => r.transaction.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((r) => r.transaction.status === 'REJECTED')!.transaction.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(await balanceOf(db(), w)).toBe('20.00');
    expect(await count(db(), `wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [w])).toBe(1);

    // Nenhum retry duplica o débito: repetir as duas dá o mesmo resultado.
    const again = await Promise.all([
      submit(on(2), request(w, 'BET', 'bet-A', '80.00')),
      submit(on(0), request(w, 'BET', 'bet-B', '80.00')),
    ]);
    expect(again.every((r) => r.replayed)).toBe(true);
    expect(await count(db(), `wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [w])).toBe(1);
  });
});

describe('Concorrência', () => {
  test('a MESMA aposta enviada 50 vezes em paralelo → um único débito', async () => {
    const w = await openWallet(db(), '100.00');
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => submit(on(i), request(w, 'BET', 'bet-1', '30.00'))));
    expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed).length).toBe(1);
    expect(results.every((r) => r.balance.toJSON().amount === '70.00')).toBe(true);
    expect(await balanceOf(db(), w)).toBe('70.00');
    expect(await count(db(), `wallet_ledger_entries where direction = 'DEBIT'`)).toBe(1);
  });

  test('30 BETs diferentes de 10.00 em 3 instâncias sobre 100.00 → exatamente 10 aceitas', async () => {
    const w = await openWallet(db(), '100.00');
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => submit(on(i), request(w, 'BET', `bet-${i}`, '10.00'))));
    expect(results.filter((r) => r.transaction.status === 'PROCESSED').length).toBe(10);
    expect(results.filter((r) => r.transaction.failureCode === FailureCode.INSUFFICIENT_FUNDS).length).toBe(20);
    expect(await balanceOf(db(), w)).toBe('0.00');
  });

  test('carteiras DIFERENTES processadas em paralelo não se bloqueiam nem se misturam', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, (_, i) => openWallet(db(), '50.00', `player-${i}`)));
    await Promise.all(
      wallets.flatMap((w, i) =>
        Array.from({ length: 5 }, (_, j) => submit(on(i + j), request(w, 'BET', `w${i}-bet-${j}`, '10.00', { playerId: `player-${i}` }))),
      ),
    );
    for (const w of wallets) expect(await balanceOf(db(), w)).toBe('0.00');
    expect(await count(db(), `wallet_ledger_entries where direction = 'DEBIT'`)).toBe(50);
  });

  test('REFUND e ROLLBACK simultâneos da mesma BET → só UMA reversão (sem crédito duplicado)', async () => {
    const w = await openWallet(db(), '100.00');
    await submit(on(0), request(w, 'BET', 'bet-1', '80.00'));
    const ref = { referenceExternalTransactionId: 'bet-1' };
    const results = await Promise.all([
      submit(on(0), request(w, 'REFUND', 'refund-1', '80.00', ref)),
      submit(on(1), request(w, 'ROLLBACK', 'rollback-1', '80.00', ref)),
      submit(on(2), request(w, 'ROLLBACK', 'rollback-2', '80.00', ref)),
    ]);
    expect(results.filter((r) => r.transaction.status === 'PROCESSED').length).toBe(1);
    expect(results.filter((r) => r.transaction.failureCode === FailureCode.REFERENCE_ALREADY_REVERSED).length).toBe(2);
    expect(await balanceOf(db(), w)).toBe('100.00');
  });
});

describe('Idempotência', () => {
  test('replay devolve o resultado ORIGINAL, inclusive o saldo observado naquele momento', async () => {
    const w = await openWallet(db(), '100.00');
    const first = await submit(on(0), request(w, 'BET', 'bet-1', '30.00'));
    await submit(on(1), request(w, 'BET', 'bet-2', '50.00')); // o saldo muda depois
    const replay = await submit(on(2), request(w, 'BET', 'bet-1', '30.00'));
    expect(replay.replayed).toBe(true);
    expect(replay.transaction.id).toBe(first.transaction.id);
    expect(replay.balance.toJSON()).toEqual({ amount: '70.00', currency: 'BRL' }); // não 20.00
  });

  test('mesma Idempotency-Key com payload diferente → IDEMPOTENCY_KEY_REUSED (conflito, não replay)', async () => {
    const w = await openWallet(db(), '100.00');
    await submit(on(0), request(w, 'BET', 'bet-1', '30.00'), { type: 'http' }, 'my-key');
    const error = await submit(on(1), request(w, 'BET', 'bet-1', '31.00'), { type: 'http' }, 'my-key').catch((e) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(FailureCode.IDEMPOTENCY_KEY_REUSED);
  });

  test('mesmo externalTransactionId com outra chave e outro conteúdo → PROVIDER_TRANSACTION_CONFLICT', async () => {
    const w = await openWallet(db(), '100.00');
    await submit(on(0), request(w, 'BET', 'bet-1', '30.00'), { type: 'http' }, 'k1');
    const error = await submit(on(1), request(w, 'BET', 'bet-1', '99.00'), { type: 'http' }, 'k2').catch((e) => e);
    expect((error as DomainError).code).toBe(FailureCode.PROVIDER_TRANSACTION_CONFLICT);
  });
});
