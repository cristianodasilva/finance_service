import { DomainError, FailureCode } from '../errors';
import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import type { Currency } from '../money/currency';
import { Money } from '../money/money';

export interface WalletState {
  id: string;
  playerId: string;
  currency: Currency;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Dados de um movimento: a qual transação pertence e qual id terá o lançamento. */
export interface MovementContext {
  transactionId: string;
  entryId: string;
  at: Date;
}

/**
 * Carteira (Aggregate Root): uma por jogador + moeda.
 *
 * Invariantes:
 *  - saldo nunca negativo;
 *  - a moeda de cada operação é igual à da carteira;
 *  - TODA alteração de saldo produz um lançamento no extrato (credit/debit DEVOLVEM o lançamento);
 *  - `version` começa em 1 na criação e só sobe quando o saldo muda.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: Currency,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
    /** Lançamento do saldo inicial (só em carteiras recém-abertas com saldo > 0). */
    readonly openingEntry: WalletLedgerEntry | null,
  ) {}

  /**
   * Abre uma carteira (versão 1). Se `initialBalance` > 0, já cria o lançamento CREDIT
   * da transação interna OPENING — saldo e extrato nascem consistentes.
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    /** Obrigatórios quando initialBalance > 0. */
    openingTransactionId?: string;
    openingEntryId?: string;
    at?: Date;
  }): Wallet {
    const at = props.at ?? new Date();
    const initial = props.initialBalance;
    if (initial.isNegative()) {
      throw new DomainError(FailureCode.INVALID_AMOUNT, 'Initial balance cannot be negative');
    }

    let openingEntry: WalletLedgerEntry | null = null;
    if (initial.isPositive()) {
      if (!props.openingTransactionId || !props.openingEntryId) {
        throw new Error('openingTransactionId and openingEntryId are required for a positive initial balance');
      }
      openingEntry = WalletLedgerEntry.create({
        id: props.openingEntryId,
        walletId: props.id,
        transactionId: props.openingTransactionId,
        direction: LedgerDirection.Credit,
        money: initial,
        balanceBefore: Money.zero(initial.currency),
        balanceAfter: initial,
        walletVersion: 1,
        createdAt: at,
      });
    }
    return new Wallet(props.id, props.playerId, initial.currency, initial, 1, at, at, openingEntry);
  }

  /** Reconstrói a partir do banco. Não revalida regras — só remonta o estado salvo. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
      null,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Entra dinheiro (WIN, REFUND, ROLLBACK de uma BET). Devolve o lançamento CREDIT. */
  credit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertValidAmount(money);
    return this.apply(LedgerDirection.Credit, money, ctx);
  }

  /** Sai dinheiro para uma aposta (BET). Sem saldo → INSUFFICIENT_FUNDS. */
  debit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertValidAmount(money);
    if (this._balance.isLessThan(money)) {
      throw new DomainError(
        FailureCode.INSUFFICIENT_FUNDS,
        `Insufficient funds: balance ${this._balance.toDecimal()}, requested ${money.toDecimal()}`,
      );
    }
    return this.apply(LedgerDirection.Debit, money, ctx);
  }

  /**
   * Sai dinheiro para DESFAZER um crédito (ROLLBACK de WIN/REFUND).
   * Código diferente do `debit`: o dinheiro já foi pago e gasto — caso operacional, não "aposta sem saldo".
   */
  reverseCredit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertValidAmount(money);
    if (this._balance.isLessThan(money)) {
      throw new DomainError(
        FailureCode.REVERSAL_WOULD_OVERDRAW,
        `Reversal would overdraw: balance ${this._balance.toDecimal()}, reversal ${money.toDecimal()}`,
      );
    }
    return this.apply(LedgerDirection.Debit, money, ctx);
  }

  /** Único lugar que muda saldo e versão — e sempre gera o lançamento correspondente. */
  private apply(direction: LedgerDirection, money: Money, ctx: MovementContext): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(money) : before.subtract(money);
    const entry = WalletLedgerEntry.create({
      id: ctx.entryId,
      walletId: this.id,
      transactionId: ctx.transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: this._version + 1,
      createdAt: ctx.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = ctx.at;
    return entry;
  }

  private assertValidAmount(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new DomainError(FailureCode.INVALID_AMOUNT, 'Amount must be greater than zero');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (!money.currency.equals(this.currency)) {
      throw new DomainError(
        FailureCode.CURRENCY_MISMATCH,
        `Wallet currency is ${this.currency.code}, got ${money.currency.code}`,
      );
    }
  }
}
