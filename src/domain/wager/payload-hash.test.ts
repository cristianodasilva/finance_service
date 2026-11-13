import { describe, expect, test } from 'bun:test';
import { canonicalJson, payloadHash } from './payload-hash';

describe('payloadHash', () => {
  const base = {
    providerId: 'provider-a', externalTransactionId: 'tx-1', playerId: 'p', walletId: 'w',
    roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
  };

  test('JSON canônico: chaves ordenadas em todos os níveis, sem espaços, nulos omitidos', () => {
    expect(canonicalJson({ b: 1, a: { d: null, c: 'x' } })).toBe('{"a":{"c":"x"},"b":1}');
  });

  test('a ordem das chaves não muda o hash', () => {
    const reordered = { money: { currency: 'BRL', amount: '25.00' }, kind: 'BET', gameId: 'g', roundId: 'r', walletId: 'w', playerId: 'p', externalTransactionId: 'tx-1', providerId: 'provider-a' };
    expect(payloadHash(reordered)).toBe(payloadHash(base));
  });

  test('referência ausente ou nula dão o mesmo hash', () => {
    expect(payloadHash({ ...base, referenceExternalTransactionId: null })).toBe(payloadHash(base));
  });

  test('payload divergente → hash diferente', () => {
    expect(payloadHash({ ...base, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(payloadHash(base));
    expect(payloadHash(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
