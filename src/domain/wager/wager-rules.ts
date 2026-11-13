import { DomainError, FailureCode } from '../errors';
import type { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import type { Wallet } from '../wallet/wallet';
import { WagerKind, WagerStatus, type WagerTransaction } from './wager-transaction';

/**
 * REGRAS DE NEGÓCIO (TypeScript puro, sem banco).
 *
 * `decideWager` recebe tudo já carregado, aplica a regra do tipo da transação na carteira
 * e faz a transição de estado da transação. Devolve o lançamento do extrato, se houver.
 */

/** A transação referenciada + se ela já foi revertida (existe REFUND ou ROLLBACK PROCESSED apontando para ela). */
export interface ReferenceContext {
  transaction: WagerTransaction;
  reversed: boolean;
}

export type WagerOutcome =
  | { status: 'PROCESSED'; entry: WalletLedgerEntry | null }
  | { status: 'REJECTED'; failureCode: FailureCode }
  | { status: 'PENDING_REFERENCE' };

/** Que tipo de transação cada tipo pode referenciar. */
const ALLOWED_REFERENCES: Partial<Record<WagerKind, readonly WagerKind[]>> = {
  WIN: ['BET'],
  LOSS: ['BET'],
  REFUND: ['BET'],
  ROLLBACK: ['BET', 'WIN', 'REFUND'],
};

export function decideWager(params: {
  transaction: WagerTransaction;
  wallet: Wallet;
  /** undefined = a transação não referencia nada; null = referencia algo que (ainda) não existe. */
  reference: ReferenceContext | null | undefined;
  entryId: string;
  at: Date;
}): WagerOutcome {
  const { transaction: tx, wallet, reference, at } = params;
  const reject = (code: FailureCode): WagerOutcome => {
    tx.reject(code, at);
    return { status: 'REJECTED', failureCode: code };
  };

  // 1) Carteira do jogador certo, na moeda certa.
  if (wallet.playerId !== tx.playerId) return reject(FailureCode.PLAYER_MISMATCH);
  if (!wallet.currency.equals(tx.money.currency)) return reject(FailureCode.CURRENCY_MISMATCH);

  // 2) Referência (obrigatória em REFUND/ROLLBACK; opcional em WIN/LOSS).
  if (tx.referenceExternalTransactionId !== null) {
    // Ausente — ou existe mas ainda não foi decidida → aguardar.
    if (reference === null || reference === undefined || !reference.transaction.isTerminal()) {
      tx.markPendingReference();
      return { status: 'PENDING_REFERENCE' };
    }
    tx.linkReference(reference.transaction.id);
    const problem = checkReference(tx, reference);
    if (problem) return reject(problem);
  }

  // 3) Efeito no saldo. Erros de domínio (ex.: saldo insuficiente) viram REJECTED.
  try {
    const entry = applyMovement(tx, wallet, reference?.transaction, params.entryId, at);
    tx.markProcessed(reference?.transaction.id, at);
    return { status: 'PROCESSED', entry };
  } catch (error) {
    if (error instanceof DomainError) return reject(error.code);
    throw error;
  }
}

function checkReference(tx: WagerTransaction, ref: ReferenceContext): FailureCode | null {
  const r = ref.transaction;
  // Mesmo provider, jogador, carteira, moeda e rodada.
  if (
    r.providerId !== tx.providerId ||
    r.playerId !== tx.playerId ||
    r.walletId !== tx.walletId ||
    !r.money.currency.equals(tx.money.currency) ||
    r.roundId !== tx.roundId
  ) {
    return FailureCode.REFERENCE_MISMATCH;
  }
  if (!ALLOWED_REFERENCES[tx.kind]?.includes(r.kind)) return FailureCode.REFERENCE_INVALID_KIND;
  // Só se paga/reverte o que foi APLICADO.
  if (r.status !== WagerStatus.Processed) return FailureCode.REFERENCE_NOT_PROCESSED;
  // Já revertida (por REFUND ou ROLLBACK): nada mais pode usá-la.
  // Isso impede, por exemplo, REFUND e depois ROLLBACK da mesma BET (crédito duplicado).
  if (ref.reversed) return FailureCode.REFERENCE_ALREADY_REVERSED;
  // Reversões devolvem exatamente o valor original (reversão parcial está fora de escopo).
  if ((tx.kind === WagerKind.Refund || tx.kind === WagerKind.Rollback) && !r.money.equals(tx.money)) {
    return FailureCode.REVERSAL_AMOUNT_MISMATCH;
  }
  return null;
}

function applyMovement(
  tx: WagerTransaction,
  wallet: Wallet,
  reference: WagerTransaction | undefined,
  entryId: string,
  at: Date,
): WalletLedgerEntry | null {
  if (!tx.affectsBalance()) return null; // LOSS: nada muda no saldo nem no extrato
  const ctx = { transactionId: tx.id, entryId, at };
  const direction = tx.ledgerDirectionFor(reference);

  if (direction === 'CREDIT') return wallet.credit(tx.money, ctx);
  // Débito de ROLLBACK (desfaz WIN/REFUND): código próprio se deixaria o saldo negativo.
  if (tx.kind === WagerKind.Rollback) return wallet.reverseCredit(tx.money, ctx);
  return wallet.debit(tx.money, ctx);
}
