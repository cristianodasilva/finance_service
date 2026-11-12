import { describe, expect, test } from 'bun:test';
import { FailureCode } from '../errors';
import { Currency } from '../money/currency';
import { Money } from '../money/money';
import { Wallet } from '../wallet/wallet';
import type { WagerKind } from './wager-kind';
import { decideWager, type ReferenceSnapshot, type WagerCommand } from './wager-rules';

const brl = (v: string) => Money.fromDecimal(v, Currency.BRL);

function walletWith(balance: string): Wallet {
  const w = Wallet.open({ id: 'w-1', playerId: 'p-1', currency: Currency.BRL });
  if (brl(balance).isPositive()) w.credit(brl(balance));
  return w;
}

function cmd(kind: WagerKind, amount: string, extra: Partial<WagerCommand> = {}): WagerCommand {
  return {
    provider: 'prov',
    providerTransactionId: `${kind}-1`,
    kind,
    playerId: 'p-1',
    walletId: 'w-1',
    amount: brl(amount),
    roundId: 'r-1',
    referenceProviderTransactionId: kind === 'BET' ? null : 'BET-1',
    ...extra,
  };
}

function ref(kind: WagerKind, amount: string, extra: Partial<ReferenceSnapshot> = {}): ReferenceSnapshot {
  return {
    id: 'ref-id',
    provider: 'prov',
    kind,
    status: 'PROCESSED',
    playerId: 'p-1',
    walletId: 'w-1',
    amount: brl(amount),
    roundId: 'r-1',
    rolledBack: false,
    refunded: false,
    ...extra,
  };
}

describe('decideWager', () => {
  describe('BET', () => {
    test('debita quando há saldo', () => {
      const w = walletWith('100.00');
      const d = decideWager({ command: cmd('BET', '80.00'), wallet: w, reference: undefined });
      expect(d.status).toBe('PROCESSED');
      expect(w.balance.toDecimal()).toBe('20.00');
    });

    test('rejeita com INSUFFICIENT_FUNDS e não altera a carteira', () => {
      const w = walletWith('20.00');
      const d = decideWager({ command: cmd('BET', '80.00'), wallet: w, reference: undefined });
      expect(d).toEqual({ status: 'REJECTED', failureCode: FailureCode.INSUFFICIENT_FUNDS });
      expect(w.balance.toDecimal()).toBe('20.00');
      expect(w.version).toBe(1);
    });

    test('rejeita carteira de outro jogador', () => {
      const d = decideWager({ command: cmd('BET', '1.00', { playerId: 'outro' }), wallet: walletWith('10.00'), reference: undefined });
      expect(d).toEqual({ status: 'REJECTED', failureCode: FailureCode.PLAYER_MISMATCH });
    });
  });

  describe('WIN / LOSS / REFUND', () => {
    test('WIN credita', () => {
      const w = walletWith('20.00');
      const d = decideWager({ command: cmd('WIN', '50.00'), wallet: w, reference: ref('BET', '80.00') });
      expect(d.status).toBe('PROCESSED');
      expect(w.balance.toDecimal()).toBe('70.00');
    });

    test('LOSS não move saldo nem versão', () => {
      const w = walletWith('20.00');
      const d = decideWager({ command: cmd('LOSS', '0.00'), wallet: w, reference: ref('BET', '80.00') });
      expect(d).toEqual({ status: 'PROCESSED', movement: null });
      expect(w.version).toBe(1);
    });

    test('referência ausente → PENDING_REFERENCE', () => {
      const d = decideWager({ command: cmd('WIN', '50.00'), wallet: walletWith('0'), reference: null });
      expect(d.status).toBe('PENDING_REFERENCE');
    });

    test.each([
      ['jogador', { playerId: 'outro' }],
      ['carteira', { walletId: 'outra' }],
      ['provedor', { provider: 'outro' }],
      ['rodada', { roundId: 'r-2' }],
    ])('referência de outro(a) %s → REFERENCE_MISMATCH', (_, diff) => {
      const d = decideWager({ command: cmd('WIN', '5.00'), wallet: walletWith('0'), reference: ref('BET', '5.00', diff) });
      expect(d).toEqual({ status: 'REJECTED', failureCode: FailureCode.REFERENCE_MISMATCH });
    });

    test('WIN apontando para outro WIN → REFERENCE_INVALID_KIND', () => {
      const d = decideWager({ command: cmd('WIN', '5.00'), wallet: walletWith('0'), reference: ref('WIN', '5.00') });
      expect(d).toEqual({ status: 'REJECTED', failureCode: FailureCode.REFERENCE_INVALID_KIND });
    });

    test('WIN sobre aposta rejeitada → REFERENCE_NOT_PROCESSED', () => {
      const d = decideWager({ command: cmd('WIN', '5.00'), wallet: walletWith('0'), reference: ref('BET', '5.00', { status: 'REJECTED' }) });
      expect(d).toEqual({ status: 'REJECTED', failureCode: FailureCode.REFERENCE_NOT_PROCESSED });
    });

    test('REFUND maior que a aposta → REFUND_EXCEEDS_BET', () => {
      const d = decideWager({ command: cmd('REFUND', '90.00'), wallet: walletWith('0'), reference: ref('BET', '80.00') });
      expect(d).toEqual({ status: 'REJECTED', failureCode: FailureCode.REFUND_EXCEEDS_BET });
    });

    test('segundo REFUND da mesma aposta → ALREADY_REFUNDED', () => {
      const d = decideWager({ command: cmd('REFUND', '80.00'), wallet: walletWith('0'), reference: ref('BET', '80.00', { refunded: true }) });
      expect(d).toEqual({ status: 'REJECTED', failureCode: FailureCode.ALREADY_REFUNDED });
    });
  });

  describe('ROLLBACK', () => {
    test('de BET devolve o valor apostado', () => {
      const w = walletWith('20.00');
      const d = decideWager({ command: cmd('ROLLBACK', '80.00'), wallet: w, reference: ref('BET', '80.00') });
      expect(d).toEqual({ status: 'PROCESSED', movement: { direction: 'CREDIT', amount: brl('80.00') } });
      expect(w.balance.toDecimal()).toBe('100.00');
    });

    test('de WIN retira o prêmio', () => {
      const w = walletWith('70.00');
      decideWager({ command: cmd('ROLLBACK', '50.00', { referenceProviderTransactionId: 'WIN-1' }), wallet: w, reference: ref('WIN', '50.00') });
      expect(w.balance.toDecimal()).toBe('20.00');
    });

    test('de WIN já gasto → REVERSAL_WOULD_OVERDRAW (diferente de INSUFFICIENT_FUNDS)', () => {
      const w = walletWith('10.00');
      const d = decideWager({ command: cmd('ROLLBACK', '50.00'), wallet: w, reference: ref('WIN', '50.00') });
      expect(d).toEqual({ status: 'REJECTED', failureCode: FailureCode.REVERSAL_WOULD_OVERDRAW });
      expect(w.balance.toDecimal()).toBe('10.00');
    });

    test('com valor diferente do original → ROLLBACK_AMOUNT_MISMATCH', () => {
      const d = decideWager({ command: cmd('ROLLBACK', '79.99'), wallet: walletWith('0'), reference: ref('BET', '80.00') });
      expect(d).toEqual({ status: 'REJECTED', failureCode: FailureCode.ROLLBACK_AMOUNT_MISMATCH });
    });

    test('segunda vez → ALREADY_ROLLED_BACK', () => {
      const d = decideWager({ command: cmd('ROLLBACK', '80.00'), wallet: walletWith('0'), reference: ref('BET', '80.00', { rolledBack: true }) });
      expect(d).toEqual({ status: 'REJECTED', failureCode: FailureCode.ALREADY_ROLLED_BACK });
    });

    test('de LOSS não é permitido → REFERENCE_INVALID_KIND', () => {
      const d = decideWager({ command: cmd('ROLLBACK', '0.00'), wallet: walletWith('0'), reference: ref('LOSS', '0.00') });
      expect(d).toEqual({ status: 'REJECTED', failureCode: FailureCode.REFERENCE_INVALID_KIND });
    });
  });
});
