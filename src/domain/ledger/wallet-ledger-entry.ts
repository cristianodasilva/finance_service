import { DomainError, FailureCode } from '../errors';
import { Money } from '../money/money';

export const LedgerDirection = { Debit: 'DEBIT', Credit: 'CREDIT' } as const;
export type LedgerDirection = (typeof LedgerDirection)[keyof typeof LedgerDirection];

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Versão da carteira DEPOIS deste lançamento (usada na paginação e na reconciliação). */
  walletVersion: number;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

/**
 * Lançamento do extrato (ledger). IMUTÁVEL de forma estrutural:
 * todos os campos são `readonly` e não existe nenhum método que altere o objeto.
 */
export class WalletLedgerEntry {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly money: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly walletVersion: number,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Cria um lançamento novo, validando a aritmética: antes ± valor = depois. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!props.money.isPositive()) {
      throw new DomainError(FailureCode.INVALID_AMOUNT, 'Ledger entry amount must be positive');
    }
    if (props.balanceAfter.isNegative()) {
      throw new DomainError(FailureCode.INSUFFICIENT_FUNDS, 'Ledger entry would leave a negative balance');
    }
    if (!entry.isBalanced()) {
      throw new Error(
        `Unbalanced ledger entry: ${props.balanceBefore} ${props.direction} ${props.money} ≠ ${props.balanceAfter}`,
      );
    }
    return entry;
  }

  /** Reconstrói a partir do banco (sem revalidar). */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
