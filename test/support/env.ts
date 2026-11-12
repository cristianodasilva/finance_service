/**
 * Carregado ANTES de todos os testes (ver bunfig.toml).
 *
 * Os testes usam FILAS PRÓPRIAS (sufixo -test), para não disputar mensagens com as
 * instâncias da aplicação que podem estar rodando no docker compose ao mesmo tempo.
 * (O banco de testes também é separado: finance_test — ver database.ts.)
 */
import { CreateQueueCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const base = `${endpoint}/000000000000`;
process.env.SQS_WAGER_QUEUE_URL = `${base}/wager-transactions-test.fifo`;
process.env.SQS_WAGER_DLQ_URL = `${base}/wager-transactions-dlq-test.fifo`;
process.env.SQS_EVENTS_QUEUE_URL = `${base}/wager-events-test.fifo`;

// Importado só depois de ajustar as variáveis, para o config já ler os valores de teste.
const { createSqsClient } = await import('../../src/messaging/sqs.client');
const sqs = createSqsClient();
const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };

const dlq = await sqs.send(new CreateQueueCommand({ QueueName: 'wager-transactions-dlq-test.fifo', Attributes: fifo }));
const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl!, AttributeNames: ['QueueArn'] }));
await sqs.send(
  new CreateQueueCommand({
    QueueName: 'wager-transactions-test.fifo',
    Attributes: {
      ...fifo,
      VisibilityTimeout: '30',
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes!.QueueArn, maxReceiveCount: '5' }),
    },
  }),
);
await sqs.send(new CreateQueueCommand({ QueueName: 'wager-events-test.fifo', Attributes: fifo }));
