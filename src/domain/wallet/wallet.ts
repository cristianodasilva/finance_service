import { DomainError, FailureCode } from '../errors';
import { Currency } from '../money/currency';
import { Money } from '../money/money';

export interface WalletProps {
  id: string;
  playerId: string;
  currency: Currency;
  balance: Money;
  version: number;
  createdAt: Date;
}

/**
 * Wallet aggregate: one per (player, currency).
 *
 * Invariants:
 *  - balance is never negative;
 *  - balance currency always equals the wallet currency;
 *  - `version` increments only when the balance actually changes
 *    (used for optimistic concurrency control at the database level).
 *
 * This class is persistence-agnostic; database mapping lives elsewhere.
 */
export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: Currency;
  readonly createdAt: Date;
  private _balance: Money;
  private _version: number;

  private constructor(props: WalletProps) {
    if (!props.balance.currency.equals(props.currency)) {
      throw new DomainError(FailureCode.CURRENCY_MISMATCH, 'Balance currency differs from wallet currency');
    }
    if (props.balance.isNegative()) {
      throw new DomainError(FailureCode.INVALID_AMOUNT, 'Wallet balance cannot be negative');
    }
    this.id = props.id;
    this.playerId = props.playerId;
    this.currency = props.currency;
    this.createdAt = props.createdAt;
    this._balance = props.balance;
    this._version = props.version;
  }

  /** Creates a brand-new wallet with zero balance. Opening credits are applied via `credit`. */
  static open(params: { id: string; playerId: string; currency: Currency; now?: Date }): Wallet {
    return new Wallet({
      id: params.id,
      playerId: params.playerId,
      currency: params.currency,
      balance: Money.zero(params.currency),
      version: 0,
      createdAt: params.now ?? new Date(),
    });
  }

  /** Rebuilds a wallet from persisted state. */
  static restore(props: WalletProps): Wallet {
    return new Wallet(props);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  /** Adds funds (WIN, REFUND, OPENING, reversal of a BET). */
  credit(amount: Money): void {
    this.assertValidAmount(amount);
    this.applyDelta(amount);
  }

  /** Removes funds for a BET. Fails with INSUFFICIENT_FUNDS if it would overdraw. */
  debit(amount: Money): void {
    this.assertValidAmount(amount);
    if (this._balance.lessThan(amount)) {
      throw new DomainError(
        FailureCode.INSUFFICIENT_FUNDS,
        `Insufficient funds: balance ${this._balance.toDecimal()}, requested ${amount.toDecimal()}`,
      );
    }
    this.applyDelta(amount.negate());
  }

  /**
   * Removes funds to reverse a previous credit (ROLLBACK of WIN/REFUND).
   * Distinct failure code from a BET with insufficient funds: the money was
   * already granted and spent, which usually needs operational follow-up.
   */
  reverseCredit(amount: Money): void {
    this.assertValidAmount(amount);
    if (this._balance.lessThan(amount)) {
      throw new DomainError(
        FailureCode.REVERSAL_WOULD_OVERDRAW,
        `Reversal would overdraw: balance ${this._balance.toDecimal()}, reversal ${amount.toDecimal()}`,
      );
    }
    this.applyDelta(amount.negate());
  }

  private applyDelta(delta: Money): void {
    if (delta.isZero()) return; // no balance change → no version bump
    this._balance = this._balance.add(delta);
    this._version += 1;
  }

  private assertValidAmount(amount: Money): void {
    if (!amount.currency.equals(this.currency)) {
      throw new DomainError(
        FailureCode.CURRENCY_MISMATCH,
        `Wallet currency is ${this.currency.code}, got ${amount.currency.code}`,
      );
    }
    if (!amount.isPositive()) {
      throw new DomainError(FailureCode.INVALID_AMOUNT, 'Amount must be greater than zero');
    }
  }
}
