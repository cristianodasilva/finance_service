/**
 * Falha TEMPORÁRIA de infraestrutura (ex.: muitos conflitos seguidos, banco fora).
 * Diferente de um DomainError: aqui TENTAR DE NOVO mais tarde pode funcionar.
 * Na API vira HTTP 503; na fila, a mensagem volta para ser reprocessada.
 */
export class TransientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TransientError';
  }
}
