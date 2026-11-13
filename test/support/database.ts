import { Logger } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import baseConfig from '../../src/database/mikro-orm.config';

// Nos testes, mostra apenas avisos e erros.
Logger.overrideLogger((process.env.TEST_LOG ?? 'warn,error').split(',') as never);

/** Banco SEPARADO para os testes (finance_test). PostgreSQL de verdade, sem simulações. */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://finance:finance@localhost:5432/finance';
export const TEST_DATABASE_URL = ADMIN_URL.replace(/\/[^/]+$/, '/finance_test');

let prepared: Promise<void> | null = null;

/** Cria o banco de testes (se não existir) e aplica as migrations — uma vez por execução. */
export function prepareDatabase(): Promise<void> {
  prepared ??= (async () => {
    const admin = await MikroORM.init({ ...baseConfig, clientUrl: ADMIN_URL, debug: false });
    const exists = await admin.em.execute(`select 1 from pg_database where datname = 'finance_test'`);
    if (exists.length === 0) await admin.em.execute(`create database finance_test`);
    await admin.close();
    const orm = await MikroORM.init({ ...baseConfig, clientUrl: TEST_DATABASE_URL, debug: false });
    await orm.migrator.up();
    await orm.close();
  })();
  return prepared;
}

/**
 * N conexões independentes com o banco. Cada uma simula uma INSTÂNCIA diferente da
 * aplicação (outro servidor): pool próprio, memória própria (Identity Map próprio).
 */
export async function createInstances(count: number): Promise<MikroORM[]> {
  await prepareDatabase();
  return Promise.all(
    Array.from({ length: count }, () =>
      MikroORM.init({ ...baseConfig, clientUrl: TEST_DATABASE_URL, debug: false, pool: { min: 1, max: 10 } }),
    ),
  );
}

/** Apaga todos os dados entre os testes (TRUNCATE não dispara as triggers de linha do extrato). */
export async function resetDatabase(orm: MikroORM): Promise<void> {
  await orm.em.execute(
    `truncate table reconciliation_divergences, outbox_events, inbox_messages,
       wallet_ledger_entries, wager_transactions, wallets restart identity cascade`,
  );
}

/**
 * INVARIANTE FINAL (exigido em todos os testes): para CADA carteira,
 *   saldo gravado == saldo reconstruído pelo extrato,
 *   versão == 1 + movimentos após a abertura,
 *   e o extrato é uma corrente sem buracos (balance_before de cada linha == balance_after da anterior).
 */
export async function assertLedgerInvariant(orm: MikroORM): Promise<void> {
  const broken = await orm.em.fork().execute(`
    with chain as (
      select wallet_id, wallet_version, balance_before, balance_after,
             lag(balance_after) over (partition by wallet_id order by wallet_version) as previous_after,
             lag(wallet_version) over (partition by wallet_id order by wallet_version) as previous_version
        from wallet_ledger_entries
    ),
    per_wallet as (
      select w.id, w.balance, w.version,
             coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0) as rebuilt,
             coalesce(max(l.wallet_version), 1) as expected_version
        from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
       group by w.id
    )
    select 'balance/version' as problem, id::text as wallet_id from per_wallet
     where balance <> rebuilt or version <> expected_version
    union all
    select 'broken chain', wallet_id::text from chain
     where (previous_after is not null and balance_before <> previous_after)
        or (previous_version is not null and wallet_version <> previous_version + 1)
  `);
  if (broken.length > 0) {
    throw new Error(`Ledger invariant violated: ${JSON.stringify(broken)}`);
  }
}
