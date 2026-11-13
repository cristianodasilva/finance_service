import { DomainError, FailureCode } from '../errors';
import { Currency } from './currency';

/** Formato do dinheiro nos contratos (API, fila, eventos): { "amount": "25.00", "currency": "BRL" }. */
export interface MoneyProps {
  /** Texto decimal com 2 casas, ex.: "25.00". */
  amount: string;
  /** Código ISO-4217, ex.: "BRL". */
  currency: string;
}

/** Aceita "10", "10.5", "10.50" (até 2 casas). Rejeita sinal, espaços, vírgula, notação científica... */
const INPUT_AMOUNT = /^(\d+)(?:\.(\d{1,2}))?$/;
/** Formato interno (permite sinal, para diferenças como a da reconciliação). */
const SIGNED_AMOUNT = /^(-?)(\d+)(?:\.(\d+))?$/;

/**
 * Valor monetário imutável.
 *
 * Por dentro: quantidade de CENTAVOS num `bigint` (inteiro exato, sem limite).
 * Ex.: R$ 100,50 → 10050n. Nunca usamos `number` (ponto flutuante) para dinheiro.
 * Por fora: sempre texto com 2 casas ("100.50").
 */
export class Money {
  private constructor(
    /** Valor em centavos (pode ser negativo, ex.: numa diferença). */
    readonly minor: bigint,
    readonly currency: Currency,
  ) {
    Object.freeze(this);
  }

  /**
   * Cria a partir do formato de CONTRATO ({ amount, currency }).
   * Rejeita: não-string, "", NaN, Infinity, "1e3", mais de 2 casas e NEGATIVOS.
   */
  static from(props: MoneyProps): Money {
    if (typeof props !== 'object' || props === null) {
      throw new DomainError(FailureCode.INVALID_AMOUNT, 'Money must be an object { amount, currency }');
    }
    if (typeof props.currency !== 'string') {
      throw new DomainError(FailureCode.UNSUPPORTED_CURRENCY, 'Currency must be an ISO-4217 string');
    }
    const currency = Currency.of(props.currency);
    if (typeof props.amount !== 'string') {
      throw new DomainError(FailureCode.INVALID_AMOUNT, 'Amount must be a decimal string');
    }
    const match = INPUT_AMOUNT.exec(props.amount);
    if (!match) {
      throw new DomainError(
        FailureCode.INVALID_AMOUNT,
        `Invalid amount "${props.amount}": expected a non-negative decimal with up to ${currency.scale} places`,
      );
    }
    const [, integerPart = '0', fractionPart = ''] = match;
    return new Money(BigInt(integerPart + fractionPart.padEnd(currency.scale, '0')), currency);
  }

  /**
   * Converte texto decimal (pode ter sinal) — uso INTERNO, ex.: ao ler do banco.
   * Ainda rejeita mais casas que a moeda permite (nunca arredonda escondido).
   */
  static fromDecimal(value: string, currency: Currency): Money {
    const match = typeof value === 'string' ? SIGNED_AMOUNT.exec(value) : null;
    if (!match) throw new DomainError(FailureCode.INVALID_AMOUNT, `Invalid amount: "${String(value)}"`);
    const [, sign = '', integerPart = '0', fractionPart = ''] = match;
    if (fractionPart.length > currency.scale) {
      throw new DomainError(FailureCode.INVALID_AMOUNT, `Amount "${value}" has more than ${currency.scale} decimal places`);
    }
    const minor = BigInt(integerPart + fractionPart.padEnd(currency.scale, '0'));
    return new Money(sign === '-' ? -minor : minor, currency);
  }

  static zero(currency: Currency | string): Money {
    return new Money(0n, typeof currency === 'string' ? Currency.of(currency) : currency);
  }

  static fromMinor(minor: bigint, currency: Currency): Money {
    return new Money(minor, currency);
  }

  /** Texto com 2 casas: 10050n → "100.50". */
  toDecimal(): string {
    const scale = this.currency.scale;
    const negative = this.minor < 0n;
    const digits = (negative ? -this.minor : this.minor).toString().padStart(scale + 1, '0');
    const body = scale > 0 ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
    return negative ? `-${body}` : body;
  }

  // Operações: NUNCA alteram este objeto; sempre devolvem um Money novo.
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

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor > other.minor;
  }

  equals(other: Money): boolean {
    return this.currency.equals(other.currency) && this.minor === other.minor;
  }

  /** Formato de contrato. Também é o que o JSON.stringify usa (bigint não vira JSON sozinho). */
  toJSON(): MoneyProps {
    return { amount: this.toDecimal(), currency: this.currency.code };
  }

  /** Para logs/depuração: "100.50 BRL". */
  toString(): string {
    return `${this.toDecimal()} ${this.currency.code}`;
  }

  /** Operações entre moedas diferentes são erro de domínio. */
  private assertSameCurrency(other: Money): void {
    if (!this.currency.equals(other.currency)) {
      throw new DomainError(
        FailureCode.CURRENCY_MISMATCH,
        `Currency mismatch: ${this.currency.code} vs ${other.currency.code}`,
      );
    }
  }
}
