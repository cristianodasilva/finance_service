import { Migration } from '@mikro-orm/migrations';

/**
 * Migration inicial: cria todas as tabelas do serviço.
 *
 * As regras críticas ficam NO BANCO (CHECK, UNIQUE, triggers), e não só no código.
 * Motivo: se um dia um bug passar pelas validações da aplicação,
 * o PostgreSQL recusa a gravação. O banco é a última linha de defesa.
 *
 * Valores em dinheiro usam numeric(20,2): decimal exato, 2 casas (centavos).
 * Nunca usamos float/real/double para dinheiro.
 */
export class Migration20261112000000_initial_schema extends Migration {
  override async up(): Promise<void> {
    // ------------------------------------------------------------------
    // 1) CARTEIRAS
    // ------------------------------------------------------------------
    this.addSql(`
      create table wallets (
        id          uuid primary key,
        player_id   text not null,
        currency    char(3) not null,
        balance     numeric(20,2) not null default 0,
        version     integer not null default 0,
        created_at  timestamptz not null default now(),
        updated_at  timestamptz not null default now(),

        -- Saldo nunca negativo (protege mesmo se o código tiver bug).
        constraint wallets_balance_non_negative check (balance >= 0),
        constraint wallets_version_non_negative check (version >= 0),
        -- Uma carteira por jogador + moeda.
        constraint wallets_player_currency_unique unique (player_id, currency)
      );
    `);

    // ------------------------------------------------------------------
    // 2) TRANSAÇÕES DE APOSTA (o "pedido" que chega do provedor de jogos)
    // ------------------------------------------------------------------
    this.addSql(`
      create table wager_transactions (
        id                         uuid primary key,
        -- Quem enviou (provedor de jogos) e o id da transação no sistema dele.
        provider                   text not null,
        provider_transaction_id    text not null,
        kind                       text not null,
        status                     text not null,
        player_id                  text not null,
        wallet_id                  uuid not null references wallets(id),
        currency                   char(3) not null,
        amount                     numeric(20,2) not null,
        round_id                   text,
        -- Para ROLLBACK/WIN/REFUND: o id (no provedor) da transação referenciada...
        reference_provider_transaction_id text,
        -- ...e, depois de encontrada, o nosso id interno dela.
        referenced_transaction_id  uuid references wager_transactions(id),
        failure_code               text,
        -- Controle de novas tentativas (para PENDING_REFERENCE).
        attempts                   integer not null default 0,
        next_attempt_at            timestamptz,
        created_at                 timestamptz not null default now(),
        updated_at                 timestamptz not null default now(),
        processed_at               timestamptz,

        constraint wager_tx_kind_valid check (
          kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')
        ),
        constraint wager_tx_status_valid check (
          status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')
        ),
        -- Valor nunca negativo. Zero só é permitido em LOSS (perda não move saldo).
        constraint wager_tx_amount_valid check (
          amount > 0 or (amount = 0 and kind = 'LOSS')
        ),
        -- Transação rejeitada/falha precisa dizer o motivo (código estável).
        constraint wager_tx_failure_code_required check (
          status not in ('REJECTED', 'FAILED') or failure_code is not null
        ),
        -- Tipos que dependem de outra transação precisam informar a referência.
        constraint wager_tx_reference_required check (
          kind not in ('ROLLBACK', 'WIN', 'REFUND')
          or reference_provider_transaction_id is not null
        ),
        -- O mesmo provedor não pode mandar duas transações com o mesmo id.
        constraint wager_tx_provider_unique unique (provider, provider_transaction_id)
      );
    `);

    // Um ROLLBACK só pode desfazer uma transação UMA vez (índice único parcial:
    // vale apenas para linhas que são ROLLBACK processado).
    this.addSql(`
      create unique index wager_tx_single_rollback
        on wager_transactions (referenced_transaction_id)
        where kind = 'ROLLBACK' and status = 'PROCESSED';
    `);
    // Acelera a busca de transações aguardando nova tentativa.
    this.addSql(`
      create index wager_tx_pending_reference_idx
        on wager_transactions (next_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`create index wager_tx_wallet_idx on wager_transactions (wallet_id, created_at);`);

    // Estados finais (PROCESSED, REJECTED, FAILED) não podem mudar.
    this.addSql(`
      create function wager_tx_forbid_terminal_change() returns trigger
      language plpgsql as $$
      begin
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') and new.status is distinct from old.status then
          raise exception 'wager_transactions: status % is terminal and cannot change to %', old.status, new.status;
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wager_tx_terminal_status_guard
        before update on wager_transactions
        for each row execute function wager_tx_forbid_terminal_change();
    `);

    // ------------------------------------------------------------------
    // 3) EXTRATO (ledger): cada movimento de saldo vira UMA linha imutável
    // ------------------------------------------------------------------
    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid primary key,
        wallet_id       uuid not null references wallets(id),
        transaction_id  uuid not null references wager_transactions(id),
        -- CREDIT = entrou dinheiro; DEBIT = saiu dinheiro.
        direction       text not null,
        amount          numeric(20,2) not null,
        -- Saldo da carteira logo depois deste movimento (facilita auditoria).
        balance_after   numeric(20,2) not null,
        -- Versão da carteira depois deste movimento.
        wallet_version  integer not null,
        created_at      timestamptz not null default now(),

        constraint ledger_direction_valid check (direction in ('CREDIT', 'DEBIT')),
        constraint ledger_amount_positive check (amount > 0),
        constraint ledger_balance_after_non_negative check (balance_after >= 0),
        -- No máximo UMA linha por carteira + transação (nunca debita duas vezes).
        constraint ledger_wallet_transaction_unique unique (wallet_id, transaction_id),
        -- Cada versão da carteira corresponde a exatamente um movimento.
        constraint ledger_wallet_version_unique unique (wallet_id, wallet_version)
      );
    `);
    // Usado pela paginação do extrato (ordem cronológica por carteira).
    this.addSql(`create index ledger_wallet_created_idx on wallet_ledger_entries (wallet_id, created_at, id);`);

    // Extrato é imutável: proíbe UPDATE e DELETE.
    this.addSql(`
      create function ledger_forbid_mutation() returns trigger
      language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries is append-only: % is not allowed', tg_op;
      end;
      $$;
    `);
    this.addSql(`
      create trigger ledger_append_only
        before update or delete on wallet_ledger_entries
        for each row execute function ledger_forbid_mutation();
    `);

    // ------------------------------------------------------------------
    // 4) IDEMPOTÊNCIA (requisições HTTP com o header Idempotency-Key)
    // ------------------------------------------------------------------
    this.addSql(`
      create table idempotency_keys (
        key              text primary key,
        -- "Impressão digital" (hash) do corpo da requisição. Mesma chave com
        -- hash diferente = conflito (o cliente reutilizou a chave para outra coisa).
        request_hash     text not null,
        transaction_id   uuid references wager_transactions(id),
        response_status  integer,
        response_body    jsonb,
        created_at       timestamptz not null default now()
      );
    `);

    // ------------------------------------------------------------------
    // 5) INBOX (mensagens já recebidas da fila SQS, para não processar duas vezes)
    // ------------------------------------------------------------------
    this.addSql(`
      create table inbox_messages (
        message_id      text primary key,
        source          text not null,
        transaction_id  uuid references wager_transactions(id),
        received_at     timestamptz not null default now()
      );
    `);

    // ------------------------------------------------------------------
    // 6) OUTBOX (eventos a publicar, gravados junto com a mudança de saldo)
    // ------------------------------------------------------------------
    this.addSql(`
      create table outbox_events (
        id              uuid primary key,
        event_type      text not null,
        aggregate_type  text not null,
        aggregate_id    text not null,
        payload         jsonb not null,
        occurred_at     timestamptz not null default now(),
        -- Preenchido quando o worker publica com sucesso.
        published_at    timestamptz,
        attempts        integer not null default 0,
        last_error      text,
        -- Próxima vez que pode tentar publicar (espera entre falhas).
        available_at    timestamptz not null default now()
      );
    `);
    // O worker busca apenas eventos ainda não publicados, em ordem.
    this.addSql(`
      create index outbox_unpublished_idx
        on outbox_events (available_at, occurred_at)
        where published_at is null;
    `);
  }

  /** Desfaz tudo, na ordem inversa (por causa das chaves estrangeiras). */
  override async down(): Promise<void> {
    this.addSql(`drop table if exists outbox_events;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop table if exists idempotency_keys;`);
    this.addSql(`drop trigger if exists ledger_append_only on wallet_ledger_entries;`);
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop function if exists ledger_forbid_mutation();`);
    this.addSql(`drop trigger if exists wager_tx_terminal_status_guard on wager_transactions;`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop function if exists wager_tx_forbid_terminal_change();`);
    this.addSql(`drop table if exists wallets;`);
  }
}
