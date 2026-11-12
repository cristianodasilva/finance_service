/**
 * Configurações lidas das variáveis de ambiente (arquivo .env ou docker compose).
 * Centralizar aqui evita espalhar `process.env.ALGUMA_COISA` pelo código.
 */
function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

export const config = {
  port: Number(process.env.PORT ?? 3000),

  aws: {
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  },

  sqs: {
    wagerQueueUrl:
      process.env.SQS_WAGER_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-transactions.fifo',
    wagerDlqUrl:
      process.env.SQS_WAGER_DLQ_URL ?? 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
    /** Fila onde a outbox publica os eventos (WagerTransactionProcessed, etc.). */
    eventsQueueUrl: process.env.SQS_EVENTS_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-events.fifo',
    /** Liga/desliga o consumidor da fila nesta instância. */
    consumerEnabled: bool(process.env.SQS_CONSUMER_ENABLED, true),
    /** Quanto tempo cada "pergunta" à fila espera por mensagens (long polling). */
    waitTimeSeconds: Number(process.env.SQS_WAIT_TIME_SECONDS ?? 10),
  },

  outbox: {
    publisherEnabled: bool(process.env.OUTBOX_PUBLISHER_ENABLED, true),
    /** De quanto em quanto tempo procura eventos novos (ms). */
    pollIntervalMs: Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 500),
    batchSize: Number(process.env.OUTBOX_BATCH_SIZE ?? 50),
  },

  pendingReference: {
    workerEnabled: bool(process.env.PENDING_REFERENCE_WORKER_ENABLED, true),
    pollIntervalMs: Number(process.env.PENDING_REFERENCE_POLL_INTERVAL_MS ?? 1_000),
    /** Depois de quantas tentativas sem a referência chegar a transação é rejeitada. */
    maxAttempts: Number(process.env.PENDING_REFERENCE_MAX_ATTEMPTS ?? 6),
  },
};
