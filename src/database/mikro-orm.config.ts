import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';

/**
 * Configuração do MikroORM (a ORM que conversa com o PostgreSQL).
 *
 * Este mesmo arquivo é usado em dois lugares:
 *  - pela aplicação NestJS (ver app.module.ts);
 *  - pela linha de comando do MikroORM, para criar e rodar migrations.
 */
export default defineConfig({
  // Endereço do banco, lido do arquivo .env (o Bun carrega o .env sozinho).
  clientUrl: process.env.DATABASE_URL ?? 'postgresql://finance:finance@localhost:5432/finance',

  // Lista de entidades (tabelas). Ainda vazia: vamos preencher na próxima sub-etapa.
  entities: [],
  discovery: { warnWhenNoEntities: false },

  // Grava e lê datas sempre em UTC, evitando confusão de fuso horário.
  forceUtcTimezone: true,

  // Ativa o módulo de migrations.
  extensions: [Migrator],
  migrations: {
    path: './migrations',
    pathTs: './migrations',
    // Cada migration roda dentro de uma transação: se falhar no meio, nada é aplicado.
    transactional: true,
  },

  // Mostra os SQLs no console quando DEBUG_SQL=true (útil para estudar).
  debug: process.env.DEBUG_SQL === 'true',
});
