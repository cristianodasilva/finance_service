import { DeleteMessageCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { config } from '../../src/config';

export interface PublishedEvent {
  eventId: string;
  eventType: string;
  aggregateId: string;
  data: Record<string, unknown>;
}

/**
 * Lê (e apaga) da fila de eventos os eventos cujo `aggregateId` ou `data.walletId`
 * pertence a este teste. Sem PurgeQueue: filtramos pelo que o teste criou.
 */
export async function drainEvents(sqs: SQSClient, belongs: (e: PublishedEvent) => boolean): Promise<PublishedEvent[]> {
  const events: PublishedEvent[] = [];
  for (let empty = 0; empty < 2; ) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: config.sqs.eventsQueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }),
    );
    empty = Messages.length === 0 ? empty + 1 : 0;
    for (const m of Messages) {
      const e = JSON.parse(m.Body!) as PublishedEvent;
      if (belongs(e)) events.push(e);
      await sqs.send(new DeleteMessageCommand({ QueueUrl: config.sqs.eventsQueueUrl, ReceiptHandle: m.ReceiptHandle! }));
    }
  }
  return events;
}
