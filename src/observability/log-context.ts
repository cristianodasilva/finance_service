import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Campos de CORRELAÇÃO: identificam "de qual pedido" é cada linha de log.
 *
 * Com eles dá para filtrar todos os logs de uma mesma requisição/mensagem,
 * mesmo com milhares acontecendo ao mesmo tempo em várias instâncias.
 */
export interface LogContext {
  correlationId: string;
  messageId?: string;
  walletId?: string;
  providerTransactionId?: string;
  transactionId?: string;
}

/**
 * AsyncLocalStorage: uma "mochila" que acompanha o fluxo de execução.
 * Tudo o que roda a partir de `runWithLogContext(...)` — inclusive código assíncrono
 * (await, callbacks) — enxerga o mesmo contexto, sem precisar passá-lo como parâmetro.
 */
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
