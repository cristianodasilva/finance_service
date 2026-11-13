import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ReconciliationService } from '../../src/reconciliation/reconciliation.service';
import { ProcessWagerService } from '../../src/wagering/process-wager.service';
import { WalletsService } from '../../src/wallets/wallets.service';
import { assertLedgerInvariant, createInstances, resetDatabase } from '../support/database';
import { openWallet, request, submit } from '../support/fixtures';

let orm: MikroORM;
let reconciliation: ReconciliationService;
let tamperedWallet: string | null = null;

beforeAll(async () => {
  [orm] = (await createInstances(1)) as [MikroORM];
  reconciliation = new ReconciliationService(orm.em);
});
afterAll(async () => {
  await orm.close();
});
beforeEach(async () => {
  await resetDatabase(orm);
  tamperedWallet = null;
});
afterEach(async () => {
  if (tamperedWallet) await orm.em.fork().execute(`update wallets set balance = 95.00 where id = ?`, [tamperedWallet]);
  await assertLedgerInvariant(orm);
});

/** 100.00 + 5 BETs de 1.00 → 6 lançamentos (versões 1..6). */
async function walletWithMovements(): Promise<string> {
  const w = await openWallet(orm, '100.00');
  const svc = new ProcessWagerService(orm.em);
  for (let i = 1; i <= 5; i++) await submit(svc, request(w, 'BET', `bet-${i}`, '1.00'));
  return w;
}

describe('Extrato paginado (cursor)', () => {
  test('percorre todas as páginas sem repetir nem pular', async () => {
    const w = await walletWithMovements();
    const wallets = new WalletsService(orm.em);
    const seen: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await wallets.ledger(w, { limit: 2, cursor });
      seen.push(...page.items.map((i) => i.walletVersion));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual([6, 5, 4, 3, 2, 1]);
  });

  test('cada item traz money, balanceBefore e balanceAfter no formato de contrato', async () => {
    const w = await walletWithMovements();
    const { items } = await new WalletsService(orm.em).ledger(w, { limit: 1 });
    expect(items[0]).toMatchObject({
      direction: 'DEBIT',
      transactionKind: 'BET',
      money: { amount: '1.00', currency: 'BRL' },
      balanceBefore: { amount: '96.00', currency: 'BRL' },
      balanceAfter: { amount: '95.00', currency: 'BRL' },
    });
  });
});

describe('Reconciliação', () => {
  test('consistente: formato do contrato', async () => {
    const w = await walletWithMovements();
    expect(await reconciliation.reconcileWallet(w)).toMatchObject({
      walletId: w,
      storedBalance: { amount: '95.00', currency: 'BRL' },
      calculatedBalance: { amount: '95.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 6,
    });
  });

  test('carteira aberta sem saldo (versão 1, nenhum lançamento) é consistente', async () => {
    const w = await openWallet(orm, '0.00');
    expect(await reconciliation.reconcileWallet(w)).toMatchObject({ consistent: true, checkedEntries: 0, storedVersion: 1 });
  });

  test('divergência: sinalizada na resposta, logada, registrada — e NUNCA corrigida', async () => {
    const w = await walletWithMovements();
    tamperedWallet = w;
    await orm.em.fork().execute(`update wallets set balance = 999.99 where id = ?`, [w]); // alguém mexeu por fora

    const result = await reconciliation.reconcileWallet(w);
    expect(result).toMatchObject({ consistent: false, difference: { amount: '904.99', currency: 'BRL' } });
    await reconciliation.reconcileWallet(w);
    const open = await reconciliation.openDivergences();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ walletId: w, timesDetected: 2 });
    const [row] = await orm.em.fork().execute(`select balance::text from wallets where id = ?`, [w]);
    expect(row!.balance).toBe('999.99'); // não corrigiu
  });
});
