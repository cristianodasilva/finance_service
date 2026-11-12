import { Injectable } from '@nestjs/common';
import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/postgresql';
import { newId } from '../common/ids';
import { LedgerEntryRecord } from '../database/entities/ledger-entry.record';
import { WagerTransactionRecord } from '../database/entities/wager-transaction.record';
import { WalletRecord } from '../database/entities/wallet.record';
import { DomainError, FailureCode } from '../domain/errors';
import { Currency } from '../domain/money/currency';
import { Money } from '../domain/money/money';
import { Wallet } from '../domain/wallet/wallet';
import { WalletBalanceChanged } from '../events/wallet-balance-changed.event';
import { addToOutbox } from '../outbox/outbox.writer';
import { decodeCursor, encodeCursor } from './ledger-cursor';
import { WalletMapper } from './wallet.mapper';

export interface CreateWalletInput {
  playerId: string;
  currency: string;
  /** Texto decimal, ex.: "100.00". Opcional: padrão é zero. */
  initialBalance?: string;
}

/** Provedor "interno": usado nas transações criadas pelo próprio serviço (OPENING). */
const INTERNAL_PROVIDER = 'internal';

/**
 * Regras de uso (casos de uso) das carteiras.
 * @Injectable: o NestJS cria esta classe e a entrega a quem precisar (injeção de dependência).
 */
@Injectable()
export class WalletsService {
  constructor(private readonly em: EntityManager) {}

  /**
   * Abre uma carteira.
   *
   * Se houver saldo inicial, TUDO acontece numa única transação do banco:
   *   1. cria a carteira;
   *   2. cria a transação OPENING (já PROCESSED);
   *   3. cria a linha de CRÉDITO no extrato;
   *   4. grava o evento WalletBalanceChanged na outbox.
   * Se qualquer passo falhar, nada é gravado (o banco desfaz tudo).
   */
  async create(input: CreateWalletInput): Promise<Wallet> {
    // Validações de domínio: lançam DomainError se algo estiver errado.
    const currency = Currency.of(input.currency);
    const initialBalance = Money.fromDecimal(input.initialBalance ?? '0', currency);
    if (initialBalance.isNegative()) {
      throw new DomainError(FailureCode.INVALID_AMOUNT, 'Initial balance cannot be negative');
    }

    const now = new Date();
    const wallet = Wallet.open({ id: newId(), playerId: input.playerId, currency, now });

    try {
      // em.transactional = BEGIN ... COMMIT. Se o código lançar erro, faz ROLLBACK.
      await this.em.transactional(async (tx) => {
        const openingTxId = initialBalance.isPositive() ? newId() : null;
        if (initialBalance.isPositive()) wallet.credit(initialBalance);

        tx.persist(
          tx.create(WalletRecord, {
            id: wallet.id,
            playerId: wallet.playerId,
            currency: currency.code,
            balance: wallet.balance.toDecimal(),
            version: wallet.version,
            createdAt: now,
            updatedAt: now,
          }),
        );
        // Grava a carteira antes das linhas que apontam para ela (chave estrangeira).
        await tx.flush();

        if (openingTxId === null) return; // sem saldo inicial: nada mais a registrar

        tx.persist(
          tx.create(WagerTransactionRecord, {
            id: openingTxId,
            provider: INTERNAL_PROVIDER,
            providerTransactionId: `opening:${wallet.id}`,
            kind: 'OPENING',
            status: 'PROCESSED',
            playerId: wallet.playerId,
            walletId: wallet.id,
            currency: currency.code,
            amount: initialBalance.toDecimal(),
            attempts: 0,
            createdAt: now,
            updatedAt: now,
            processedAt: now,
          }),
        );
        await tx.flush();

        tx.persist(
          tx.create(LedgerEntryRecord, {
            id: newId(),
            walletId: wallet.id,
            transactionId: openingTxId,
            direction: 'CREDIT',
            amount: initialBalance.toDecimal(),
            balanceAfter: wallet.balance.toDecimal(),
            walletVersion: wallet.version,
            createdAt: now,
          }),
        );
        addToOutbox(tx, [
          new WalletBalanceChanged(
            {
              walletId: wallet.id,
              playerId: wallet.playerId,
              currency: currency.code,
              previousBalance: Money.zero(currency).toDecimal(),
              newBalance: wallet.balance.toDecimal(),
              walletVersion: wallet.version,
              transactionId: openingTxId,
            },
            now,
          ),
        ]);
        // O flush final acontece automaticamente ao sair do transactional.
      });
    } catch (error) {
      // A restrição UNIQUE (player_id, currency) do banco garante: 1 carteira por jogador+moeda,
      // mesmo se duas requisições chegarem ao mesmo tempo.
      if (error instanceof UniqueConstraintViolationException) {
        throw new DomainError(
          FailureCode.WALLET_ALREADY_EXISTS,
          `Player ${input.playerId} already has a ${currency.code} wallet`,
        );
      }
      throw error;
    }

    return wallet;
  }

  /** Busca uma carteira pelo id. */
  async findById(id: string): Promise<Wallet> {
    // fork(): cópia limpa do EntityManager, para ler sempre o dado atual do banco.
    const record = await this.em.fork().findOne(WalletRecord, { id });
    if (!record) {
      throw new DomainError(FailureCode.WALLET_NOT_FOUND, `Wallet ${id} not found`);
    }
    return WalletMapper.toDomain(record);
  }

  /** Busca as carteiras de um jogador (uma por moeda). */
  async findByPlayer(playerId: string): Promise<Wallet[]> {
    const records = await this.em.fork().find(WalletRecord, { playerId }, { orderBy: { currency: 'asc' } });
    return records.map((r) => WalletMapper.toDomain(r));
  }

  /**
   * Extrato da carteira, do movimento mais recente para o mais antigo, paginado por cursor.
   * Pedimos `limit + 1` linhas: se vier a linha extra, sabemos que existe próxima página.
   */
  async ledger(walletId: string, params: { limit: number; cursor?: string }) {
    await this.findById(walletId); // 404 se a carteira não existir
    const before = params.cursor ? decodeCursor(params.cursor) : null;

    const rows = await this.em.fork().execute<
      {
        id: string;
        transaction_id: string;
        direction: string;
        amount: string;
        balance_after: string;
        wallet_version: number;
        created_at: Date;
        kind: string;
        provider_transaction_id: string;
      }[]
    >(
      `select l.id, l.transaction_id, l.direction, l.amount::text, l.balance_after::text,
              l.wallet_version, l.created_at, t.kind, t.provider_transaction_id
         from wallet_ledger_entries l
         join wager_transactions t on t.id = l.transaction_id
        where l.wallet_id = ? ${before !== null ? 'and l.wallet_version < ?' : ''}
        order by l.wallet_version desc
        limit ?`,
      before !== null ? [walletId, before, params.limit + 1] : [walletId, params.limit + 1],
    );

    const hasMore = rows.length > params.limit;
    const page = rows.slice(0, params.limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        transactionId: r.transaction_id,
        transactionKind: r.kind,
        providerTransactionId: r.provider_transaction_id,
        direction: r.direction,
        amount: r.amount,
        balanceAfter: r.balance_after,
        walletVersion: r.wallet_version,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]!.wallet_version) : null,
    };
  }
}
