import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { assertLedgerInvariant, createInstances, resetDatabase } from '../support/database';

/**
 * Migrations e constraints: as garantias do desafio valem NO BANCO,
 * mesmo se alguém gravar direto por SQL, sem passar pela aplicação.
 */
let orm: MikroORM;

beforeAll(async () => {
  [orm] = (await createInstances(1)) as [MikroORM];
});
afterAll(async () => {
  await orm.close();
});
beforeEach(async () => {
  await resetDatabase(orm);
});

describe('Migrations', () => {
  test('são reversíveis: down até o início e up de novo', async () => {
    const all = await orm.migrator.getExecuted();
    expect(all.length).toBeGreaterThanOrEqual(3);
    await orm.migrator.down({ to: 0 });
    const [{ n }] = (await orm.em.execute(
      `select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name <> 'mikro_orm_migrations'`,
    )) as [{ n: number }];
    expect(n).toBe(0);
    await orm.migrator.up();
    expect((await orm.migrator.getPending()).length).toBe(0);
  });
});

describe('Constraints', () => {
  const W = '00000000-0000-0000-0000-000000000001';
  const BET = '00000000-0000-0000-0000-0000000000a1';

  /** Executa um SQL que DEVE falhar e devolve a mensagem de erro do PostgreSQL. */
  async function mustFail(sql: string): Promise<string> {
    try {
      await orm.em.fork().execute(sql);
    } catch (e) {
      return (e as Error).message;
    }
    throw new Error(`Expected SQL to fail: ${sql}`);
  }

  async function seed(): Promise<void> {
    const em = orm.em.fork();
    await em.execute(`insert into wallets (id, player_id, currency, balance, version) values ('${W}', 'p1', 'BRL', 20, 2)`);
    await em.execute(`
      insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, kind, status,
        player_id, wallet_id, currency, amount, round_id, game_id, resulting_balance, processed_at)
      values ('${BET}', 'prov', 'bet-1', 'prov:bet-1', 'h', 'BET', 'PROCESSED', 'p1', '${W}', 'BRL', 80, 'r1', 'g1', 20, now())`);
    await em.execute(`
      insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, wallet_version)
      values ('00000000-0000-0000-0000-0000000000e1', '${W}', '${BET}', 'DEBIT', 80, 100, 20, 2)`);
  }

  const tx = (id: string, extra: Record<string, string>) => {
    const row: Record<string, string> = {
      id: `'${id}'`, provider_id: `'prov'`, external_transaction_id: `'${id}'`, idempotency_key: `'${id}'`, payload_hash: `'h'`,
      kind: `'BET'`, status: `'PENDING'`, player_id: `'p1'`, wallet_id: `'${W}'`, currency: `'BRL'`, amount: '1',
      round_id: `'r1'`, game_id: `'g1'`, resulting_balance: '0', ...extra,
    };
    return `insert into wager_transactions (${Object.keys(row).join(',')}) values (${Object.values(row).join(',')})`;
  };

  test('saldo nunca negativo', async () => {
    await seed();
    expect(await mustFail(`update wallets set balance = -0.01`)).toContain('wallets_balance_non_negative');
  });

  test('versão começa em 1', async () => {
    expect(await mustFail(`insert into wallets (id, player_id, currency, balance, version) values ('${W}', 'p', 'BRL', 0, 0)`)).toContain(
      'wallets_version_positive',
    );
  });

  test('uma carteira por jogador + moeda', async () => {
    await seed();
    expect(await mustFail(`insert into wallets (id, player_id, currency) values ('00000000-0000-0000-0000-000000000002', 'p1', 'BRL')`)).toContain(
      'wallets_player_currency_unique',
    );
  });

  test('no máximo um lançamento por carteira + transação', async () => {
    await seed();
    expect(
      await mustFail(`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, wallet_version)
                      values ('00000000-0000-0000-0000-0000000000e2', '${W}', '${BET}', 'DEBIT', 1, 20, 19, 3)`),
    ).toContain('ledger_wallet_transaction_unique');
  });

  test('aritmética do lançamento: antes ± valor = depois', async () => {
    await seed();
    await orm.em.fork().execute(tx('00000000-0000-0000-0000-0000000000a2', { status: `'PROCESSED'` }));
    expect(
      await mustFail(`insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, wallet_version)
                      values ('00000000-0000-0000-0000-0000000000e3', '${W}', '00000000-0000-0000-0000-0000000000a2', 'DEBIT', 5, 20, 16, 3)`),
    ).toContain('ledger_arithmetic');
  });

  test('extrato imutável: UPDATE e DELETE bloqueados', async () => {
    await seed();
    expect(await mustFail(`update wallet_ledger_entries set amount = 1`)).toContain('append-only');
    expect(await mustFail(`delete from wallet_ledger_entries`)).toContain('append-only');
  });

  test('status final não muda', async () => {
    await seed();
    expect(await mustFail(`update wager_transactions set status = 'REJECTED', failure_code = 'X' where id = '${BET}'`)).toContain(
      'terminal',
    );
  });

  test('Idempotency-Key e (provider, externalTransactionId) únicos', async () => {
    await seed();
    expect(await mustFail(tx('00000000-0000-0000-0000-0000000000b1', { idempotency_key: `'prov:bet-1'` }))).toContain(
      'wager_tx_idempotency_key_unique',
    );
    expect(await mustFail(tx('00000000-0000-0000-0000-0000000000b2', { external_transaction_id: `'bet-1'` }))).toContain(
      'wager_tx_provider_unique',
    );
  });

  test('REFUND/ROLLBACK sem referência e valor zero fora de LOSS são recusados', async () => {
    await seed();
    expect(await mustFail(tx('00000000-0000-0000-0000-0000000000c1', { kind: `'REFUND'` }))).toContain('wager_tx_reference_required');
    expect(await mustFail(tx('00000000-0000-0000-0000-0000000000c2', { amount: '0' }))).toContain('wager_tx_amount_valid');
  });

  test('uma transação só pode ser revertida UMA vez (REFUND e ROLLBACK da mesma BET → bloqueado)', async () => {
    await seed();
    const reversal = (id: string, kind: string) =>
      tx(id, { kind: `'${kind}'`, status: `'PROCESSED'`, amount: '80', reference_external_transaction_id: `'bet-1'`, reference_transaction_id: `'${BET}'` });
    await orm.em.fork().execute(reversal('00000000-0000-0000-0000-0000000000d1', 'REFUND'));
    expect(await mustFail(reversal('00000000-0000-0000-0000-0000000000d2', 'ROLLBACK'))).toContain('wager_tx_single_reversal');
  });

  afterAll(async () => {
    await resetDatabase(orm);
    await assertLedgerInvariant(orm);
  });
});
