import { newId } from '../common/ids';

/**
 * "Envelope" de todo evento publicado pelo serviço.
 *
 * Analogia: o envelope de uma carta. Todos têm os mesmos campos por fora
 * (id, tipo, data, remetente...), e o conteúdo (payload) muda conforme o tipo.
 *
 * É uma classe ABSTRATA: não se cria um DomainEvent "genérico".
 * Cada evento concreto (ex.: WalletBalanceChanged) é uma subclasse com o seu payload.
 */
export abstract class DomainEvent<TPayload extends object = object> {
  /** Id único do evento. Quem consome usa para ignorar duplicatas. */
  readonly eventId: string = newId();
  /** Versão do formato do evento (para evoluir o contrato no futuro). */
  readonly eventVersion: number = 1;
  readonly occurredAt: Date;

  /** Nome do evento, ex.: 'WalletBalanceChanged'. Cada subclasse define o seu. */
  abstract readonly eventType: string;
  /** Tipo da "entidade dona" do evento, ex.: 'Wallet' ou 'WagerTransaction'. */
  abstract readonly aggregateType: string;

  protected constructor(
    /** Id da entidade dona do evento (ex.: id da carteira). */
    readonly aggregateId: string,
    readonly payload: TPayload,
    occurredAt?: Date,
  ) {
    this.occurredAt = occurredAt ?? new Date();
  }

  /** Formato final que vai para a fila (JSON). */
  toEnvelope(): Record<string, unknown> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      eventVersion: this.eventVersion,
      aggregateType: this.aggregateType,
      aggregateId: this.aggregateId,
      occurredAt: this.occurredAt.toISOString(),
      payload: this.payload,
    };
  }
}
