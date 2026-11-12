import { DomainError, FailureCode } from '../errors';
import { Currency } from './currency';

/**
 * Valor monetário imutável (não pode ser alterado depois de criado).
 *
 * Por dentro, guardamos a quantidade de CENTAVOS num `bigint`
 * (número inteiro sem limite de tamanho). Ex.: R$ 100,50 → 10050n.
 * Contas com inteiros são exatas; nunca usamos `number` (ponto flutuante).
 *
 * Para entrar e sair do sistema usamos texto (string) com casas fixas: "100.50".
 */
export class Money {
  private constructor(
    /** Valor em centavos (pode ser negativo, ex.: ao calcular uma diferença). */
    readonly minor: bigint,
    readonly currency: Currency,
  ) {
    Object.freeze(this);
  }

  /** Cria R$ 0,00. */
  static zero(currency: Currency): Money {
    return new Money(0n, currency);
  }

  /** Cria a partir de centavos. Ex.: fromMinor(10050n, BRL) → R$ 100,50. */
  static fromMinor(minor: bigint, currency: Currency): Money {
    return new Money(minor, currency);
  }

  /**
   * Converte um texto como "10", "10.5" ou "10.50" em Money.
   *
   * Rejeita (lança erro):
   *  - mais casas decimais que a moeda permite, ex.: "1.234" (não arredondamos escondido);
   *  - notação científica ("1e3"), espaços, vírgula ("1,00");
   *  - qualquer coisa que não seja string (ex.: o número 10.5).
   */
  static fromDecimal(value: string, currency: Currency): Money {
    if (typeof value !== 'string') {
      throw new DomainError(FailureCode.INVALID_AMOUNT, 'Amount must be a decimal string');
    }

    // Expressão regular (regex) que valida o formato:
    //   (-?)      → sinal de menos opcional
    //   (\d+)     → um ou mais dígitos: a parte inteira
    //   (\.(\d+))? → opcional: ponto seguido de dígitos (a parte decimal)
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

    // Truque: juntar parte inteira + parte decimal completada com zeros.
    // "100.5" → "100" + "50" → "10050" → 10050n centavos.
    const minorDigits = integerPart + fractionPart.padEnd(currency.scale, '0');
    const minor = BigInt(minorDigits);
    return new Money(sign === '-' ? -minor : minor, currency);
  }

  /** Converte de volta para texto com casas fixas. Ex.: 10050n → "100.50". */
  toDecimal(): string {
    const scale = this.currency.scale;
    const negative = this.minor < 0n;
    // padStart garante dígitos suficientes: 5n centavos → "005" → "0.05"
    const digits = (negative ? -this.minor : this.minor).toString().padStart(scale + 1, '0');
    const integerPart = digits.slice(0, digits.length - scale);
    const fractionPart = digits.slice(digits.length - scale);
    const body = scale > 0 ? `${integerPart}.${fractionPart}` : integerPart;
    return negative ? `-${body}` : body;
  }

  // As operações abaixo NUNCA alteram este objeto: sempre devolvem um Money novo.

  /** Soma. */
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  /** Subtração. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor - other.minor, this.currency);
  }

  /** Inverte o sinal: 10.00 → -10.00. */
  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  /** É zero? */
  isZero(): boolean {
    return this.minor === 0n;
  }

  /** É maior que zero? */
  isPositive(): boolean {
    return this.minor > 0n;
  }

  /** É menor que zero? */
  isNegative(): boolean {
    return this.minor < 0n;
  }

  /** Mesmo valor e mesma moeda? */
  equals(other: Money): boolean {
    return this.currency.equals(other.currency) && this.minor === other.minor;
  }

  /** Este valor é maior que o outro? */
  greaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor > other.minor;
  }

  /** Este valor é menor que o outro? */
  lessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  /** Texto para logs/depuração. Ex.: "100.50 BRL". */
  toString(): string {
    return `${this.toDecimal()} ${this.currency.code}`;
  }

  /**
   * Define como o objeto vira JSON (usado pelo JSON.stringify e pelas respostas da API).
   * Sem isso daria erro, porque o JSON não sabe representar `bigint`.
   */
  toJSON(): { amount: string; currency: string } {
    return { amount: this.toDecimal(), currency: this.currency.code };
  }

  /** Garante que não estamos misturando moedas (ex.: BRL + USD). */
  private assertSameCurrency(other: Money): void {
    if (!this.currency.equals(other.currency)) {
      throw new DomainError(
        FailureCode.CURRENCY_MISMATCH,
        `Currency mismatch: ${this.currency.code} vs ${other.currency.code}`,
      );
    }
  }
}
