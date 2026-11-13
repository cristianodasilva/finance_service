import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Campos de CORRELAÇÃO dos logs: identificam a qual pedido pertence cada linha,
 * mesmo com milhares acontecendo ao mesmo tempo em várias instâncias.
 */
export interface LogContext {
  correlationId: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

/** "Mochila" que acompanha o fluxo de execução, inclusive através de `await`. */
const storage = new AsyncLocalStorage<LogContext>();

export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentLogContext(): LogContext | undefined {
  return storage.getStore();
}

/** Acrescenta campos ao contexto atual (ex.: quando descobrimos o walletId). */
export function enrichLogContext(fields: Partial<LogContext>): void {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}
