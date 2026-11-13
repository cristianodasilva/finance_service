import { Injectable } from '@nestjs/common';
import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/postgresql';
import { newId } from '../common/ids';
import { LedgerEntryRecord } from '../database/entities/ledger-entry.record';
import { WagerTransactionRecord } from '../database/entities/wager-transaction.record';
import { WalletRecord } from '../database/entities/wallet.record';
import { entryToRecord, transactionToRecord, walletFromRecord, walletToRecord } from '../database/mappers';
import { addToOutbox } from '../database/outbox.writer';
import { DomainError, FailureCode } from '../domain/errors';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events/events';
import { Money, type MoneyProps } from '../domain/money/money';
import { payloadHash } from '../domain/wager/payload-hash';
import { WagerTransaction } from '../domain/wager/wager-transaction';
import { Wallet } from '../domain/wallet/wallet';
import { currentLogContext } from '../observability/log-context';
import { decodeCursor, encodeCursor } from './ledger-cursor';

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

@Injectable()
export class WalletsService {
  constructor(private readonly em: EntityManager) {}

  /**
   * Abre uma carteira (versão 1). Com saldo inicial > 0, na MESMA transação SQL:
   * carteira + transação interna OPENING + lançamento CREDIT + eventos na outbox.
   */
  async create(input: CreateWalletInput): Promise<Wallet> {
    const initialBalance = Money.from(input.initialBalance); // valida (rejeita negativo, 3 casas...)
    const at = new Date();
    const walletId = newId();
    const openingId = initialBalance.isPositive() ? newId() : undefined;
    const wallet = Wallet.open({
      id: walletId,
      playerId: input.playerId,
      initialBalance,
      openingTransactionId: openingId,
      openingEntryId: openingId ? newId() : undefined,
      at,
    });

    try {
      await this.em.fork().transactional(async (tx) => {
        tx.persist(tx.create(WalletRecord, walletToRecord(wallet)));
        await tx.flush(); // a carteira precisa existir antes das linhas que apontam para ela

        const entry = wallet.openingEntry;
        if (!entry || !openingId) return;

        const opening = WagerTransaction.opening({
          id: openingId,
          walletId,
          playerId: input.playerId,
          money: initialBalance,
          payloadHash: payloadHash({ walletId, playerId: input.playerId, money: initialBalance.toJSON() }),
          at,
        });
        tx.persist(
          tx.create(
            WagerTransactionRecord,
            transactionToRecord(opening, { resultingBalance: wallet.balance, attempts: 0, nextAttemptAt: null, updatedAt: at }),
          ),
        );
        await tx.flush();
        tx.persist(tx.create(LedgerEntryRecord, entryToRecord(entry)));

        const ctx = { correlationId: currentLogContext()?.correlationId ?? walletId, causationId: openingId, occurredAt: at };
        addToOutbox(tx, [WagerTransactionProcessed.from(opening, wallet, ctx), WalletBalanceChanged.from(wallet, entry, ctx)]);
      });
    } catch (error) {
      // UNIQUE (player_id, currency): 1 carteira por jogador + moeda, mesmo com pedidos simultâneos.
      if (error instanceof UniqueConstraintViolationException) {
        throw new DomainError(
          FailureCode.WALLET_ALREADY_EXISTS,
          `Player ${input.playerId} already has a ${initialBalance.currency.code} wallet`,
        );
      }
      throw error;
    }
    return wallet;
  }

  async findById(id: string): Promise<Wallet> {
    const record = await this.em.fork().findOne(WalletRecord, { id });
    if (!record) throw new DomainError(FailureCode.WALLET_NOT_FOUND, `Wallet ${id} not found`);
    return walletFromRecord(record);
  }

  async findByPlayer(playerId: string): Promise<Wallet[]> {
    const records = await this.em.fork().find(WalletRecord, { playerId }, { orderBy: { currency: 'asc' } });
    return records.map(walletFromRecord);
  }

  /**
   * Extrato, do mais recente para o mais antigo, paginado por cursor (wallet_version).
   * Pede `limit + 1` linhas: se vier a extra, existe próxima página.
   */
  async ledger(walletId: string, params: { limit: number; cursor?: string }) {
    const wallet = await this.findById(walletId);
    const before = params.cursor ? decodeCursor(params.cursor) : null;
    const rows = await this.em.fork().execute<
      {
        id: string; transaction_id: string; direction: string; amount: string; balance_before: string;
        balance_after: string; wallet_version: number; created_at: Date; kind: string; external_transaction_id: string;
      }[]
    >(
      `select l.id, l.transaction_id, l.direction, l.amount::text, l.balance_before::text, l.balance_after::text,
              l.wallet_version, l.created_at, t.kind, t.external_transaction_id
         from wallet_ledger_entries l
         join wager_transactions t on t.id = l.transaction_id
        where l.wallet_id = ? ${before !== null ? 'and l.wallet_version < ?' : ''}
        order by l.wallet_version desc
        limit ?`,
      before !== null ? [walletId, before, params.limit + 1] : [walletId, params.limit + 1],
    );
    const currency = wallet.currency.code;
    const money = (amount: string) => ({ amount, currency });
    const page = rows.slice(0, params.limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        transactionId: r.transaction_id,
        transactionKind: r.kind,
        externalTransactionId: r.external_transaction_id,
        direction: r.direction,
        money: money(r.amount),
        balanceBefore: money(r.balance_before),
        balanceAfter: money(r.balance_after),
        walletVersion: r.wallet_version,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      nextCursor: rows.length > params.limit ? encodeCursor(page[page.length - 1]!.wallet_version) : null,
    };
  }
}
