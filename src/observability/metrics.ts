import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * MÉTRICAS no formato Prometheus, expostas em GET /metrics.
 *
 * Tipos usados:
 *  - Counter:   só aumenta (ex.: total de transações processadas).
 *  - Gauge:     sobe e desce (ex.: quantos eventos estão esperando na outbox agora).
 *  - Histogram: distribuição de tempos (ex.: quanto demora processar uma transação).
 *
 * "labels" são dimensões para filtrar: ex.: wager_transactions_total{kind="BET",status="REJECTED"}.
 */
export const registry = new Registry();
collectDefaultMetrics({ register: registry }); // CPU, memória, etc. do processo

export const metrics = {
  transactions: new Counter({
    name: 'wager_transactions_total',
    help: 'Transações de aposta por tipo, status final e origem',
    labelNames: ['kind', 'status', 'source'] as const,
    registers: [registry],
  }),
  failures: new Counter({
    name: 'wager_rejections_total',
    help: 'Transações rejeitadas por código de falha',
    labelNames: ['failure_code'] as const,
    registers: [registry],
  }),
  duplicates: new Counter({
    name: 'wager_duplicates_total',
    help: 'Pedidos repetidos (idempotência/inbox/id do provedor) que devolveram o resultado anterior',
    labelNames: ['source'] as const,
    registers: [registry],
  }),
  concurrencyConflicts: new Counter({
    name: 'wallet_concurrency_conflicts_total',
    help: 'Conflitos de concorrência (versão da carteira mudou) que causaram nova tentativa',
    registers: [registry],
  }),
  processingDuration: new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Tempo para processar uma transação de aposta (inclui novas tentativas)',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  }),
  sqsMessages: new Counter({
    name: 'sqs_messages_total',
    help: 'Mensagens da fila de transações por resultado',
    labelNames: ['outcome'] as const, // processed | duplicate | dead_lettered | retried
    registers: [registry],
  }),
  deadLettered: new Counter({
    name: 'sqs_dead_lettered_total',
    help: 'Mensagens enviadas para a DLQ por motivo',
    labelNames: ['reason'] as const,
    registers: [registry],
  }),
  pendingReferenceRetries: new Counter({
    name: 'pending_reference_retries_total',
    help: 'Novas tentativas de transações PENDING_REFERENCE por resultado',
    labelNames: ['result'] as const,
    registers: [registry],
  }),
  outboxPublished: new Counter({
    name: 'outbox_published_total',
    help: 'Eventos publicados a partir da outbox',
    labelNames: ['event_type'] as const,
    registers: [registry],
  }),
  outboxPublishFailures: new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Falhas ao publicar eventos da outbox',
    registers: [registry],
  }),
  outboxPending: new Gauge({
    name: 'outbox_pending_events',
    help: 'Eventos na outbox ainda não publicados',
    registers: [registry],
  }),
  outboxLag: new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Idade (em segundos) do evento mais antigo ainda não publicado',
    registers: [registry],
  }),
  reconciliationDivergences: new Counter({
    name: 'reconciliation_divergences_total',
    help: 'Divergências encontradas entre saldo e extrato',
    registers: [registry],
  }),
};
