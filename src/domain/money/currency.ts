import { DomainError, FailureCode } from '../errors';

/**
 * A currency and its number of decimal places (scale).
 * The model supports many currencies; only the ones in SUPPORTED are accepted.
 */
export class Currency {
  private constructor(
    readonly code: string,
    readonly scale: number,
  ) {
    Object.freeze(this);
  }

  static readonly BRL = new Currency('BRL', 2);

  private static readonly SUPPORTED: ReadonlyMap<string, Currency> = new Map([
    [Currency.BRL.code, Currency.BRL],
  ]);

  static of(code: string): Currency {
    const currency = Currency.SUPPORTED.get(code);
    if (!currency) {
      throw new DomainError(FailureCode.UNSUPPORTED_CURRENCY, `Unsupported currency: ${code}`);
    }
    return currency;
  }

  equals(other: Currency): boolean {
    return this.code === other.code;
  }
}
