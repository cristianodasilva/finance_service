import { describe, expect, test } from 'bun:test';
import { DomainError, FailureCode } from '../errors';
import { Currency } from './currency';
import { Money } from './money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  return undefined;
}

describe('Money', () => {
  test('0.10 + 0.20 é exatamente 0.30 (sem erro de ponto flutuante)', () => {
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
  });

  test.each([
    ['100', '100.00', 10000n],
    ['100.5', '100.50', 10050n],
    ['0.01', '0.01', 1n],
    ['0', '0.00', 0n],
    ['007.10', '7.10', 710n],
  ])('from("%s") → "%s" (escala fixa de 2 casas)', (input, formatted, minor) => {
    const m = brl(input);
    expect(m.toJSON()).toEqual({ amount: formatted, currency: 'BRL' });
    expect(m.minor).toBe(minor);
  });

  test.each(['NaN', 'Infinity', '-Infinity', '1e3', '', ' 1.00', '1.', '.5', 'abc', '1,00', '+1', '1.234', '10.999', '-1.00'])(
    'rejeita entrada inválida "%s" (inclusive negativos e mais de 2 casas — nunca arredonda)',
    (input) => expect(codeOf(() => brl(input))).toBe(FailureCode.INVALID_AMOUNT),
  );

  test.each([10.5, NaN, Infinity, null, undefined])('rejeita amount que não é string (%p)', (amount) => {
    expect(codeOf(() => Money.from({ amount: amount as unknown as string, currency: 'BRL' }))).toBe(FailureCode.INVALID_AMOUNT);
  });

  test('rejeita moeda não suportada', () => {
    expect(codeOf(() => Money.from({ amount: '1.00', currency: 'USD' }))).toBe(FailureCode.UNSUPPORTED_CURRENCY);
  });

  test('suporta valores muito maiores que Number.MAX_SAFE_INTEGER', () => {
    expect(brl('99999999999999999999.99').add(brl('0.01')).toJSON().amount).toBe('100000000000000000000.00');
  });

  test('subtrai, nega e compara', () => {
    expect(brl('100.00').subtract(brl('80.00')).toJSON().amount).toBe('20.00');
    expect(brl('20.00').subtract(brl('80.00')).isNegative()).toBe(true);
    expect(brl('5.00').negate().toJSON().amount).toBe('-5.00');
    expect(brl('20.00').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
  });

  test('conflito de moeda: operar moedas diferentes lança CURRENCY_MISMATCH', () => {
    const usd = Money.fromMinor(100n, new (Currency as unknown as { new (c: string, s: number): Currency })('USD', 2));
    expect(codeOf(() => brl('1.00').add(usd))).toBe(FailureCode.CURRENCY_MISMATCH);
    expect(codeOf(() => brl('1.00').isLessThan(usd))).toBe(FailureCode.CURRENCY_MISMATCH);
    expect(brl('1.00').equals(usd)).toBe(false);
  });

  test('é imutável: operações devolvem instâncias novas', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.toJSON().amount).toBe('10.00');
    expect(b.toJSON().amount).toBe('15.00');
    expect(Object.isFrozen(a)).toBe(true);
  });

  test('JSON e toString', () => {
    expect(JSON.stringify(brl('25'))).toBe('{"amount":"25.00","currency":"BRL"}');
    expect(brl('25').toString()).toBe('25.00 BRL');
  });
});
