import { CreateQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../../src/messaging/sqs.client';

let ready: Promise<void> | null = null;

/** Cria (uma vez por execução) as filas de teste: principal com redrive para a DLQ, e a de eventos. */
export function ensureTestQueues(): Promise<void> {
  ready ??= (async () => {
    const sqs = createSqsClient();
    const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
    const dlq = await sqs.send(new CreateQueueCommand({ QueueName: 'wager-transactions-dlq-test.fifo', Attributes: fifo }));
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl!, AttributeNames: ['QueueArn'] }),
    );
    const main = await sqs.send(new CreateQueueCommand({ QueueName: 'wager-transactions-test.fifo', Attributes: fifo }));
    await sqs.send(
      new SetQueueAttributesCommand({
        QueueUrl: main.QueueUrl!,
        Attributes: {
          VisibilityTimeout: '5', // curto nos testes: mensagem de processo morto volta em 5 s
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: Attributes!.QueueArn,
            maxReceiveCount: process.env.SQS_TEST_MAX_RECEIVE_COUNT ?? '2',
          }),
        },
      }),
    );
    await sqs.send(new CreateQueueCommand({ QueueName: 'wager-events-test.fifo', Attributes: fifo }));
  })();
  return ready;
}
