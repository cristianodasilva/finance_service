import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PurgeQueueCommand, ReceiveMessageCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { config } from '../../src/config';
import { createSqsClient } from '../../src/messaging/sqs.client';
import { WagerQueueConsumer } from '../../src/messaging/wager-queue.consumer';
import { ProcessWagerService } from '../../src/wagering/process-wager.service';
import { WalletsService } from '../../src/wallets/wallets.service';
import { createInstances, resetDatabase } from '../support/database';

/**
 * Testes do consumidor contra o SQS do MiniStack e o PostgreSQL reais.
 */
let orm: MikroORM;
let sqs: SQSClient;
let consumer: WagerQueueConsumer;
let wallets: WalletsService;

beforeAll(async () => {
  [orm] = (await createInstances(1)) as [MikroORM];
  sqs = createSqsClient();
  consumer = new WagerQueueConsumer(sqs, new ProcessWagerService(orm.em));
  wallets = new WalletsService(orm.em);
});
afterAll(async () => {
  await orm.close();
});
beforeEach(async () => {
  await resetDatabase(orm);
  await sqs.send(new PurgeQueueCommand({ QueueUrl: config.sqs.wagerQueueUrl })).catch(() => undefined);
  await sqs.send(new PurgeQueueCommand({ QueueUrl: config.sqs.wagerDlqUrl })).catch(() => undefined);
});

/**
 * O SQS FIFO descarta mensagens com o mesmo MessageDeduplicationId por 5 minutos.
 * Por isso cada execução dos testes usa um prefixo único (senão, rodar de novo
 * em menos de 5 minutos faria as mensagens "sumirem").
 */
const RUN_ID = crypto.randomUUID();

async function send(body: unknown, dedupId: string): Promise<string> {
  const r = await sqs.send(
    new SendMessageCommand({
      QueueUrl: config.sqs.wagerQueueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: 'group-1',
      MessageDeduplicationId: `${RUN_ID}:${dedupId}`,
    }),
  );
  return r.MessageId!;
}

/** Roda o consumidor até a fila esvaziar. */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    if ((await consumer.pollOnce(0)) === 0) return;
  }
}

async function balanceOf(walletId: string): Promise<string> {
  const [row] = await orm.em.fork().execute(`select balance from wallets where id = ?`, [walletId]);
  return row!.balance;
}

async function countRows(table: string): Promise<number> {
  const [row] = await orm.em.fork().execute(`select count(*)::int as n from ${table}`);
  return row!.n;
}

async function dlqMessages() {
  const r = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl: config.sqs.wagerDlqUrl, MaxNumberOfMessages: 10, MessageAttributeNames: ['All'] }),
  );
  return r.Messages ?? [];
}

const betBody = (walletId: string, id: string, amount: string) => ({
  provider: 'prov',
  providerTransactionId: id,
  kind: 'BET',
  playerId: 'player-1',
  walletId,
  currency: 'BRL',
  amount,
  roundId: 'r1',
});

describe('Consumidor SQS', () => {
  test('processa BETs em ordem e confirma (apaga) as mensagens', async () => {
    const w = await wallets.create({ playerId: 'player-1', currency: 'BRL', initialBalance: '100.00' });
    await send(betBody(w.id, 'bet-1', '80.00'), 'd1');
    await send(betBody(w.id, 'bet-2', '80.00'), 'd2'); // a segunda deve ser recusada

    await drain();

    expect(await balanceOf(w.id)).toBe('20.00');
    const [rejected] = await orm.em
      .fork()
      .execute(`select status, failure_code from wager_transactions where provider_transaction_id = 'bet-2'`);
    expect(rejected).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await consumer.pollOnce(0)).toBe(0); // fila vazia: tudo confirmado
    expect(await countRows('inbox_messages')).toBe(2);
  });

  test('a mesma transação enviada duas vezes (ids de mensagem diferentes) é aplicada uma vez', async () => {
    const w = await wallets.create({ playerId: 'player-1', currency: 'BRL', initialBalance: '100.00' });
    await send(betBody(w.id, 'bet-1', '30.00'), 'd1');
    await send(betBody(w.id, 'bet-1', '30.00'), 'd1-again'); // outro dedupId → o SQS entrega de novo

    await drain();

    expect(await balanceOf(w.id)).toBe('70.00');
    expect(await countRows('wager_transactions where kind = \'BET\'')).toBe(1);
  });

  test('erro permanente (JSON inválido / carteira inexistente) vai para a DLQ com o motivo', async () => {
    await send('isto não é json', 'bad-json');
    await send(betBody('01a1d0f8-abcf-74e2-ba9a-8aa61550f864', 'bet-x', '10.00'), 'no-wallet');

    await drain();

    const dlq = await dlqMessages();
    const codes = dlq.map((m) => m.MessageAttributes?.failureCode?.StringValue).sort();
    expect(codes).toEqual(['INVALID_JSON', 'WALLET_NOT_FOUND']);
    expect(await consumer.pollOnce(0)).toBe(0); // saíram da fila principal
  });
});
