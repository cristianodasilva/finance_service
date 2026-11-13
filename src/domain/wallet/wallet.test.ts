import { describe, expect, test } from 'bun:test';
import { brl, walletWith } from '../../../test/support/domain-builders';
import { DomainError, FailureCode } from '../errors';
import { Money } from '../money/money';
import { Wallet } from './wallet';

const ctx = (n: number) => ({ transactionId: `tx-${n}`, entryId: `e-${n}`, at: new Date() });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  return undefined;
}

describe('Wallet', () => {
  test('open: versão 1; saldo inicial gera o lançamento CREDIT de abertura', () => {
    const w = walletWith('100.00');
    expect(w.version).toBe(1);
    expect(w.balance.toJSON().amount).toBe('100.00');
    expect(w.openingEntry?.direction).toBe('CREDIT');
    expect(w.openingEntry?.balanceBefore.toJSON().amount).toBe('0.00');
    expect(w.openingEntry?.balanceAfter.toJSON().amount).toBe('100.00');
  });

  test('open sem saldo: versão 1 e nenhum lançamento', () => {
    const w = walletWith('0');
    expect(w.version).toBe(1);
    expect(w.openingEntry).toBeNull();
  });

  test('debit e credit devolvem o lançamento e sobem a versão', () => {
    const w = walletWith('100.00');
    const d = w.debit(brl('80.00'), ctx(1));
    expect(d).toMatchObject({ direction: 'DEBIT', walletVersion: 2 });
    expect(d.balanceBefore.toJSON().amount).toBe('100.00');
    expect(d.balanceAfter.toJSON().amount).toBe('20.00');
    expect(d.isBalanced()).toBe(true);
    const c = w.credit(brl('5.00'), ctx(2));
    expect(c.balanceAfter.toJSON().amount).toBe('25.00');
    expect(w.version).toBe(3);
  });

  test('saldo insuficiente: INSUFFICIENT_FUNDS e nada muda', () => {
    const w = walletWith('20.00');
    expect(codeOf(() => w.debit(brl('80.00'), ctx(1)))).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(w.balance.toJSON().amount).toBe('20.00');
    expect(w.version).toBe(1);
  });

  test('estorno de crédito já gasto: REVERSAL_WOULD_OVERDRAW (código diferente)', () => {
    const w = walletWith('10.00');
    expect(codeOf(() => w.reverseCredit(brl('50.00'), ctx(1)))).toBe(FailureCode.REVERSAL_WOULD_OVERDRAW);
  });

  test('conflito de moeda: operação em outra moeda é rejeitada', () => {
    const w = walletWith('10.00');
    const other = Money.fromMinor(100n, { code: 'USD', scale: 2, equals: () => false } as never);
    expect(codeOf(() => w.credit(other, ctx(1)))).toBe(FailureCode.CURRENCY_MISMATCH);
  });

  test.each(['0.00'])('rejeita valor não positivo %s', (v) => {
    expect(codeOf(() => walletWith('10.00').credit(brl(v), ctx(1)))).toBe(FailureCode.INVALID_AMOUNT);
  });

  test('rehydrate remonta o estado sem revalidar', () => {
    const w = Wallet.rehydrate({
      id: 'w', playerId: 'p', currency: brl('0').currency, balance: brl('7.00'),
      version: 9, createdAt: new Date(0), updatedAt: new Date(1),
    });
    expect(w.version).toBe(9);
    expect(w.updatedAt).toEqual(new Date(1));
  });
});
