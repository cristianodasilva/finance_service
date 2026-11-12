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
  test('abre com saldo zero e versão 0', () => {
    const w = newWallet();
    expect(w.balance.toDecimal()).toBe('0.00');
    expect(w.version).toBe(0);
  });

  test('crédito aumenta o saldo e incrementa a versão', () => {
    const w = newWallet();
    w.credit(brl('100.00'));
    expect(w.balance.toDecimal()).toBe('100.00');
    expect(w.version).toBe(1);
  });

  test('débito diminui o saldo e incrementa a versão', () => {
    const w = newWallet();
    w.credit(brl('100.00'));
    w.debit(brl('80.00'));
    expect(w.balance.toDecimal()).toBe('20.00');
    expect(w.version).toBe(2);
  });

  test('débito do saldo exato deixa zero', () => {
    const w = newWallet();
    w.credit(brl('50.00'));
    w.debit(brl('50.00'));
    expect(w.balance.isZero()).toBe(true);
  });

  test('segundo débito de 80.00 sobre 100.00 falha com INSUFFICIENT_FUNDS e não altera nada', () => {
    const w = newWallet();
    w.credit(brl('100.00'));
    w.debit(brl('80.00'));
    const versionBefore = w.version;
    expect(codeOf(() => w.debit(brl('80.00')))).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(w.balance.toDecimal()).toBe('20.00');
    expect(w.version).toBe(versionBefore);
  });

  test('estornar um crédito já gasto falha com REVERSAL_WOULD_OVERDRAW (código diferente)', () => {
    const w = newWallet();
    w.credit(brl('50.00')); // ex.: um prêmio (WIN)
    w.debit(brl('40.00')); // jogador gastou o prêmio
    expect(codeOf(() => w.reverseCredit(brl('50.00')))).toBe(FailureCode.REVERSAL_WOULD_OVERDRAW);
    expect(w.balance.toDecimal()).toBe('10.00');
  });

  test('estorno funciona quando há saldo suficiente', () => {
    const w = newWallet();
    w.credit(brl('50.00'));
    w.reverseCredit(brl('50.00'));
    expect(w.balance.isZero()).toBe(true);
  });

  test.each(['0.00', '-1.00'])('rejeita valor não positivo %s', (v) => {
    const w = newWallet();
    expect(codeOf(() => w.credit(brl(v)))).toBe(FailureCode.INVALID_AMOUNT);
    expect(codeOf(() => w.debit(brl(v)))).toBe(FailureCode.INVALID_AMOUNT);
    expect(w.version).toBe(0);
  });

  test('não pode ser remontada com saldo negativo', () => {
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
