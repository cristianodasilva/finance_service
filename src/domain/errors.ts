/**
 * Códigos de falha ESTÁVEIS (contrato público: API, eventos, banco). Nunca renomear.
 *
 * Cada código diz ao provedor o que fazer — ver a tabela completa no ARCHITECTURE.md:
 *   - CORRIGIR o payload antes de reenviar;
 *   - DESISTIR: a decisão é definitiva (reenviar igual dá o mesmo resultado);
 *   - REENVIAR mais tarde: falha temporária (esses não são FailureCode, são TransientError → 503).
 */
export const FailureCode = {
  // ---- Entrada inválida → corrigir o payload (HTTP 400) ----
  INVALID_REQUEST: 'INVALID_REQUEST', // campo ausente, formato errado, kind OPENING enviado de fora
  INVALID_AMOUNT: 'INVALID_AMOUNT', // valor mal formatado, com mais de 2 casas, zero ou negativo
  UNSUPPORTED_CURRENCY: 'UNSUPPORTED_CURRENCY', // moeda não aceita (ex.: USD)

  // ---- Não encontrado (HTTP 404) ----
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  TRANSACTION_NOT_FOUND: 'TRANSACTION_NOT_FOUND',

  // ---- Conflitos (HTTP 409) ----
  WALLET_ALREADY_EXISTS: 'WALLET_ALREADY_EXISTS', // já existe carteira para player + moeda
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED', // mesma Idempotency-Key, payload diferente
  PROVIDER_TRANSACTION_CONFLICT: 'PROVIDER_TRANSACTION_CONFLICT', // mesmo (providerId, externalTransactionId), payload diferente
  INBOX_PAYLOAD_MISMATCH: 'INBOX_PAYLOAD_MISMATCH', // mesmo messageId da fila com conteúdo diferente

  // ---- Rejeições de negócio: a transação é gravada como REJECTED (HTTP 422) ----
  // Corrigir o payload:
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH', // moeda da operação ≠ moeda da carteira
  PLAYER_MISMATCH: 'PLAYER_MISMATCH', // a carteira não é deste jogador
  REFERENCE_MISMATCH: 'REFERENCE_MISMATCH', // referência de outro provider/player/carteira/moeda/rodada
  REFERENCE_INVALID_KIND: 'REFERENCE_INVALID_KIND', // ex.: REFUND apontando para um WIN
  REVERSAL_AMOUNT_MISMATCH: 'REVERSAL_AMOUNT_MISMATCH', // REFUND/ROLLBACK com valor ≠ da referência
  // Desistir (definitivo):
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS', // BET maior que o saldo
  REVERSAL_WOULD_OVERDRAW: 'REVERSAL_WOULD_OVERDRAW', // estorno de crédito já gasto (≠ de INSUFFICIENT_FUNDS)
  REFERENCE_NOT_PROCESSED: 'REFERENCE_NOT_PROCESSED', // a referência foi rejeitada: nada a pagar/reverter
  REFERENCE_ALREADY_REVERSED: 'REFERENCE_ALREADY_REVERSED', // a referência já foi revertida (REFUND ou ROLLBACK)
  REFERENCE_NOT_FOUND: 'REFERENCE_NOT_FOUND', // a referência não chegou dentro do limite de tentativas
} as const;

/** Tipo que aceita apenas um dos valores acima. */
export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

/**
 * Erro de REGRA DE NEGÓCIO: esperado, não é bug.
 * Tentar de novo com o mesmo pedido não muda o resultado.
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

/**
 * Erro de PROGRAMAÇÃO: alguém tentou mudar o estado de uma transação já finalizada
 * (PROCESSED, REJECTED ou FAILED). Nunca é caminho de negócio — se acontecer, é bug.
 */
export class InvalidTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionStateError';
  }
}
