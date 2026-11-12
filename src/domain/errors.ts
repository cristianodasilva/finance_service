/**
 * Códigos de falha "estáveis".
 *
 * Estável = o texto nunca muda. Esses códigos aparecem nas respostas da API,
 * nos eventos publicados e nas transações rejeitadas salvas no banco.
 * Se renomearmos um deles, quem depende do código (outros sistemas) quebra.
 */
export const FailureCode = {
  INVALID_REQUEST: 'INVALID_REQUEST', // campos ausentes ou em formato errado
  INVALID_AMOUNT: 'INVALID_AMOUNT', // valor inválido (formato errado, zero, negativo...)
  UNSUPPORTED_CURRENCY: 'UNSUPPORTED_CURRENCY', // moeda não aceita (ex.: USD)
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH', // tentativa de misturar moedas diferentes
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS', // saldo insuficiente para uma aposta (BET)
  REVERSAL_WOULD_OVERDRAW: 'REVERSAL_WOULD_OVERDRAW', // estorno deixaria o saldo negativo
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND', // carteira não existe
  WALLET_ALREADY_EXISTS: 'WALLET_ALREADY_EXISTS', // jogador já tem carteira nessa moeda
  TRANSACTION_NOT_FOUND: 'TRANSACTION_NOT_FOUND', // transação não existe
  PLAYER_MISMATCH: 'PLAYER_MISMATCH', // a carteira informada não é deste jogador

  // --- Referências (WIN, LOSS, REFUND e ROLLBACK apontam para outra transação) ---
  REFERENCE_NOT_FOUND: 'REFERENCE_NOT_FOUND', // a transação referenciada nunca chegou (após as tentativas)
  REFERENCE_MISMATCH: 'REFERENCE_MISMATCH', // referência de outro jogador/carteira/moeda/rodada/provedor
  REFERENCE_INVALID_KIND: 'REFERENCE_INVALID_KIND', // ex.: WIN apontando para outro WIN
  REFERENCE_NOT_PROCESSED: 'REFERENCE_NOT_PROCESSED', // referência foi rejeitada (não há o que pagar/desfazer)
  REFERENCE_ROLLED_BACK: 'REFERENCE_ROLLED_BACK', // a aposta referenciada já foi desfeita
  ROLLBACK_AMOUNT_MISMATCH: 'ROLLBACK_AMOUNT_MISMATCH', // estorno com valor diferente do original
  ALREADY_ROLLED_BACK: 'ALREADY_ROLLED_BACK', // a transação já foi desfeita antes
  REFUND_EXCEEDS_BET: 'REFUND_EXCEEDS_BET', // devolução maior que a aposta
  ALREADY_REFUNDED: 'ALREADY_REFUNDED', // a aposta já foi devolvida

  // --- Conflitos de requisição (não viram transação rejeitada; respondem 409) ---
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED', // mesma chave, conteúdo diferente
  PROVIDER_TRANSACTION_CONFLICT: 'PROVIDER_TRANSACTION_CONFLICT', // mesmo id do provedor, conteúdo diferente
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
