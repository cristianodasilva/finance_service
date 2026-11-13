import { Injectable, Logger } from '@nestjs/common';
import { DeadlockException, EntityManager, UniqueConstraintViolationException } from '@mikro-orm/postgresql';
import { newId } from '../common/ids';
import { TransientError } from '../common/transient-error';
import { LedgerEntryRecord } from '../database/entities/ledger-entry.record';
import { WagerTransactionRecord } from '../database/entities/wager-transaction.record';
import { WalletRecord } from '../database/entities/wallet.record';
import { entryToRecord, transactionFromRecord, transactionToRecord, walletFromRecord } from '../database/mappers';
import { addToOutbox } from '../database/outbox.writer';
import { DomainError, FailureCode } from '../domain/errors';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events/events';
import type { EventContext, IntegrationEvent } from '../domain/events/integration-event';
import { Currency } from '../domain/money/currency';
import { Money } from '../domain/money/money';
import { payloadHash, type WagerBusinessPayload } from '../domain/wager/payload-hash';
import { decideWager, type ReferenceContext, type WagerOutcome } from '../domain/wager/wager-rules';
import { WagerTransaction, type WagerKind } from '../domain/wager/wager-transaction';
import type { Wallet } from '../domain/wallet/wallet';
import { currentLogContext, enrichLogContext } from '../observability/log-context';
import { metrics } from '../observability/metrics';

/** O pedido do provedor, já validado (vem do HTTP ou da fila). */
export interface WagerRequest {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: Money;
  referenceExternalTransactionId: string | null;
}

/** De onde veio o pedido. A fila também registra a mensagem na inbox. */
export type WagerSource =
  | { type: 'http' }
  | { type: 'sqs'; consumerName: string; messageId: string; messagePayloadHash: string };

export interface WagerResult {
  transaction: WagerTransaction;
  /** Saldo observado no momento da decisão (no replay: o da PRIMEIRA vez). */
  balance: Money;
  /** true = pedido repetido; devolvemos o resultado original. */
  replayed: boolean;
}

/** Outra operação mudou a carteira entre a nossa leitura e a nossa escrita → recomeçar. */
class ConcurrentModificationError extends Error {}

const MAX_ATTEMPTS = 25;
const FIRST_REFERENCE_RETRY_MS = 2_000;

/** O "assunto" do hash: só campos de negócio (sem header, messageId ou metadados de transporte). */
export function businessPayload(r: WagerRequest): WagerBusinessPayload {
  return {
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    playerId: r.playerId,
    walletId: r.walletId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind,
    money: r.money.toJSON(), // normalizado: "80" e "80.00" geram o mesmo hash
    referenceExternalTransactionId: r.referenceExternalTransactionId,
  };
}

@Injectable()
export class ProcessWagerService {
  private readonly logger = new Logger(ProcessWagerService.name);

  constructor(private readonly em: EntityManager) {}

  /**
   * Processa uma transação de aposta — o MESMO caso de uso para HTTP e fila.
   * Tudo numa transação SQL; conflito de versão da carteira → recomeça (optimistic locking).
   */
  async execute(request: WagerRequest, idempotencyKey: string, source: WagerSource): Promise<WagerResult> {
    const hash = payloadHash(businessPayload(request));
    enrichLogContext({ walletId: request.walletId, providerId: request.providerId });
    const stopTimer = metrics.processingDuration.startTimer({ source: source.type });

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const result = await this.em
            .fork()
            .transactional((tx) => this.attempt(tx, request, idempotencyKey, hash, source));
          recordOutcome(result, source.type);
          return result;
        } catch (error) {
          if (!isRetryable(error)) throw error;
          metrics.concurrencyConflicts.inc();
          this.logger.debug(`Concurrent modification (attempt ${attempt}/${MAX_ATTEMPTS}), retrying`);
          await sleep(backoffMs(attempt));
        }
      }
      this.logger.error(`Gave up after ${MAX_ATTEMPTS} concurrency retries`);
      throw new TransientError('CONCURRENCY_RETRIES_EXHAUSTED', `Gave up after ${MAX_ATTEMPTS} retries`);
    } finally {
      stopTimer();
    }
  }

  private async attempt(
    tx: EntityManager,
    request: WagerRequest,
    idempotencyKey: string,
    hash: string,
    source: WagerSource,
  ): Promise<WagerResult> {
    const now = new Date();

    // 1) Fila: registra a mensagem na inbox (consumerName, messageId). Já vista → replay.
    if (source.type === 'sqs') {
      const previous = await this.claimInbox(tx, source, now);
      if (previous) return previous;
    }

    // 2) Idempotency-Key é a fonte da verdade: já existe transação com esta chave?
    const byKey = await tx.findOne(WagerTransactionRecord, { idempotencyKey });
    if (byKey) return this.replay(tx, byKey, hash, source, FailureCode.IDEMPOTENCY_KEY_REUSED, now);

    // 3) Mesmo (providerId, externalTransactionId) com outra chave?
    const byExternal = await tx.findOne(WagerTransactionRecord, {
      providerId: request.providerId,
      externalTransactionId: request.externalTransactionId,
    });
    if (byExternal) return this.replay(tx, byExternal, hash, source, FailureCode.PROVIDER_TRANSACTION_CONFLICT, now);

    // 4) Carrega a carteira (guardando a versão lida) e a referência, se houver.
    const walletRecord = await tx.findOne(WalletRecord, { id: request.walletId });
    if (!walletRecord) throw new DomainError(FailureCode.WALLET_NOT_FOUND, `Wallet ${request.walletId} not found`);
    const wallet = walletFromRecord(walletRecord);
    const versionBefore = wallet.version;

    const transaction = WagerTransaction.create({
      id: newId(),
      providerId: request.providerId,
      externalTransactionId: request.externalTransactionId,
      idempotencyKey,
      payloadHash: hash,
      walletId: request.walletId,
      playerId: request.playerId,
      roundId: request.roundId,
      gameId: request.gameId,
      kind: request.kind,
      money: request.money,
      referenceExternalTransactionId: request.referenceExternalTransactionId,
      createdAt: now,
    });
    enrichLogContext({ transactionId: transaction.id });
    const reference = await this.loadReference(tx, transaction);

    // 5) Decide (regras puras) e grava tudo.
    const outcome = decideWager({ transaction, wallet, reference, entryId: newId(), at: now });
    tx.persist(
      tx.create(
        WagerTransactionRecord,
        transactionToRecord(transaction, {
          resultingBalance: wallet.balance,
          attempts: 0,
          nextAttemptAt: outcome.status === 'PENDING_REFERENCE' ? new Date(now.getTime() + FIRST_REFERENCE_RETRY_MS) : null,
          updatedAt: now,
        }),
      ),
    );
    await tx.flush(); // o extrato e a inbox apontam para esta linha

    const causationId = source.type === 'sqs' ? source.messageId : idempotencyKey;
    await this.applyOutcome(tx, { transaction, wallet, versionBefore, outcome, now, causationId });
    if (source.type === 'sqs') await this.completeInbox(tx, source, transaction.id, now);

    return { transaction, balance: wallet.balance, replayed: false };
  }

  /**
   * Reprocessa UMA transação PENDING_REFERENCE (chamado pelo worker).
   * Mesmas regras e mesmo applyOutcome. Devolve o novo status, ou null se não estava mais pendente.
   */
  async retryPendingReference(
    transactionId: string,
    policy: { maxAttempts: number; backoffMs: (attempt: number) => number },
  ): Promise<string | null> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.em.fork().transactional(async (tx) => {
          // FOR UPDATE SKIP LOCKED: dois workers nunca processam a mesma transação.
          const [locked] = await tx.execute<{ id: string }[]>(
            `select id from wager_transactions
              where id = ? and status = 'PENDING_REFERENCE' and next_attempt_at <= now()
              for update skip locked`,
            [transactionId],
          );
          if (!locked) return null;

          const record = await tx.findOneOrFail(WagerTransactionRecord, { id: transactionId });
          const transaction = transactionFromRecord(record);
          const wallet = walletFromRecord(await tx.findOneOrFail(WalletRecord, { id: record.walletId }));
          enrichLogContext({ transactionId, walletId: wallet.id, providerId: transaction.providerId });
          const versionBefore = wallet.version;
          const reference = await this.loadReference(tx, transaction);
          const now = new Date();

          let outcome = decideWager({ transaction, wallet, reference, entryId: newId(), at: now });
          record.attempts += 1;
          record.updatedAt = now;

          if (outcome.status === 'PENDING_REFERENCE') {
            if (record.attempts < policy.maxAttempts) {
              record.nextAttemptAt = new Date(now.getTime() + policy.backoffMs(record.attempts));
              return record.status; // continua aguardando (o flush grava attempts/nextAttemptAt)
            }
            // Esgotou o limite: a referência não vai chegar.
            transaction.reject(FailureCode.REFERENCE_NOT_FOUND, now);
            outcome = { status: 'REJECTED', failureCode: FailureCode.REFERENCE_NOT_FOUND };
          }

          tx.assign(
            record,
            transactionToRecord(transaction, { resultingBalance: wallet.balance, attempts: record.attempts, nextAttemptAt: null, updatedAt: now }),
          );
          await tx.flush();
          await this.applyOutcome(tx, { transaction, wallet, versionBefore, outcome, now, causationId: transactionId });
          return transaction.status;
        });
      } catch (error) {
        if (!isRetryable(error)) throw error;
        metrics.concurrencyConflicts.inc();
        await sleep(backoffMs(attempt));
      }
    }
    throw new TransientError('CONCURRENCY_RETRIES_EXHAUSTED', `Gave up retrying pending transaction ${transactionId}`);
  }

  /**
   * Aplica a decisão: se houve lançamento → UPDATE condicional na versão + extrato + WalletBalanceChanged;
   * sempre → evento da transação. Tudo na outbox, na mesma transação SQL.
   */
  private async applyOutcome(
    tx: EntityManager,
    p: { transaction: WagerTransaction; wallet: Wallet; versionBefore: number; outcome: WagerOutcome; now: Date; causationId: string },
  ): Promise<void> {
    const { transaction, wallet, outcome } = p;
    const ctx: EventContext = {
      correlationId: currentLogContext()?.correlationId ?? transaction.id,
      causationId: p.causationId,
      occurredAt: p.now,
    };
    const events: IntegrationEvent<unknown>[] = [];

    if (outcome.status === 'PROCESSED' && outcome.entry) {
      await this.saveWalletBalance(tx, wallet, p.versionBefore);
      tx.persist(tx.create(LedgerEntryRecord, entryToRecord(outcome.entry)));
      events.push(WalletBalanceChanged.from(wallet, outcome.entry, ctx));
    }
    if (outcome.status === 'PROCESSED') events.unshift(WagerTransactionProcessed.from(transaction, wallet, ctx));
    if (outcome.status === 'REJECTED') events.push(WagerTransactionRejected.from(transaction, wallet, ctx));
    if (outcome.status === 'PENDING_REFERENCE') events.push(WagerTransactionPendingReference.from(transaction, wallet, ctx));
    addToOutbox(tx, events);
  }

  /**
   * UPDATE wallets SET balance, version WHERE id = ? AND version = <versão lida>
   * 0 linhas = outra operação mudou a carteira antes → ConcurrentModificationError → recomeça.
   */
  private async saveWalletBalance(tx: EntityManager, wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await tx.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.toDecimal(), version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affected !== 1) throw new ConcurrentModificationError();
  }

  /** Busca a referência por (providerId, referenceExternalTransactionId) e se ela já foi revertida. */
  private async loadReference(tx: EntityManager, t: WagerTransaction): Promise<ReferenceContext | null | undefined> {
    if (t.referenceExternalTransactionId === null) return undefined;
    const record = await tx.findOne(WagerTransactionRecord, {
      providerId: t.providerId,
      externalTransactionId: t.referenceExternalTransactionId,
    });
    if (!record) return null;
    const reversals = await tx.count(WagerTransactionRecord, {
      referenceTransactionId: record.id,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
      status: 'PROCESSED',
    });
    return { transaction: transactionFromRecord(record), reversed: reversals > 0 };
  }

  /** Pedido repetido: mesmo conteúdo → devolve o resultado original; conteúdo diferente → 409. */
  private async replay(
    tx: EntityManager,
    record: WagerTransactionRecord,
    hash: string,
    source: WagerSource,
    conflictCode: FailureCode,
    now: Date,
  ): Promise<WagerResult> {
    const transaction = transactionFromRecord(record);
    if (!transaction.matchesPayload(hash)) {
      throw new DomainError(conflictCode, 'Same key/transaction already used with a different payload');
    }
    if (source.type === 'sqs') await this.completeInbox(tx, source, transaction.id, now);
    return {
      transaction,
      balance: Money.fromDecimal(record.resultingBalance, transaction.money.currency),
      replayed: true,
    };
  }

  /**
   * INSERT na inbox com ON CONFLICT DO NOTHING. Se dois consumidores recebem a mesma mensagem
   * ao mesmo tempo, o PostgreSQL faz o segundo ESPERAR o primeiro terminar.
   */
  private async claimInbox(
    tx: EntityManager,
    source: Extract<WagerSource, { type: 'sqs' }>,
    now: Date,
  ): Promise<WagerResult | null> {
    const inserted = await tx.execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?) on conflict (consumer_name, message_id) do nothing returning message_id`,
      [source.consumerName, source.messageId, source.messagePayloadHash, now],
    );
    if (inserted.length === 1) return null;

    const [row] = await tx.execute<{ payload_hash: string; transaction_id: string | null }[]>(
      `select payload_hash, transaction_id from inbox_messages where consumer_name = ? and message_id = ?`,
      [source.consumerName, source.messageId],
    );
    if (row && row.payload_hash !== source.messagePayloadHash) {
      throw new DomainError(FailureCode.INBOX_PAYLOAD_MISMATCH, `Message ${source.messageId} redelivered with a different payload`);
    }
    if (!row?.transaction_id) return null;
    const record = await tx.findOneOrFail(WagerTransactionRecord, { id: row.transaction_id });
    return {
      transaction: transactionFromRecord(record),
      balance: Money.fromDecimal(record.resultingBalance, Currency.of(record.currency)),
      replayed: true,
    };
  }

  private async completeInbox(
    tx: EntityManager,
    source: Extract<WagerSource, { type: 'sqs' }>,
    transactionId: string,
    now: Date,
  ): Promise<void> {
    await tx.execute(
      `update inbox_messages set transaction_id = ?, processed_at = coalesce(processed_at, ?)
        where consumer_name = ? and message_id = ?`,
      [transactionId, now, source.consumerName, source.messageId],
    );
  }
}

// ----------------------------------------------------------------------

function recordOutcome(result: WagerResult, source: WagerSource['type']): void {
  const t = result.transaction;
  enrichLogContext({ transactionId: t.id });
  if (result.replayed) {
    metrics.duplicates.inc({ source });
    return;
  }
  metrics.transactions.inc({ kind: t.kind, status: t.status, source });
  if (t.failureCode) metrics.failures.inc({ failure_code: t.failureCode });
}

/** Conflito de versão, UNIQUE violada por corrida (mesma chave ao mesmo tempo) ou deadlock → tentar de novo. */
function isRetryable(error: unknown): boolean {
  return (
    error instanceof ConcurrentModificationError ||
    error instanceof UniqueConstraintViolationException ||
    error instanceof DeadlockException
  );
}

/** Espera crescente com aleatoriedade (jitter), para as instâncias não colidirem de novo. */
function backoffMs(attempt: number): number {
  const base = Math.min(5 * 2 ** (attempt - 1), 200);
  return base / 2 + Math.random() * (base / 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
