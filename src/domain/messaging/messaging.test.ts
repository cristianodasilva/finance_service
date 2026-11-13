import { describe, expect, test } from 'bun:test';
import { InboxMessage } from './inbox-message';
import { OutboxMessage } from './outbox-message';

describe('InboxMessage', () => {
  test('receive → não processada; markProcessed registra o momento', () => {
    const m = InboxMessage.receive({ messageId: 'm1', consumerName: 'c', payloadHash: 'h' });
    expect(m.isProcessed()).toBe(false);
    const at = new Date();
    m.markProcessed(at);
    expect(m.isProcessed()).toBe(true);
    expect(m.processedAt).toBe(at);
  });
});

describe('OutboxMessage', () => {
  const state = { id: 'o1', aggregateId: 'a', eventType: 'X', payload: {}, occurredAt: new Date(0), attempts: 0, nextAttemptAt: null, publishedAt: null };

  test('scheduleRetry: espera exponencial (2s, 4s, 8s...)', () => {
    const m = OutboxMessage.rehydrate(state);
    const now = new Date(1_000_000);
    m.scheduleRetry(now);
    expect(m.attempts).toBe(1);
    expect(m.nextAttemptAt!.getTime() - now.getTime()).toBe(2_000);
    m.scheduleRetry(now);
    expect(m.nextAttemptAt!.getTime() - now.getTime()).toBe(4_000);
    expect(m.isDue(now)).toBe(false);
    expect(m.isDue(new Date(now.getTime() + 4_000))).toBe(true);
  });

  test('markPublished: deixa de estar pendente', () => {
    const m = OutboxMessage.rehydrate(state);
    m.markPublished(new Date());
    expect(m.isPending()).toBe(false);
    expect(m.isDue(new Date())).toBe(false);
  });
});
