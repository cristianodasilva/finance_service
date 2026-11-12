import { Migration } from '@mikro-orm/migrations';

/**
 * Migration 2: tabela de DIVERGÊNCIAS encontradas pela reconciliação.
 *
 * A reconciliação NUNCA corrige o saldo sozinha. Ela apenas registra aqui o que encontrou,
 * para uma pessoa investigar. Corrigir automaticamente poderia esconder um bug
 * ou uma fraude — e apagaria a evidência.
 */
export class Migration20261112200000_reconciliation extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table reconciliation_divergences (
        id                uuid primary key,
        wallet_id         uuid not null references wallets(id),
        -- O que está gravado na carteira...
        stored_balance    numeric(20,2) not null,
        stored_version    integer not null,
        -- ...e o que o extrato diz que deveria ser.
        ledger_balance    numeric(20,2) not null,
        ledger_version    integer not null,
        -- OPEN = aguardando análise; RESOLVED = alguém analisou e resolveu.
        status            text not null default 'OPEN',
        first_detected_at timestamptz not null default now(),
        last_detected_at  timestamptz not null default now(),
        times_detected    integer not null default 1,

        constraint reconciliation_status_valid check (status in ('OPEN', 'RESOLVED'))
      );
    `);
    // No máximo UMA divergência ABERTA por carteira (as próximas execuções só atualizam a existente).
    this.addSql(`
      create unique index reconciliation_one_open_per_wallet
        on reconciliation_divergences (wallet_id) where status = 'OPEN';
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists reconciliation_divergences;`);
  }
}
