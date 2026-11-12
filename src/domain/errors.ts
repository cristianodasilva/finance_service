/**
 * Códigos de falha "estáveis".
 *
 * Estável = o texto nunca muda. Esses códigos aparecem nas respostas da API,
 * nos eventos publicados e nas transações rejeitadas salvas no banco.
 * Se renomearmos um deles, quem depende do código (outros sistemas) quebra.
 */
export const FailureCode = {
  INVALID_AMOUNT: 'INVALID_AMOUNT', // valor inválido (formato errado, zero, negativo...)
  UNSUPPORTED_CURRENCY: 'UNSUPPORTED_CURRENCY', // moeda não aceita (ex.: USD)
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH', // tentativa de misturar moedas diferentes
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS', // saldo insuficiente para uma aposta (BET)
  REVERSAL_WOULD_OVERDRAW: 'REVERSAL_WOULD_OVERDRAW', // estorno deixaria o saldo negativo
} as const;

/** Tipo que aceita apenas um dos valores acima (ex.: 'INSUFFICIENT_FUNDS'). */
export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

/**
 * Erro de regra de negócio.
 *
 * É um erro "esperado": não é bug nem falha de infraestrutura.
 * Tentar de novo não adianta (o saldo continuará insuficiente),
 * por isso a transação deve ser REJEITADA, e não reprocessada.
 */
export class DomainError extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
