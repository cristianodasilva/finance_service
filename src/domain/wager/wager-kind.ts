/** Tipos de transação. OPENING é interno (saldo inicial ao abrir a carteira). */
export const WAGER_KINDS = ['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type WagerKind = (typeof WAGER_KINDS)[number];

/** Tipos que o provedor de jogos pode enviar (OPENING não). */
export const EXTERNAL_WAGER_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type ExternalWagerKind = (typeof EXTERNAL_WAGER_KINDS)[number];

/**
 * Estados de uma transação.
 *  - PENDING: recebida, ainda não decidida.
 *  - PENDING_REFERENCE: aguardando a transação referenciada chegar (vai tentar de novo).
 *  - PROCESSED / REJECTED / FAILED: estados FINAIS, nunca mudam depois.
 */
export type WagerStatus = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';

/** Tipos que dependem de outra transação (precisam de referência). */
export function requiresReference(kind: WagerKind): boolean {
  return kind === 'WIN' || kind === 'LOSS' || kind === 'REFUND' || kind === 'ROLLBACK';
}
