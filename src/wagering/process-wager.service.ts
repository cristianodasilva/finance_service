import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  DeadlockException,
  EntityManager,
  UniqueConstraintViolationException,
} from '@mikro-orm/postgresql';
import { newId } from '../common/ids';
import { TransientError } from '../common/transient-error';
import { LedgerEntryRecord } from '../database/entities/ledger-entry.record';
import { WagerTransactionRecord } from '../database/entities/wager-transaction.record';
import { WalletRecord } from '../database/entities/wallet.record';
import { DomainError, FailureCode } from '../domain/errors';
import type { Currency } from '../domain/money/currency';
import { Money } from '../domain/money/money';
import type { Wallet } from '../domain/wallet/wallet';
import { requiresReference } from '../domain/wager/wager-kind';
import { decideWager, type ReferenceSnapshot, type WagerCommand, type WagerDecision } from '../domain/wager/wager-rules';
import type { DomainEvent } from '../events/domain-event';
import { WalletBalanceChanged } from '../events/wallet-balance-changed.event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  type WagerTransactionEventPayload,
} from '../events/wager-transaction.events';
import { addToOutbox } from '../outbox/outbox.writer';
import { WalletMapper } from '../wallets/wallet.mapper';

/**
 * De onde veio o pedido. Cada origem tem a sua forma de evitar duplicatas:
 *  - http: o cliente manda o header Idempotency-Key  → tabela idempotency_keys
 *  - sqs:  cada mensagem da fila tem um id único      → tabela inbox_messages
 */
export type WagerSource = { type: 'http'; idempotencyKey: string } | { type: 'sqs'; messageId: string };

export interface WagerResult {
  transaction: WagerTransactionRecord;
  /** true = este pedido já tinha sido processado antes; devolvemos o mesmo resultado. */
  replayed: boolean;
}

/**
 * Lançado quando outra operação alterou a carteira entre a nossa leitura e a nossa escrita
 * (o UPDATE ... WHERE version = X não encontrou a linha). A solução é recomeçar do zero.
 */
class ConcurrentModificationError extends Error {}

/** Quantas vezes recomeçamos antes de desistir (e responder 503). */
const MAX_ATTEMPTS = 25;

/** Primeira espera antes de tentar de novo uma transação PENDING_REFERENCE. */
const FIRST_REFERENCE_RETRY_MS = 2_000;

@Injectable()
export class ProcessWagerService {
  private readonly logger = new Logger(ProcessWagerService.name);

  constructor(private readonly em: EntityManager) {}

  /**
   * Processa uma transação de aposta. Usado tanto pela API HTTP quanto pelo consumidor da fila.
   *
   * Tudo roda dentro de UMA transação do banco. Se outra operação mexer na mesma carteira
   * ao mesmo tempo, detectamos pelo campo `version` e recomeçamos (optimistic locking).
   */
  async execute(command: WagerCommand, source: WagerSource): Promise<WagerResult> {
    const requestHash = hashCommand(command);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Cada tentativa usa uma transação nova (e um EntityManager limpo).
        return await this.em.fork().transactional((tx) => this.attempt(tx, command, source, requestHash));
      } catch (error) {
        if (!isRetryable(error)) throw error;
        this.logger.debug(
          `Concurrent modification on wallet ${command.walletId} (attempt ${attempt}/${MAX_ATTEMPTS}), retrying`,
        );
        await sleep(backoffMs(attempt));
      }
    }
    throw new TransientError(
      'CONCURRENCY_RETRIES_EXHAUSTED',
      `Gave up after ${MAX_ATTEMPTS} concurrent modification retries on wallet ${command.walletId}`,
    );
  }

  /** Uma tentativa completa, dentro de uma transação do banco. */
  private async attempt(
    tx: EntityManager,
    command: WagerCommand,
    source: WagerSource,
    requestHash: string,
  ): Promise<WagerResult> {
    // ------------------------------------------------------------------
    // PASSO 1 — Já vimos este pedido? (idempotência / inbox)
    // ------------------------------------------------------------------
    const previous = await this.claimDeduplicationKey(tx, source, requestHash);
    if (previous) return { transaction: previous, replayed: true };

    // ------------------------------------------------------------------
    // PASSO 2 — O provedor já mandou esta mesma transação por outro caminho?
    // (ex.: primeiro pela API com uma chave, depois pela fila)
    // ------------------------------------------------------------------
    const existing = await tx.findOne(WagerTransactionRecord, {
      provider: command.provider,
      providerTransactionId: command.providerTransactionId,
    });
    if (existing) {
      if (!sameContent(existing, command)) {
        throw new DomainError(
          FailureCode.PROVIDER_TRANSACTION_CONFLICT,
          `Provider transaction ${command.providerTransactionId} already exists with different content`,
        );
      }
      await this.linkDeduplicationKey(tx, source, existing.id);
      return { transaction: existing, replayed: true };
    }

    // ------------------------------------------------------------------
    // PASSO 3 — Carrega a carteira e (se precisar) a transação referenciada.
    // ------------------------------------------------------------------
    const walletRecord = await tx.findOne(WalletRecord, { id: command.walletId });
    if (!walletRecord) {
      throw new DomainError(FailureCode.WALLET_NOT_FOUND, `Wallet ${command.walletId} not found`);
    }
    const wallet = WalletMapper.toDomain(walletRecord);
    const balanceBefore = wallet.balance;
    const versionBefore = wallet.version; // a versão que LEMOS: vamos exigi-la no UPDATE

    const reference = requiresReference(command.kind) ? await this.loadReference(tx, command) : undefined;

    // ------------------------------------------------------------------
    // PASSO 4 — Decide (regras de negócio puras, ver wager-rules.ts).
    // ------------------------------------------------------------------
    const decision = decideWager({ command, wallet, reference });
    const now = new Date();

    // ------------------------------------------------------------------
    // PASSO 5 — Grava a transação com o resultado.
    // ------------------------------------------------------------------
    const record = tx.create(WagerTransactionRecord, {
      id: newId(),
      provider: command.provider,
      providerTransactionId: command.providerTransactionId,
      kind: command.kind,
      status: decision.status,
      playerId: command.playerId,
      walletId: command.walletId,
      currency: command.amount.currency.code,
      amount: command.amount.toDecimal(),
      roundId: command.roundId,
      referenceProviderTransactionId: command.referenceProviderTransactionId,
      referencedTransactionId: reference?.id ?? null,
      failureCode: decision.status === 'REJECTED' ? decision.failureCode : null,
      attempts: 0,
      nextAttemptAt:
        decision.status === 'PENDING_REFERENCE' ? new Date(now.getTime() + FIRST_REFERENCE_RETRY_MS) : null,
      createdAt: now,
      updatedAt: now,
      processedAt: decision.status === 'PENDING_REFERENCE' ? null : now,
    });
    tx.persist(record);
    await tx.flush(); // grava já, porque o extrato e as chaves apontam para esta linha

    // ------------------------------------------------------------------
    // PASSOS 6 e 7 — Saldo, extrato e eventos (ver applyDecision).
    // ------------------------------------------------------------------
    await this.applyDecision(tx, { record, wallet, balanceBefore, versionBefore, decision, now });
    await this.linkDeduplicationKey(tx, source, record.id);

    return { transaction: record, replayed: false };
    // Ao sair daqui sem erro, o MikroORM faz o flush final e o COMMIT.
  }

  /**
   * Tenta de novo UMA transação que estava aguardando referência (PENDING_REFERENCE).
   * Chamado pelo worker. Usa as MESMAS regras (decideWager) e o MESMO applyDecision.
   *
   * Devolve o novo status, ou null se a transação já não estava pendente
   * (outro worker pegou antes, ou ainda não chegou a hora).
   */
  async retryPendingReference(
    transactionId: string,
    policy: { maxAttempts: number; backoffMs: (attempt: number) => number },
  ): Promise<string | null> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.em.fork().transactional(async (tx) => {
          // FOR UPDATE SKIP LOCKED: trava ESTA linha para nós. Se outro worker já a travou,
          // pulamos (não esperamos) → dois workers nunca processam a mesma transação.
          const [locked] = await tx.execute<{ id: string }[]>(
            `select id from wager_transactions
             where id = ? and status = 'PENDING_REFERENCE' and next_attempt_at <= now()
             for update skip locked`,
            [transactionId],
          );
          if (!locked) return null;

          const record = await tx.findOneOrFail(WagerTransactionRecord, { id: transactionId });
          const wallet = WalletMapper.toDomain(await tx.findOneOrFail(WalletRecord, { id: record.walletId }));
          const balanceBefore = wallet.balance;
          const versionBefore = wallet.version;
          const command = commandFromRecord(record, wallet.currency);
          const reference = await this.loadReference(tx, command);

          let decision = decideWager({ command, wallet, reference });
          const now = new Date();
          record.attempts += 1;
          record.updatedAt = now;

          if (decision.status === 'PENDING_REFERENCE') {
            if (record.attempts >= policy.maxAttempts) {
              // Esperamos o suficiente: a referência não vai chegar → rejeita.
              decision = { status: 'REJECTED', failureCode: FailureCode.REFERENCE_NOT_FOUND };
            } else {
              record.nextAttemptAt = new Date(now.getTime() + policy.backoffMs(record.attempts));
              return record.status; // continua pendente; o flush grava attempts/nextAttemptAt
            }
          }

          record.status = decision.status;
          record.failureCode = decision.status === 'REJECTED' ? decision.failureCode : null;
          record.referencedTransactionId = reference?.id ?? null;
          record.nextAttemptAt = null;
          record.processedAt = now;
          await tx.flush();

          await this.applyDecision(tx, { record, wallet, balanceBefore, versionBefore, decision, now });
          return record.status;
        });
      } catch (error) {
        if (!isRetryable(error)) throw error;
        await sleep(backoffMs(attempt));
      }
    }
    throw new TransientError('CONCURRENCY_RETRIES_EXHAUSTED', `Gave up retrying pending transaction ${transactionId}`);
  }

  /**
   * Aplica uma decisão já tomada:
   *  - se o saldo mudou: UPDATE condicional na versão + linha no extrato + evento WalletBalanceChanged;
   *  - sempre: evento da transação (Processed / Rejected / PendingReference) na outbox.
   */
  private async applyDecision(
    tx: EntityManager,
    p: {
      record: WagerTransactionRecord;
      wallet: Wallet;
      balanceBefore: Money;
      versionBefore: number;
      decision: WagerDecision;
      now: Date;
    },
  ): Promise<void> {
    const { record, wallet, decision, now } = p;
    const events: DomainEvent[] = [transactionEvent(record, decision, now)];

    if (decision.status === 'PROCESSED' && decision.movement) {
      await this.saveWalletBalance(tx, wallet.id, p.versionBefore, wallet.balance, wallet.version, now);

      tx.persist(
        tx.create(LedgerEntryRecord, {
          id: newId(),
          walletId: wallet.id,
          transactionId: record.id,
          direction: decision.movement.direction,
          amount: decision.movement.amount.toDecimal(),
          balanceAfter: wallet.balance.toDecimal(),
          walletVersion: wallet.version,
          createdAt: now,
        }),
      );
      events.push(
        new WalletBalanceChanged(
          {
            walletId: wallet.id,
            playerId: wallet.playerId,
            currency: wallet.currency.code,
            previousBalance: p.balanceBefore.toDecimal(),
            newBalance: wallet.balance.toDecimal(),
            walletVersion: wallet.version,
            transactionId: record.id,
          },
          now,
        ),
      );
    }
    addToOutbox(tx, events);
  }

  /**
   * O UPDATE que protege contra a corrida das duas apostas:
   *
   *   UPDATE wallets SET balance = ?, version = ?
   *   WHERE id = ? AND version = <versão que lemos>
   *
   * Se outra operação já mudou a carteira, a versão no banco é outra,
   * 0 linhas são alteradas, e lançamos ConcurrentModificationError → recomeça.
   */
  private async saveWalletBalance(
    tx: EntityManager,
    walletId: string,
    expectedVersion: number,
    newBalance: Money,
    newVersion: number,
    now: Date,
  ): Promise<void> {
    const affected = await tx.nativeUpdate(
      WalletRecord,
      { id: walletId, version: expectedVersion },
      { balance: newBalance.toDecimal(), version: newVersion, updatedAt: now },
    );
    if (affected !== 1) throw new ConcurrentModificationError();
  }

  /** Busca a transação referenciada e se ela já foi desfeita/devolvida. `null` = não chegou ainda. */
  private async loadReference(tx: EntityManager, command: WagerCommand): Promise<ReferenceSnapshot | null> {
    const ref = await tx.findOne(WagerTransactionRecord, {
      provider: command.provider,
      providerTransactionId: command.referenceProviderTransactionId!,
    });
    if (!ref) return null;

    const [rolledBack, refunded] = await Promise.all([
      tx.count(WagerTransactionRecord, { referencedTransactionId: ref.id, kind: 'ROLLBACK', status: 'PROCESSED' }),
      tx.count(WagerTransactionRecord, { referencedTransactionId: ref.id, kind: 'REFUND', status: 'PROCESSED' }),
    ]);
    const currency = command.amount.currency;
    return {
      id: ref.id,
      provider: ref.provider,
      kind: ref.kind,
      status: ref.status,
      playerId: ref.playerId,
      walletId: ref.walletId,
      amount: ref.currency === currency.code ? Money.fromDecimal(ref.amount, currency) : Money.zero(currency),
      roundId: ref.roundId ?? null,
      rolledBack: rolledBack > 0,
      refunded: refunded > 0,
    };
  }

  /**
   * Tenta "reservar" a chave de idempotência (HTTP) ou o id da mensagem (fila).
   *
   * Usa INSERT ... ON CONFLICT DO NOTHING:
   *  - se inseriu → pedido novo, seguimos;
   *  - se já existia → devolvemos a transação gravada da primeira vez.
   * Se dois pedidos com a mesma chave chegam juntos, o PostgreSQL faz o segundo
   * ESPERAR o primeiro terminar, então nunca processamos duas vezes.
   */
  private async claimDeduplicationKey(
    tx: EntityManager,
    source: WagerSource,
    requestHash: string,
  ): Promise<WagerTransactionRecord | null> {
    let previousTransactionId: string | null;

    if (source.type === 'http') {
      const inserted = await tx.execute<{ key: string }[]>(
        `insert into idempotency_keys (key, request_hash) values (?, ?)
         on conflict (key) do nothing returning key`,
        [source.idempotencyKey, requestHash],
      );
      if (inserted.length === 1) return null; // chave nova

      const [row] = await tx.execute<{ request_hash: string; transaction_id: string | null }[]>(
        `select request_hash, transaction_id from idempotency_keys where key = ?`,
        [source.idempotencyKey],
      );
      // Mesma chave, conteúdo diferente: o cliente reutilizou a chave por engano.
      if (!row || row.request_hash !== requestHash) {
        throw new DomainError(
          FailureCode.IDEMPOTENCY_KEY_REUSED,
          'Idempotency-Key was already used with a different payload',
        );
      }
      previousTransactionId = row.transaction_id;
    } else {
      const inserted = await tx.execute<{ message_id: string }[]>(
        `insert into inbox_messages (message_id, source) values (?, 'sqs')
         on conflict (message_id) do nothing returning message_id`,
        [source.messageId],
      );
      if (inserted.length === 1) return null; // mensagem nova

      const [row] = await tx.execute<{ transaction_id: string | null }[]>(
        `select transaction_id from inbox_messages where message_id = ?`,
        [source.messageId],
      );
      previousTransactionId = row?.transaction_id ?? null;
    }

    if (!previousTransactionId) return null;
    return tx.findOneOrFail(WagerTransactionRecord, { id: previousTransactionId });
  }

  /** Associa a chave/mensagem à transação, para responder igual nas repetições. */
  private async linkDeduplicationKey(tx: EntityManager, source: WagerSource, transactionId: string): Promise<void> {
    if (source.type === 'http') {
      await tx.execute(`update idempotency_keys set transaction_id = ? where key = ?`, [
        transactionId,
        source.idempotencyKey,
      ]);
    } else {
      await tx.execute(`update inbox_messages set transaction_id = ? where message_id = ?`, [
        transactionId,
        source.messageId,
      ]);
    }
  }
}

// ----------------------------------------------------------------------
// Funções auxiliares
// ----------------------------------------------------------------------

/**
 * "Impressão digital" (hash SHA-256) do conteúdo do pedido.
 * Mesmo conteúdo → mesmo hash. Qualquer diferença → hash diferente.
 * Os campos são listados numa ordem fixa, e o valor é normalizado ("80" e "80.00" são iguais).
 */
function hashCommand(c: WagerCommand): string {
  const canonical = JSON.stringify([
    c.provider,
    c.providerTransactionId,
    c.kind,
    c.playerId,
    c.walletId,
    c.amount.currency.code,
    c.amount.toDecimal(),
    c.roundId,
    c.referenceProviderTransactionId,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Remonta o pedido original a partir da transação gravada (usado no reprocessamento). */
function commandFromRecord(r: WagerTransactionRecord, currency: Currency): WagerCommand {
  return {
    provider: r.provider,
    providerTransactionId: r.providerTransactionId,
    kind: r.kind,
    playerId: r.playerId,
    walletId: r.walletId,
    amount: Money.fromDecimal(r.amount, currency),
    roundId: r.roundId ?? null,
    referenceProviderTransactionId: r.referenceProviderTransactionId ?? null,
  };
}

/** A transação já gravada tem o mesmo conteúdo do pedido novo? */
function sameContent(r: WagerTransactionRecord, c: WagerCommand): boolean {
  return (
    r.kind === c.kind &&
    r.playerId === c.playerId &&
    r.walletId === c.walletId &&
    r.currency === c.amount.currency.code &&
    r.amount === c.amount.toDecimal() &&
    (r.roundId ?? null) === c.roundId &&
    (r.referenceProviderTransactionId ?? null) === c.referenceProviderTransactionId
  );
}

function transactionEvent(r: WagerTransactionRecord, decision: WagerDecision, now: Date): DomainEvent {
  const payload: WagerTransactionEventPayload = {
    transactionId: r.id,
    provider: r.provider,
    providerTransactionId: r.providerTransactionId,
    kind: r.kind,
    playerId: r.playerId,
    walletId: r.walletId,
    currency: r.currency,
    amount: r.amount,
    roundId: r.roundId ?? null,
  };
  switch (decision.status) {
    case 'PROCESSED':
      return new WagerTransactionProcessed(payload, now);
    case 'REJECTED':
      return new WagerTransactionRejected({ ...payload, failureCode: decision.failureCode }, now);
    case 'PENDING_REFERENCE':
      return new WagerTransactionPendingReference(
        { ...payload, referenceProviderTransactionId: r.referenceProviderTransactionId ?? null },
        now,
      );
  }
}

/**
 * Erros que justificam recomeçar a tentativa:
 *  - outra operação mudou a carteira (versão diferente);
 *  - violação de UNIQUE por corrida (ex.: o mesmo id do provedor chegou duas vezes ao mesmo tempo);
 *  - deadlock detectado pelo PostgreSQL.
 */
function isRetryable(error: unknown): boolean {
  return (
    error instanceof ConcurrentModificationError ||
    error instanceof UniqueConstraintViolationException ||
    error instanceof DeadlockException
  );
}

/** Espera crescente com um pouco de aleatoriedade (para as tentativas não colidirem de novo). */
function backoffMs(attempt: number): number {
  const base = Math.min(5 * 2 ** (attempt - 1), 200);
  return base / 2 + Math.random() * (base / 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
