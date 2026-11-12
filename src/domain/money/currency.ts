import { DomainError, FailureCode } from '../errors';

/**
 * Moeda: um código (ex.: 'BRL') e a quantidade de casas decimais (scale).
 * Real tem 2 casas (centavos). O iene japonês, por exemplo, tem 0.
 *
 * O modelo suporta várias moedas, mas só aceitamos as que estão em SUPPORTED.
 * O desafio pede exatamente isso: modelar multi-moeda, aceitar só BRL.
 */
export class Currency {
  // Construtor privado: ninguém de fora consegue fazer `new Currency(...)`.
  // A única forma de obter uma moeda é por Currency.BRL ou Currency.of('BRL').
  private constructor(
    readonly code: string,
    readonly scale: number,
  ) {
    Object.freeze(this); // congela o objeto: nenhuma propriedade pode ser alterada
  }

  static readonly BRL = new Currency('BRL', 2);

  // Lista de moedas aceitas. Para aceitar USD no futuro, basta adicionar aqui.
  private static readonly SUPPORTED: ReadonlyMap<string, Currency> = new Map([
    [Currency.BRL.code, Currency.BRL],
  ]);

  /** Busca a moeda pelo código. Lança erro se não for suportada. */
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
