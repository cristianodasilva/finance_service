import type { IntegrationEvent } from '../events/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
  publishedAt: Date | null;
}

/** Espera entre tentativas de publicação: 2s, 4s, 8s... no máximo 5 minutos. */
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 5 * 60_000;

/**
 * Evento esperando para ser publicado (padrão Transactional Outbox).
 * Gravado na MESMA transação da mudança de saldo; publicado depois por um worker.
 */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | null,
    private _publishedAt: Date | null,
  ) {}

  /** O id da mensagem é o eventId: quem consome usa o mesmo id para descartar repetições. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const json = event.toJSON() as unknown as Record<string, unknown>;
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, json, event.occurredAt, 0, event.occurredAt, null);
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(s.id, s.aggregateId, s.eventType, s.payload, s.occurredAt, s.attempts, s.nextAttemptAt, s.publishedAt);
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | null {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | null {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === null;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === null || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    this._attempts += 1;
    this._publishedAt = at;
  }

  /** Falhou: conta a tentativa e agenda a próxima com espera exponencial. */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delay = Math.min(BASE_DELAY_MS * 2 ** (this._attempts - 1), MAX_DELAY_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
