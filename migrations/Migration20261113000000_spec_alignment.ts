import { Migration } from '@mikro-orm/migrations';

/**
 * Migration 3: alinha o schema ao contrato do desafio.
 *
 *  - wallets: `version` começa em 1;
 *  - wager_transactions: nomes do contrato (provider_id, external_transaction_id...),
 *    idempotency_key + payload_hash NA PRÓPRIA transação (fonte da verdade da idempotência),
 *    game_id, saldo observado no momento da decisão (para o replay), e UMA reversão por referência;
 *  - wallet_ledger_entries: balance_before + CHECK da aritmética (antes ± valor = depois);
 *  - inbox_messages: chave (consumer_name, message_id) + payload_hash + processed_at;
 *  - outbox_events: available_at → next_attempt_at;
 *  - idempotency_keys: removida (a chave agora vive em wager_transactions, com UNIQUE).
 *
 * Dados existentes são convertidos (backfill), e o `down` desfaz tudo.
 */
export class Migration20261113000000_spec_alignment extends Migration {
  override async up(): Promise<void> {
    // ------------------------------------------------------------------ wallets
    this.addSql(`update wallets set version = 1 where version = 0;`);
    this.addSql(`alter table wallets alter column version set default 1;`);
    this.addSql(`alter table wallets drop constraint wallets_version_non_negative;`);
    this.addSql(`alter table wallets add constraint wallets_version_positive check (version >= 1);`);

    // ------------------------------------------------------------------ wager_transactions
    this.addSql(`alter table wager_transactions rename column provider to provider_id;`);
    this.addSql(`alter table wager_transactions rename column provider_transaction_id to external_transaction_id;`);
    this.addSql(
      `alter table wager_transactions rename column reference_provider_transaction_id to reference_external_transaction_id;`,
    );
    this.addSql(`alter table wager_transactions rename column referenced_transaction_id to reference_transaction_id;`);
    this.addSql(`
      alter table wager_transactions
        add column idempotency_key   text,
        add column payload_hash      text,
        add column game_id           text,
        -- Saldo da carteira observado no momento da decisão: devolvido igual no replay.
        add column resulting_balance numeric(20,2);
    `);
    // Backfill dos dados existentes.
    this.addSql(`
      update wager_transactions t set
        idempotency_key = coalesce(
          (select k.key from idempotency_keys k where k.transaction_id = t.id limit 1),
          case when t.kind = 'OPENING' then 'internal:opening:' || t.wallet_id
               else t.provider_id || ':' || t.external_transaction_id end),
        payload_hash = 'legacy',
        game_id = case when t.kind = 'OPENING' then null else 'unknown' end,
        round_id = case when t.kind = 'OPENING' then null else coalesce(t.round_id, 'unknown') end,
        resulting_balance = coalesce(
          (select l.balance_after from wallet_ledger_entries l where l.transaction_id = t.id),
          (select w.balance from wallets w where w.id = t.wallet_id));
    `);
    this.addSql(`
      alter table wager_transactions
        alter column idempotency_key set not null,
        alter column payload_hash set not null,
        alter column resulting_balance set not null;
    `);
    this.addSql(`alter table wager_transactions drop constraint wager_tx_reference_required;`);
    this.addSql(`
      alter table wager_transactions
        -- REFUND e ROLLBACK precisam dizer o que revertem (WIN/LOSS: opcional).
        add constraint wager_tx_reference_required check (
          kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        -- Transações do provedor sempre têm rodada e jogo (OPENING é interno).
        add constraint wager_tx_round_game_required check (
          kind = 'OPENING' or (round_id is not null and game_id is not null)),
        add constraint wager_tx_resulting_balance_non_negative check (resulting_balance >= 0),
        add constraint wager_tx_payload_hash_present check (length(payload_hash) > 0),
        -- A Idempotency-Key é a fonte da verdade: nunca duas transações com a mesma chave.
        add constraint wager_tx_idempotency_key_unique unique (idempotency_key);
    `);
    // Uma transação só pode ser revertida UMA vez — por REFUND ou por ROLLBACK, nunca pelos dois
    // (é o que impede crédito duplicado: REFUND e depois ROLLBACK da mesma BET).
    this.addSql(`drop index wager_tx_single_rollback;`);
    this.addSql(`
      create unique index wager_tx_single_reversal
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED';
    `);
    this.addSql(`create index wager_tx_reference_lookup_idx on wager_transactions (provider_id, reference_external_transaction_id);`);

    // ------------------------------------------------------------------ wallet_ledger_entries
    // O extrato é append-only: a trigger é desligada APENAS durante este backfill.
    this.addSql(`alter table wallet_ledger_entries disable trigger ledger_append_only;`);
    this.addSql(`alter table wallet_ledger_entries add column balance_before numeric(20,2);`);
    this.addSql(`
      update wallet_ledger_entries set balance_before =
        case direction when 'CREDIT' then balance_after - amount else balance_after + amount end;
    `);
    this.addSql(`alter table wallet_ledger_entries enable trigger ledger_append_only;`);
    this.addSql(`
      alter table wallet_ledger_entries
        alter column balance_before set not null,
        add constraint ledger_balance_before_non_negative check (balance_before >= 0),
        -- A aritmética de cada lançamento é garantida pelo banco.
        add constraint ledger_arithmetic check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT'  and balance_after = balance_before - amount));
    `);

    // ------------------------------------------------------------------ inbox_messages
    this.addSql(`alter table inbox_messages rename to inbox_messages_v1;`);
    this.addSql(`
      create table inbox_messages (
        consumer_name  text not null,
        message_id     text not null,
        payload_hash   text not null,
        transaction_id uuid references wager_transactions(id),
        received_at    timestamptz not null default now(),
        processed_at   timestamptz,
        -- Deduplicação por (consumidor, mensagem).
        primary key (consumer_name, message_id)
      );
    `);
    this.addSql(`
      insert into inbox_messages (consumer_name, message_id, payload_hash, transaction_id, received_at, processed_at)
      select 'wager-transactions-consumer', message_id, 'legacy', transaction_id, received_at, received_at
        from inbox_messages_v1;
    `);
    this.addSql(`drop table inbox_messages_v1;`);

    // ------------------------------------------------------------------ outbox_events
    this.addSql(`alter table outbox_events rename column available_at to next_attempt_at;`);
    this.addSql(`alter table outbox_events drop column aggregate_type;`);

    // ------------------------------------------------------------------ idempotency_keys
    this.addSql(`drop table idempotency_keys;`);
  }

  override async down(): Promise<void> {
    this.addSql(`
      create table idempotency_keys (
        key text primary key, request_hash text not null,
        transaction_id uuid references wager_transactions(id),
        response_status integer, response_body jsonb, created_at timestamptz not null default now());
    `);
    this.addSql(`
      insert into idempotency_keys (key, request_hash, transaction_id)
      select idempotency_key, payload_hash, id from wager_transactions where kind <> 'OPENING';
    `);

    this.addSql(`alter table outbox_events add column aggregate_type text not null default 'unknown';`);
    this.addSql(`alter table outbox_events rename column next_attempt_at to available_at;`);

    this.addSql(`alter table inbox_messages rename to inbox_messages_v2;`);
    this.addSql(`
      create table inbox_messages (
        message_id text primary key, source text not null,
        transaction_id uuid references wager_transactions(id), received_at timestamptz not null default now());
    `);
    this.addSql(`
      insert into inbox_messages (message_id, source, transaction_id, received_at)
      select message_id, 'sqs', transaction_id, received_at from inbox_messages_v2 on conflict do nothing;
    `);
    this.addSql(`drop table inbox_messages_v2;`);

    this.addSql(`
      alter table wallet_ledger_entries
        drop constraint ledger_arithmetic,
        drop constraint ledger_balance_before_non_negative;
    `);
    this.addSql(`alter table wallet_ledger_entries disable trigger ledger_append_only;`);
    this.addSql(`alter table wallet_ledger_entries drop column balance_before;`);
    this.addSql(`alter table wallet_ledger_entries enable trigger ledger_append_only;`);

    this.addSql(`drop index if exists wager_tx_reference_lookup_idx;`);
    this.addSql(`drop index if exists wager_tx_single_reversal;`);
    this.addSql(`
      create unique index wager_tx_single_rollback on wager_transactions (reference_transaction_id)
        where kind = 'ROLLBACK' and status = 'PROCESSED';
    `);
    this.addSql(`
      alter table wager_transactions
        drop constraint wager_tx_idempotency_key_unique,
        drop constraint wager_tx_payload_hash_present,
        drop constraint wager_tx_resulting_balance_non_negative,
        drop constraint wager_tx_round_game_required,
        drop constraint wager_tx_reference_required;
    `);
    this.addSql(`
      alter table wager_transactions add constraint wager_tx_reference_required check (
        kind not in ('ROLLBACK', 'WIN', 'REFUND') or reference_external_transaction_id is not null) not valid;
    `);
    this.addSql(`
      alter table wager_transactions
        drop column resulting_balance, drop column game_id, drop column payload_hash, drop column idempotency_key;
    `);
    this.addSql(`alter table wager_transactions rename column reference_transaction_id to referenced_transaction_id;`);
    this.addSql(
      `alter table wager_transactions rename column reference_external_transaction_id to reference_provider_transaction_id;`,
    );
    this.addSql(`alter table wager_transactions rename column external_transaction_id to provider_transaction_id;`);
    this.addSql(`alter table wager_transactions rename column provider_id to provider;`);

    this.addSql(`alter table wallets drop constraint wallets_version_positive;`);
    this.addSql(`alter table wallets add constraint wallets_version_non_negative check (version >= 0);`);
    this.addSql(`alter table wallets alter column version set default 0;`);
  }
}
