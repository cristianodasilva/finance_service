import { describe, expect, test } from 'bun:test';
import { DomainError, FailureCode } from '../errors';
import { Currency } from './currency';
import { Money } from './money';

const BRL = Currency.BRL;
const brl = (v: string) => Money.fromDecimal(v, BRL);

function expectCode(fn: () => unknown, code: FailureCode) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).code).toBe(code);
    return;
  }
  throw new Error(`Expected DomainError ${code}`);
}

describe('Money', () => {
  test('0.10 + 0.20 is exactly 0.30 (no floating point error)', () => {
    expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    expect(brl('0.1').add(brl('0.2')).toDecimal()).toBe('0.30');
  });

  test.each([
    ['100', '100.00', 10000n],
    ['100.5', '100.50', 10050n],
    ['0.01', '0.01', 1n],
    ['0', '0.00', 0n],
    ['-12.34', '-12.34', -1234n],
    ['007.10', '7.10', 710n],
  ])('parses "%s" as %s', (input, formatted, minor) => {
    const m = brl(input);
    expect(m.toDecimal()).toBe(formatted);
    expect(m.minor).toBe(minor);
  });

  test('handles amounts far beyond Number.MAX_SAFE_INTEGER', () => {
    const big = brl('99999999999999999999.99');
    expect(big.add(brl('0.01')).toDecimal()).toBe('100000000000000000000.00');
  });

  test.each(['1.234', '1e3', ' 1.00', '1.', '.5', 'abc', '', '1,00', '+1'])(
    'rejects invalid input "%s"',
    (input) => expectCode(() => brl(input), FailureCode.INVALID_AMOUNT),
  );

  test('rejects non-string input such as a JS number', () => {
    expectCode(() => Money.fromDecimal(10.5 as unknown as string, BRL), FailureCode.INVALID_AMOUNT);
  });

  test('subtracts and compares', () => {
    expect(brl('100.00').subtract(brl('80.00')).toDecimal()).toBe('20.00');
    expect(brl('20.00').subtract(brl('80.00')).isNegative()).toBe(true);
    expect(brl('80.00').greaterThan(brl('20.00'))).toBe(true);
    expect(brl('20.00').lessThan(brl('80.00'))).toBe(true);
  });

  test('is immutable', () => {
    const a = brl('10.00');
    const b = a.add(brl('5.00'));
    expect(a.toDecimal()).toBe('10.00');
    expect(b.toDecimal()).toBe('15.00');
    expect(Object.isFrozen(a)).toBe(true);
    expect(() => {
      (a as unknown as { minor: bigint }).minor = 1n;
    }).toThrow();
  });

  test('serializes to JSON as decimal string', () => {
    expect(JSON.stringify(brl('10.5'))).toBe('{"amount":"10.50","currency":"BRL"}');
  });

  test('rejects unsupported currencies', () => {
    expectCode(() => Currency.of('USD'), FailureCode.UNSUPPORTED_CURRENCY);
    expect(Currency.of('BRL')).toBe(BRL);
  });
});
