import { DomainError, FailureCode } from '../errors';
import type { Money } from '../money/money';
import type { Wallet } from '../wallet/wallet';
import type { WagerKind, WagerStatus } from './wager-kind';

/**
 * REGRAS DE NEGÓCIO das transações de aposta, em TypeScript puro (sem banco).
 *
 * A função `decideWager` recebe tudo o que precisa já carregado
 * (carteira, transação referenciada, etc.) e devolve a DECISÃO:
 *   - PROCESSED (com o movimento de saldo, se houver),
 *   - REJECTED (com o código do motivo), ou
 *   - PENDING_REFERENCE (a referência ainda não chegou).
 *
 * Ela também aplica o movimento na carteira (credit/debit/reverseCredit).
 * Quem chama é responsável por gravar o resultado no banco.
 */

/** O pedido que chegou (do HTTP ou da fila), já validado. */
export interface WagerCommand {
  provider: string;
  providerTransactionId: string;
  kind: WagerKind;
  playerId: string;
  walletId: string;
  amount: Money;
  roundId: string | null;
  referenceProviderTransactionId: string | null;
}

/** Resumo da transação referenciada (lida do banco). */
export interface ReferenceSnapshot {
  id: string;
  provider: string;
  kind: WagerKind;
  status: WagerStatus;
  playerId: string;
  walletId: string;
  amount: Money;
  roundId: string | null;
  /** Já existe um ROLLBACK processado apontando para ela? */
  rolledBack: boolean;
  /** Já existe um REFUND processado apontando para ela? */
  refunded: boolean;
}

export type LedgerMovement = { direction: 'CREDIT' | 'DEBIT'; amount: Money };

export type WagerDecision =
  | { status: 'PROCESSED'; movement: LedgerMovement | null }
  | { status: 'REJECTED'; failureCode: FailureCode }
  | { status: 'PENDING_REFERENCE' };

const rejected = (failureCode: FailureCode): WagerDecision => ({ status: 'REJECTED', failureCode });

export function decideWager(params: {
  command: WagerCommand;
  wallet: Wallet;
  /** `null` = a referência não foi encontrada (ainda). `undefined` = não precisa de referência. */
  reference: ReferenceSnapshot | null | undefined;
}): WagerDecision {
  const { command, wallet, reference } = params;

  // 1) A carteira precisa ser do jogador e da moeda informados.
  if (wallet.playerId !== command.playerId) return rejected(FailureCode.PLAYER_MISMATCH);
  if (!wallet.currency.equals(command.amount.currency)) return rejected(FailureCode.CURRENCY_MISMATCH);

  // 2) Transações que dependem de outra: a referência precisa existir e "bater".
  if (reference === null) return { status: 'PENDING_REFERENCE' };
  if (reference !== undefined) {
    const problem = checkReference(command, reference);
    if (problem) return rejected(problem);
  }

  // 3) Aplica a regra de cada tipo. Erros de domínio (ex.: sem saldo) viram REJECTED.
  try {
    return applyKind(command, wallet, reference ?? undefined);
  } catch (error) {
    if (error instanceof DomainError) return rejected(error.code);
    throw error;
  }
}

/** Confere se a referência é compatível. Devolve o código do problema, ou null se ok. */
function checkReference(command: WagerCommand, ref: ReferenceSnapshot): FailureCode | null {
  // Precisa ser do mesmo provedor, jogador, carteira, moeda e rodada.
  const sameRound = command.roundId === null || ref.roundId === null || command.roundId === ref.roundId;
  if (
    ref.provider !== command.provider ||
    ref.playerId !== command.playerId ||
    ref.walletId !== command.walletId ||
    !ref.amount.currency.equals(command.amount.currency) ||
    !sameRound
  ) {
    return FailureCode.REFERENCE_MISMATCH;
  }

  // Que tipo de transação pode ser referenciada por cada tipo?
  const allowed: Record<string, WagerKind[]> = {
    WIN: ['BET'],
    LOSS: ['BET'],
    REFUND: ['BET'],
    ROLLBACK: ['BET', 'WIN', 'REFUND'],
  };
  if (!allowed[command.kind]?.includes(ref.kind)) return FailureCode.REFERENCE_INVALID_KIND;

  // Só faz sentido pagar/devolver/desfazer algo que foi PROCESSADO.
  if (ref.status !== 'PROCESSED') return FailureCode.REFERENCE_NOT_PROCESSED;

  if (command.kind === 'ROLLBACK') {
    if (ref.rolledBack) return FailureCode.ALREADY_ROLLED_BACK;
    if (!ref.amount.equals(command.amount)) return FailureCode.ROLLBACK_AMOUNT_MISMATCH;
  } else {
    // WIN/LOSS/REFUND sobre uma aposta que já foi desfeita não fazem sentido.
    if (ref.rolledBack) return FailureCode.REFERENCE_ROLLED_BACK;
  }

  if (command.kind === 'REFUND') {
    if (ref.refunded) return FailureCode.ALREADY_REFUNDED;
    if (command.amount.greaterThan(ref.amount)) return FailureCode.REFUND_EXCEEDS_BET;
  }
  return null;
}

function applyKind(command: WagerCommand, wallet: Wallet, ref: ReferenceSnapshot | undefined): WagerDecision {
  const amount = command.amount;
  switch (command.kind) {
    case 'BET':
      wallet.debit(amount); // pode lançar INSUFFICIENT_FUNDS
      return { status: 'PROCESSED', movement: { direction: 'DEBIT', amount } };

    case 'WIN':
    case 'REFUND':
      wallet.credit(amount);
      return { status: 'PROCESSED', movement: { direction: 'CREDIT', amount } };

    case 'LOSS':
      // Perda: a aposta já foi debitada no BET. Nada muda no saldo.
      return { status: 'PROCESSED', movement: null };

    case 'ROLLBACK':
      // Desfaz a transação original fazendo o movimento CONTRÁRIO.
      if (ref!.kind === 'BET') {
        wallet.credit(amount); // devolve o valor apostado
        return { status: 'PROCESSED', movement: { direction: 'CREDIT', amount } };
      }
      wallet.reverseCredit(amount); // retira o prêmio/devolução: pode lançar REVERSAL_WOULD_OVERDRAW
      return { status: 'PROCESSED', movement: { direction: 'DEBIT', amount } };

    case 'OPENING':
      throw new Error('OPENING is internal and cannot be processed here');
  }
}
