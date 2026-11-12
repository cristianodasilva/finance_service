import { describe, expect, test } from 'bun:test';
import { DomainError, FailureCode } from '../errors';
import { Currency } from '../money/currency';
import { Money } from '../money/money';
import { Wallet } from './wallet';

const brl = (v: string) => Money.fromDecimal(v, Currency.BRL);
const newWallet = () => Wallet.open({ id: 'w-1', playerId: 'p-1', currency: Currency.BRL });

function codeOf(fn: () => unknown): FailureCode | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  return undefined;
}

describe('Wallet', () => {
  test('opens with zero balance and version 0', () => {
    const w = newWallet();
    expect(w.balance.toDecimal()).toBe('0.00');
    expect(w.version).toBe(0);
  });

  test('credit increases balance and bumps version', () => {
    const w = newWallet();
    w.credit(brl('100.00'));
    expect(w.balance.toDecimal()).toBe('100.00');
    expect(w.version).toBe(1);
  });

  test('debit decreases balance and bumps version', () => {
    const w = newWallet();
    w.credit(brl('100.00'));
    w.debit(brl('80.00'));
    expect(w.balance.toDecimal()).toBe('20.00');
    expect(w.version).toBe(2);
  });

  test('debit of the exact balance leaves zero', () => {
    const w = newWallet();
    w.credit(brl('50.00'));
    w.debit(brl('50.00'));
    expect(w.balance.isZero()).toBe(true);
  });

  test('second 80.00 debit on 100.00 fails with INSUFFICIENT_FUNDS and changes nothing', () => {
    const w = newWallet();
    w.credit(brl('100.00'));
    w.debit(brl('80.00'));
    const versionBefore = w.version;
    expect(codeOf(() => w.debit(brl('80.00')))).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(w.balance.toDecimal()).toBe('20.00');
    expect(w.version).toBe(versionBefore);
  });

  test('reversing a spent credit fails with REVERSAL_WOULD_OVERDRAW (distinct code)', () => {
    const w = newWallet();
    w.credit(brl('50.00')); // e.g. a WIN
    w.debit(brl('40.00')); // player spent it
    expect(codeOf(() => w.reverseCredit(brl('50.00')))).toBe(FailureCode.REVERSAL_WOULD_OVERDRAW);
    expect(w.balance.toDecimal()).toBe('10.00');
  });

  test('reverseCredit succeeds when balance is enough', () => {
    const w = newWallet();
    w.credit(brl('50.00'));
    w.reverseCredit(brl('50.00'));
    expect(w.balance.isZero()).toBe(true);
  });

  test.each(['0.00', '-1.00'])('rejects non-positive amount %s', (v) => {
    const w = newWallet();
    expect(codeOf(() => w.credit(brl(v)))).toBe(FailureCode.INVALID_AMOUNT);
    expect(codeOf(() => w.debit(brl(v)))).toBe(FailureCode.INVALID_AMOUNT);
    expect(w.version).toBe(0);
  });

  test('cannot be restored with a negative balance', () => {
    expect(
      codeOf(() =>
        Wallet.restore({
          id: 'w',
          playerId: 'p',
          currency: Currency.BRL,
          balance: brl('-1.00'),
          version: 3,
          createdAt: new Date(),
        }),
      ),
    ).toBe(FailureCode.INVALID_AMOUNT);
  });
});
