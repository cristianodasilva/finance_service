/**
 * Carregado ANTES de todos os testes (ver bunfig.toml). Só ajusta variáveis de ambiente:
 * os testes usam FILAS e BANCO próprios, para não disputar mensagens/dados com as
 * instâncias que podem estar rodando no docker compose.
 *
 * Não conecta em nada: testes unitários rodam sem infraestrutura.
 * (As filas de teste são criadas por `ensureTestQueues`, chamado pelos testes de integração.)
 */
const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const base = `${endpoint}/000000000000`;
process.env.SQS_WAGER_QUEUE_URL = `${base}/wager-transactions-test.fifo`;
process.env.SQS_WAGER_DLQ_URL = `${base}/wager-transactions-dlq-test.fifo`;
process.env.SQS_EVENTS_QUEUE_URL = `${base}/wager-events-test.fifo`;
// Nos testes, poucas tentativas antes da DLQ (o teste de retry → DLQ fica rápido).
process.env.SQS_TEST_MAX_RECEIVE_COUNT = '2';
