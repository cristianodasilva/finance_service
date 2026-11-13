import { randomUUID } from 'node:crypto';

/** De onde veio o evento: para rastrear a cadeia de causas entre sistemas. */
export interface EventContext {
  /** Id que acompanha toda a operação (ex.: X-Correlation-Id do HTTP, messageId da fila). */
  correlationId: string;
  /** Id da mensagem/comando que CAUSOU este evento (ex.: a Idempotency-Key). */
  causationId?: string;
  occurredAt?: Date;
}

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/**
 * Envelope de todo evento publicado. Classe ABSTRATA: cada evento é uma subclasse
 * que define `eventType` e `version` no próprio tipo (nunca uma string solta no código).
 * `data` carrega só valores JSON (MoneyProps em texto, nunca instâncias de Money).
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze(props.data);
  }

  /** Monta as props comuns a partir do contexto. */
  protected static props<D>(aggregateId: string, data: D, ctx: EventContext): IntegrationEventProps<D> {
    return {
      eventId: randomUUID(),
      aggregateId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt ?? new Date(),
      data,
    };
  }

  /** Envelope serializado, gravado no payload da outbox. */
  toJSON(): {
    eventId: string;
    eventType: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: string;
    version: number;
    data: T;
  } {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}
