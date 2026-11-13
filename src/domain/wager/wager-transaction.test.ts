import { describe, expect, test } from 'bun:test';
import { processed, wager } from '../../../test/support/domain-builders';
import { DomainError, FailureCode, InvalidTransactionStateError } from '../errors';

describe('WagerTransaction', () => {
  test('nasce PENDING', () => {
    expect(wager('BET', '10.00').status).toBe('PENDING');
  });

  test('REFUND e ROLLBACK exigem referência; WIN e LOSS não', () => {
    expect(() => wager('REFUND', '10.00')).toThrow(DomainError);
    expect(() => wager('ROLLBACK', '10.00')).toThrow(DomainError);
    expect(wager('WIN', '10.00').requiresReference()).toBe(false);
    expect(wager('LOSS', '0').requiresReference()).toBe(false);
  });

  test('OPENING não pode ser criado como transação do provedor', () => {
    expect(() => wager('OPENING', '10.00')).toThrow(DomainError);
  });

  test('valor zero só em LOSS', () => {
    expect(() => wager('BET', '0')).toThrow(DomainError);
    expect(wager('LOSS', '0').affectsBalance()).toBe(false);
  });

  test('transições válidas a partir de PENDING e PENDING_REFERENCE', () => {
    const tx = wager('WIN', '5.00', { referenceExternalTransactionId: 'bet-x' });
    tx.markPendingReference();
    expect(tx.status).toBe('PENDING_REFERENCE');
    tx.markPendingReference(); // continua aguardando
    tx.markProcessed('ref-id', new Date());
    expect(tx.status).toBe('PROCESSED');
    expect(tx.referenceTransactionId).toBe('ref-id');
    expect(tx.isTerminal()).toBe(true);
  });

  test.each(['markProcessed', 'markPendingReference', 'reject', 'fail'] as const)(
    'estado final + %s → InvalidTransactionStateError (erro de programação)',
    (action) => {
      const tx = wager('BET', '1.00');
      tx.reject(FailureCode.INSUFFICIENT_FUNDS);
      const call = {
        markProcessed: () => tx.markProcessed(undefined, new Date()),
        markPendingReference: () => tx.markPendingReference(),
        reject: () => tx.reject(FailureCode.INSUFFICIENT_FUNDS),
        fail: () => tx.fail('X'),
      }[action];
      expect(call).toThrow(InvalidTransactionStateError);
    },
  );

  test('matchesPayload: mesma chave com payload divergente não é replay', () => {
    const tx = wager('BET', '1.00', { payloadHash: 'sha256:aaa' });
    expect(tx.matchesPayload('sha256:aaa')).toBe(true);
    expect(tx.matchesPayload('sha256:bbb')).toBe(false);
  });

  test('ledgerDirectionFor: ROLLBACK faz o movimento inverso da referência', () => {
    const bet = processed(wager('BET', '1.00'));
    const win = processed(wager('WIN', '1.00'));
    const rollback = wager('ROLLBACK', '1.00', { referenceExternalTransactionId: 'x' });
    expect(bet.ledgerDirectionFor()).toBe('DEBIT');
    expect(win.ledgerDirectionFor()).toBe('CREDIT');
    expect(rollback.ledgerDirectionFor(bet)).toBe('CREDIT');
    expect(rollback.ledgerDirectionFor(win)).toBe('DEBIT');
  });
});
