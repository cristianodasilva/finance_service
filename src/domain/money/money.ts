import { DomainError, FailureCode } from '../errors';
import { Currency } from './currency';

/**
 * Immutable monetary value.
 *
 * Internally stored as an integer number of minor units (cents) in a bigint,
 * so arithmetic is exact. Floats (`number`) are never used for amounts.
 * Input and output use decimal strings with exactly `currency.scale` places.
 */
export class Money {
  private constructor(
    /** Amount in minor units (e.g. cents). May be negative. */
    readonly minor: bigint,
    readonly currency: Currency,
  ) {
    Object.freeze(this);
  }

  static zero(currency: Currency): Money {
    return new Money(0n, currency);
  }

  static fromMinor(minor: bigint, currency: Currency): Money {
    return new Money(minor, currency);
  }

  /**
   * Parses a decimal string such as "10", "10.5" or "10.50".
   * Rejects more decimal places than the currency allows (no silent rounding),
   * scientific notation, spaces and any non-string input.
   */
  static fromDecimal(value: string, currency: Currency): Money {
    if (typeof value !== 'string') {
      throw new DomainError(FailureCode.INVALID_AMOUNT, 'Amount must be a decimal string');
    }
    const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) {
      throw new DomainError(FailureCode.INVALID_AMOUNT, `Invalid amount: "${value}"`);
    }
    const [, sign = '', integerPart = '0', fractionPart = ''] = match;
    if (fractionPart.length > currency.scale) {
      throw new DomainError(
        FailureCode.INVALID_AMOUNT,
        `Amount "${value}" has more than ${currency.scale} decimal places`,
      );
    }
    const minorDigits = integerPart + fractionPart.padEnd(currency.scale, '0');
    const minor = BigInt(minorDigits);
    return new Money(sign === '-' ? -minor : minor, currency);
  }

  /** Formats as a decimal string with exactly `currency.scale` places, e.g. "100.00". */
  toDecimal(): string {
    const scale = this.currency.scale;
    const negative = this.minor < 0n;
    const digits = (negative ? -this.minor : this.minor).toString().padStart(scale + 1, '0');
    const integerPart = digits.slice(0, digits.length - scale);
    const fractionPart = digits.slice(digits.length - scale);
    const body = scale > 0 ? `${integerPart}.${fractionPart}` : integerPart;
    return negative ? `-${body}` : body;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  equals(other: Money): boolean {
    return this.currency.equals(other.currency) && this.minor === other.minor;
  }

  greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor > other.minor;
  }

  lessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  toString(): string {
    return `${this.toDecimal()} ${this.currency.code}`;
  }

  /** Prevents accidental JSON serialization as `{ minor: 123n }` (bigint throws). */
  toJSON(): { amount: string; currency: string } {
    return { amount: this.toDecimal(), currency: this.currency.code };
  }

  private assertSameCurrency(other: Money): void {
    if (!this.currency.equals(other.currency)) {
      throw new DomainError(
        FailureCode.CURRENCY_MISMATCH,
        `Currency mismatch: ${this.currency.code} vs ${other.currency.code}`,
      );
    }
  }
}
