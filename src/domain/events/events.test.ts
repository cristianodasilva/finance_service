import { describe, expect, test } from 'bun:test';
import { brl, processed, wager, walletWith } from '../../../test/support/domain-builders';
import { OutboxMessage } from '../messaging/outbox-message';
import { WagerTransactionProcessed, WalletBalanceChanged } from './events';

describe('Eventos de integração', () => {
  test('WalletBalanceChanged.from: envelope + data com MoneyProps (texto), nunca Money', () => {
    const w = walletWith('100.00');
    const entry = w.debit(brl('25.00'), { transactionId: 'tx-1', entryId: 'e-1', at: new Date('2026-01-01T00:00:00Z') });
    const json = WalletBalanceChanged.from(w, entry, { correlationId: 'corr-1', causationId: 'key-1' }).toJSON();
    expect(json).toMatchObject({
      eventType: 'WalletBalanceChanged',
      version: 1,
      aggregateId: w.id,
      correlationId: 'corr-1',
      causationId: 'key-1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      data: {
        walletId: w.id,
        transactionId: 'tx-1',
        direction: 'DEBIT',
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    // JSON estável: serializar e ler de volta dá o mesmo objeto
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('OutboxMessage.enqueue usa o eventId como id e guarda o envelope', () => {
    const w = walletWith('1.00');
    const event = WagerTransactionProcessed.from(processed(wager('LOSS', '0')), w, { correlationId: 'c' });
    const msg = OutboxMessage.enqueue(event);
    expect(msg.id).toBe(event.eventId);
    expect(msg.eventType).toBe('WagerTransactionProcessed');
    expect(msg.payload).toMatchObject({ eventType: 'WagerTransactionProcessed', version: 1 });
    expect(msg.isPending()).toBe(true);
  });
});
