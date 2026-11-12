/**
 * Envia uma transação para a fila SQS (simula o provedor de jogos).
 *
 * Uso:
 *   bun scripts/send-wager.ts '<json da transação>'
 * Exemplo:
 *   bun scripts/send-wager.ts '{"provider":"prov","providerTransactionId":"bet-1","kind":"BET","playerId":"p1","walletId":"...","currency":"BRL","amount":"10.00"}'
 */
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { config } from '../src/config';
import { createSqsClient } from '../src/messaging/sqs.client';

const body = process.argv[2];
if (!body) {
  console.error('Usage: bun scripts/send-wager.ts \'<json>\'');
  process.exit(1);
}
const parsed = JSON.parse(body);
const result = await createSqsClient().send(
  new SendMessageCommand({
    QueueUrl: config.sqs.wagerQueueUrl,
    MessageBody: body,
    // Mesmo grupo = mesma carteira → mensagens dessa carteira chegam em ordem.
    MessageGroupId: parsed.walletId ?? 'default',
    // Evita duplicatas no envio (janela de 5 minutos do SQS FIFO).
    MessageDeduplicationId: `${parsed.provider}:${parsed.providerTransactionId}`,
  }),
);
console.log(`Sent message ${result.MessageId}`);
