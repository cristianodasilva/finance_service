import { describe, expect, test } from 'bun:test';
import { brl } from '../../../test/support/domain-builders';
import { WalletLedgerEntry } from './wallet-ledger-entry';

const base = { id: 'e', walletId: 'w', transactionId: 't', walletVersion: 2, createdAt: new Date() };

describe('WalletLedgerEntry', () => {
  test('create valida a aritmética: antes ± valor = depois', () => {
    const ok = WalletLedgerEntry.create({ ...base, direction: 'DEBIT', money: brl('30.00'), balanceBefore: brl('100.00'), balanceAfter: brl('70.00') });
    expect(ok.isBalanced()).toBe(true);
    expect(() =>
      WalletLedgerEntry.create({ ...base, direction: 'CREDIT', money: brl('30.00'), balanceBefore: brl('100.00'), balanceAfter: brl('70.00') }),
    ).toThrow(/Unbalanced/);
  });

  test('é estruturalmente imutável', () => {
    const e = WalletLedgerEntry.create({ ...base, direction: 'CREDIT', money: brl('1.00'), balanceBefore: brl('0'), balanceAfter: brl('1.00') });
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      (e as unknown as { direction: string }).direction = 'DEBIT';
    }).toThrow();
  });
});
