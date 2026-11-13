/**
 * Envia uma transação para a fila SQS no formato do contrato (simula o provedor de jogos).
 *
 * Uso:
 *   bun scripts/send-wager.ts '<json do data>'
 * Exemplo:
 *   bun scripts/send-wager.ts '{"providerId":"provider-a","externalTransactionId":"bet-1","playerId":"p1","walletId":"...","roundId":"r1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"10.00","currency":"BRL"}}'
 *
 * O envelope ({ messageId, type, occurredAt, data }) e a idempotencyKey padrão
 * ("{providerId}:{externalTransactionId}") são preenchidos automaticamente.
 */
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { config } from '../src/config';
import { createSqsClient } from '../src/messaging/sqs.client';

const raw = process.argv[2];
if (!raw) {
  console.error("Usage: bun scripts/send-wager.ts '<json data>'");
  process.exit(1);
}
const data = JSON.parse(raw);
data.idempotencyKey ??= `${data.providerId}:${data.externalTransactionId}`;
const messageId = `msg-${crypto.randomUUID()}`;
const body = JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data });

await createSqsClient().send(
  new SendMessageCommand({
    QueueUrl: config.sqs.wagerQueueUrl,
    MessageBody: body,
    MessageGroupId: data.walletId ?? 'default', // mesma carteira → em ordem
    MessageDeduplicationId: messageId,
  }),
);
console.log(`Sent ${messageId}`);
