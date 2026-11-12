import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Currency } from '../../src/domain/money/currency';
import { Money } from '../../src/domain/money/money';
import { ReconciliationService } from '../../src/reconciliation/reconciliation.service';
import { ProcessWagerService } from '../../src/wagering/process-wager.service';
import { WalletsService } from '../../src/wallets/wallets.service';
import { createInstances, resetDatabase } from '../support/database';

let orm: MikroORM;
let wallets: WalletsService;
let wagers: ProcessWagerService;
let reconciliation: ReconciliationService;

beforeAll(async () => {
  [orm] = (await createInstances(1)) as [MikroORM];
  wallets = new WalletsService(orm.em);
  wagers = new ProcessWagerService(orm.em);
  reconciliation = new ReconciliationService(orm.em);
});
afterAll(async () => {
  await orm.close();
});
beforeEach(async () => {
  await resetDatabase(orm);
});

/** Carteira com 100.00 e 5 apostas de 1.00 → 6 movimentos no extrato (versões 1..6). */
async function walletWithMovements(): Promise<string> {
  const w = await wallets.create({ playerId: 'p1', currency: 'BRL', initialBalance: '100.00' });
  for (let i = 1; i <= 5; i++) {
    await wagers.execute(
      {
        provider: 'prov',
        providerTransactionId: `bet-${i}`,
        kind: 'BET',
        playerId: 'p1',
        walletId: w.id,
        amount: Money.fromDecimal('1.00', Currency.BRL),
        roundId: null,
        referenceProviderTransactionId: null,
      },
      { type: 'http', idempotencyKey: `k-${i}` },
    );
  }
  return w.id;
}

describe('Extrato paginado', () => {
  test('percorre todas as páginas sem repetir nem pular movimentos', async () => {
    const walletId = await walletWithMovements();
    const seen: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await wallets.ledger(walletId, { limit: 2, cursor });
      seen.push(...page.items.map((i) => i.walletVersion));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen).toEqual([6, 5, 4, 3, 2, 1]); // mais recente primeiro
  });

  test('primeiro item mostra o saldo atual e o tipo da transação', async () => {
    const walletId = await walletWithMovements();
    const { items } = await wallets.ledger(walletId, { limit: 1 });
    expect(items[0]).toMatchObject({ direction: 'DEBIT', amount: '1.00', balanceAfter: '95.00', transactionKind: 'BET' });
  });
});

describe('Reconciliação', () => {
  test('sem divergências quando saldo == extrato', async () => {
    await walletWithMovements();
    const report = await reconciliation.run();
    expect(report.checkedWallets).toBe(1);
    expect(report.divergences).toEqual([]);
  });

  test('detecta e SINALIZA divergência, mas NÃO corrige o saldo', async () => {
    const walletId = await walletWithMovements();
    // Simula um problema: alguém alterou o saldo direto no banco, por fora da aplicação.
    await orm.em.fork().execute(`update wallets set balance = 999.99 where id = ?`, [walletId]);

    const report = await reconciliation.run();
    expect(report.divergences).toEqual([
      { walletId, storedBalance: '999.99', ledgerBalance: '95.00', storedVersion: 6, ledgerVersion: 6 },
    ]);

    // Executa de novo: continua UMA divergência aberta, só com o contador atualizado.
    await reconciliation.run();
    const open = await reconciliation.openDivergences();
    expect(open.length).toBe(1);
    expect(open[0]).toMatchObject({ walletId, timesDetected: 2, status: 'OPEN' });

    // E o saldo continua como estava: a reconciliação nunca corrige sozinha.
    const [w] = await orm.em.fork().execute(`select balance::text from wallets where id = ?`, [walletId]);
    expect(w!.balance).toBe('999.99');
  });
});
