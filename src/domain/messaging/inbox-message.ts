/**
 * Registro de uma mensagem recebida da fila. A chave é (consumerName, messageId):
 * se a mesma mensagem chegar de novo, sabemos que já foi processada.
 * É gravado NA MESMA transação SQL da alteração financeira.
 */
export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | null;
}

export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private _processedAt: Date | null,
  ) {}

  static receive(props: { messageId: string; consumerName: string; payloadHash: string; at?: Date }): InboxMessage {
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.at ?? new Date(), null);
  }

  static rehydrate(s: InboxMessageState): InboxMessage {
    return new InboxMessage(s.messageId, s.consumerName, s.payloadHash, s.receivedAt, s.processedAt);
  }

  get processedAt(): Date | null {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== null;
  }

  markProcessed(at: Date): void {
    if (this._processedAt === null) this._processedAt = at;
  }
}
