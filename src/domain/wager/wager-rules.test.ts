import { describe, expect, test } from 'bun:test';
import { brl, id, processed, wager, walletWith } from '../../../test/support/domain-builders';
import { FailureCode } from '../errors';
import type { WagerTransaction } from './wager-transaction';
import { decideWager, type ReferenceContext } from './wager-rules';

const decide = (tx: WagerTransaction, wallet = walletWith('100.00'), reference?: ReferenceContext | null) =>
  decideWager({ transaction: tx, wallet, reference, entryId: id('entry'), at: new Date() });

const ref = (tx: WagerTransaction, reversed = false): ReferenceContext => ({ transaction: tx, reversed });
const betOf = (amount: string) => processed(wager('BET', amount, { externalTransactionId: 'bet-1' }));
const withRef = { referenceExternalTransactionId: 'bet-1' };

describe('decideWager', () => {
  describe('BET', () => {
    test('debita e gera 1 lançamento DEBIT', () => {
      const w = walletWith('100.00');
      const tx = wager('BET', '80.00');
      const out = decide(tx, w);
      expect(out.status).toBe('PROCESSED');
      expect(out.status === 'PROCESSED' && out.entry?.direction).toBe('DEBIT');
      expect(w.balance.toJSON().amount).toBe('20.00');
      expect(tx.status).toBe('PROCESSED');
    });

    test('saldo insuficiente → REJECTED, sem lançamento e sem mexer na carteira', () => {
      const w = walletWith('20.00');
      const tx = wager('BET', '80.00');
      expect(decide(tx, w)).toEqual({ status: 'REJECTED', failureCode: FailureCode.INSUFFICIENT_FUNDS });
      expect(tx.status).toBe('REJECTED');
      expect(w.version).toBe(1);
    });

    test('carteira de outro jogador → PLAYER_MISMATCH', () => {
      expect(decide(wager('BET', '1.00', { playerId: 'outro' }))).toEqual({ status: 'REJECTED', failureCode: FailureCode.PLAYER_MISMATCH });
    });
  });

  describe('WIN e LOSS', () => {
    test('WIN sem referência credita', () => {
      const w = walletWith('20.00');
      expect(decide(wager('WIN', '50.00'), w).status).toBe('PROCESSED');
      expect(w.balance.toJSON().amount).toBe('70.00');
    });

    test('WIN referenciando a BET da mesma rodada credita', () => {
      const w = walletWith('20.00');
      expect(decide(wager('WIN', '50.00', withRef), w, ref(betOf('80.00'))).status).toBe('PROCESSED');
    });

    test('LOSS não move saldo, não gera lançamento, não muda a versão', () => {
      const w = walletWith('20.00');
      expect(decide(wager('LOSS', '0'), w)).toEqual({ status: 'PROCESSED', entry: null });
      expect(w.version).toBe(1);
    });

    test('WIN com referência ainda ausente → PENDING_REFERENCE', () => {
      const tx = wager('WIN', '5.00', withRef);
      expect(decide(tx, walletWith('0'), null).status).toBe('PENDING_REFERENCE');
      expect(tx.status).toBe('PENDING_REFERENCE');
    });

    test('WIN sobre BET já revertida → REFERENCE_ALREADY_REVERSED', () => {
      expect(decide(wager('WIN', '5.00', withRef), walletWith('0'), ref(betOf('5.00'), true))).toEqual({
        status: 'REJECTED', failureCode: FailureCode.REFERENCE_ALREADY_REVERSED,
      });
    });
  });

  describe('REFUND', () => {
    test('devolve a BET (valor igual)', () => {
      const w = walletWith('20.00');
      expect(decide(wager('REFUND', '80.00', withRef), w, ref(betOf('80.00'))).status).toBe('PROCESSED');
      expect(w.balance.toJSON().amount).toBe('100.00');
    });

    test('valor diferente da BET → REVERSAL_AMOUNT_MISMATCH (reversão parcial fora de escopo)', () => {
      expect(decide(wager('REFUND', '40.00', withRef), walletWith('0'), ref(betOf('80.00')))).toEqual({
        status: 'REJECTED', failureCode: FailureCode.REVERSAL_AMOUNT_MISMATCH,
      });
    });

    test('só referencia BET → REFERENCE_INVALID_KIND', () => {
      const win = processed(wager('WIN', '5.00', { externalTransactionId: 'bet-1' }));
      expect(decide(wager('REFUND', '5.00', withRef), walletWith('0'), ref(win))).toEqual({
        status: 'REJECTED', failureCode: FailureCode.REFERENCE_INVALID_KIND,
      });
    });

    test('BET já revertida (REFUND ou ROLLBACK) → REFERENCE_ALREADY_REVERSED', () => {
      expect(decide(wager('REFUND', '80.00', withRef), walletWith('0'), ref(betOf('80.00'), true))).toEqual({
        status: 'REJECTED', failureCode: FailureCode.REFERENCE_ALREADY_REVERSED,
      });
    });

    test('BET rejeitada → REFERENCE_NOT_PROCESSED', () => {
      const bet = wager('BET', '80.00', { externalTransactionId: 'bet-1' });
      bet.reject(FailureCode.INSUFFICIENT_FUNDS);
      expect(decide(wager('REFUND', '80.00', withRef), walletWith('0'), ref(bet))).toEqual({
        status: 'REJECTED', failureCode: FailureCode.REFERENCE_NOT_PROCESSED,
      });
    });
  });

  describe('ROLLBACK', () => {
    test('de BET devolve o valor (CREDIT)', () => {
      const w = walletWith('20.00');
      const out = decide(wager('ROLLBACK', '80.00', withRef), w, ref(betOf('80.00')));
      expect(out.status === 'PROCESSED' && out.entry?.direction).toBe('CREDIT');
      expect(w.balance.toJSON().amount).toBe('100.00');
    });

    test('de WIN retira o prêmio (DEBIT)', () => {
      const w = walletWith('70.00');
      const win = processed(wager('WIN', '50.00', { externalTransactionId: 'bet-1' }));
      decide(wager('ROLLBACK', '50.00', withRef), w, ref(win));
      expect(w.balance.toJSON().amount).toBe('20.00');
    });

    test('de WIN já gasto → REVERSAL_WOULD_OVERDRAW (≠ INSUFFICIENT_FUNDS)', () => {
      const win = processed(wager('WIN', '50.00', { externalTransactionId: 'bet-1' }));
      expect(decide(wager('ROLLBACK', '50.00', withRef), walletWith('10.00'), ref(win))).toEqual({
        status: 'REJECTED', failureCode: FailureCode.REVERSAL_WOULD_OVERDRAW,
      });
    });

    test('REFUND e depois ROLLBACK da MESMA BET → recusado (sem crédito duplicado)', () => {
      expect(decide(wager('ROLLBACK', '80.00', withRef), walletWith('100.00'), ref(betOf('80.00'), true))).toEqual({
        status: 'REJECTED', failureCode: FailureCode.REFERENCE_ALREADY_REVERSED,
      });
    });

    test('de LOSS não é permitido', () => {
      const loss = processed(wager('LOSS', '0', { externalTransactionId: 'bet-1' }));
      expect(decide(wager('ROLLBACK', '1.00', withRef), walletWith('0'), ref(loss))).toEqual({
        status: 'REJECTED', failureCode: FailureCode.REFERENCE_INVALID_KIND,
      });
    });
  });

  describe('Referência precisa bater', () => {
    test.each([
      ['jogador', { playerId: 'outro' }],
      ['provider', { providerId: 'outro' }],
      ['rodada', { roundId: 'r-2' }],
      ['carteira', { walletId: 'outra' }],
    ])('de outro(a) %s → REFERENCE_MISMATCH', (_, diff) => {
      const bet = processed(wager('BET', '5.00', { externalTransactionId: 'bet-1', ...diff }));
      expect(decide(wager('REFUND', '5.00', withRef), walletWith('0'), ref(bet))).toEqual({
        status: 'REJECTED', failureCode: FailureCode.REFERENCE_MISMATCH,
      });
    });

    test('referência que existe mas ainda não foi decidida → aguardar (PENDING_REFERENCE)', () => {
      const pendingWin = wager('WIN', '5.00', { externalTransactionId: 'bet-1', referenceExternalTransactionId: 'b0' });
      pendingWin.markPendingReference();
      expect(decide(wager('ROLLBACK', '5.00', withRef), walletWith('0'), ref(pendingWin)).status).toBe('PENDING_REFERENCE');
    });
  });

  test('conflito de moeda entre transação e carteira → CURRENCY_MISMATCH', () => {
    const w = walletWith('10.00');
    const tx = wager('BET', '1.00');
    Object.defineProperty(tx, 'money', { value: { ...brl('1.00'), currency: { code: 'USD', scale: 2, equals: () => false } } });
    expect(decide(tx, w)).toEqual({ status: 'REJECTED', failureCode: FailureCode.CURRENCY_MISMATCH });
  });
});
