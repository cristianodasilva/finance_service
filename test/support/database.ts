import { Logger } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';

// Nos testes, mostra apenas avisos e erros (esconde os logs de "retrying").
Logger.overrideLogger(['warn', 'error']);
import baseConfig from '../../src/database/mikro-orm.config';

/**
 * Banco SEPARADO para os testes (finance_test), para nunca apagar dados de desenvolvimento.
 * Os testes usam o PostgreSQL de verdade (o do docker compose), sem simulações.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgresql://finance:finance@localhost:5432/finance';
export const TEST_DATABASE_URL = ADMIN_URL.replace(/\/[^/]+$/, '/finance_test');

let prepared = false;

/** Cria o banco de testes (se não existir) e aplica as migrations, uma vez por execução. */
async function prepareDatabase(): Promise<void> {
  if (prepared) return;
  const admin = await MikroORM.init({ ...baseConfig, clientUrl: ADMIN_URL, debug: false });
  const exists = await admin.em.execute(`select 1 from pg_database where datname = 'finance_test'`);
  if (exists.length === 0) await admin.em.execute(`create database finance_test`);
  await admin.close();

  const orm = await MikroORM.init({ ...baseConfig, clientUrl: TEST_DATABASE_URL, debug: false });
  await orm.migrator.up();
  await orm.close();
  prepared = true;
}

/**
 * Cria N conexões independentes com o banco.
 * Cada uma simula uma INSTÂNCIA diferente da aplicação (outro servidor),
 * com o seu próprio pool de conexões e a sua própria memória.
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
    `truncate table reconciliation_divergences, outbox_events, inbox_messages, idempotency_keys,
       wallet_ledger_entries, wager_transactions, wallets restart identity cascade`,
  );
}
