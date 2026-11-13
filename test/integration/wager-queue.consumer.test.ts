import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { DeleteMessageCommand, PurgeQueueCommand, ReceiveMessageCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { TransientError } from '../../src/common/transient-error';
import { config } from '../../src/config';
import { createSqsClient } from '../../src/messaging/sqs.client';
import { WagerQueueConsumer } from '../../src/messaging/wager-queue.consumer';
import { ProcessWagerService } from '../../src/wagering/process-wager.service';
import { assertLedgerInvariant, createInstances, resetDatabase } from '../support/database';
import { balanceOf, count, envelope, openWallet, request } from '../support/fixtures';
import { ensureTestQueues } from '../support/queues';

/** Consumidor SQS contra o MiniStack e o PostgreSQL reais. */
let orm: MikroORM;
let sqs: SQSClient;
let consumer: WagerQueueConsumer;
// O SQS FIFO descarta MessageDeduplicationId repetido por 5 min: prefixo único por execução.
const RUN = crypto.randomUUID();

beforeAll(async () => {
  await ensureTestQueues();
  [orm] = (await createInstances(1)) as [MikroORM];
  sqs = createSqsClient();
  consumer = new WagerQueueConsumer(sqs, new ProcessWagerService(orm.em));
  // Só UMA limpeza, no início: o PurgeQueue do SQS é assíncrono (pode apagar mensagens que
  // chegam logo depois) e só pode rodar a cada 60 s. Entre testes, isolamos por grupo e marcador.
  await sqs.send(new PurgeQueueCommand({ QueueUrl: config.sqs.wagerQueueUrl })).catch(() => undefined);
  await Bun.sleep(1_500);
});
afterAll(async () => {
  await orm.close();
});
beforeEach(async () => {
  await resetDatabase(orm);
});
afterEach(async () => {
  await assertLedgerInvariant(orm);
});

async function send(body: string, dedup: string, group = 'g1'): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: config.sqs.wagerQueueUrl,
      MessageBody: body,
      MessageGroupId: group,
      // Único por ENVIO: o FIFO descarta ids repetidos por 5 min, mesmo entre testes diferentes.
      MessageDeduplicationId: `${RUN}:${dedup}:${crypto.randomUUID()}`,
    }),
  );
}

/**
 * Processa até a fila esvaziar. A FIFO pode responder "vazio" por um instante entre duas
 * mensagens do mesmo grupo, então só paramos depois de uma segunda busca vazia com espera.
 */
async function drain(c = consumer): Promise<number> {
  let handled = 0;
  for (let i = 0; i < 30; i++) {
    const n = (await c.pollOnce(0)) || (await c.pollOnce(1));
    if (n === 0) return handled;
    handled += n;
  }
  return handled;
}

/**
 * Códigos de falha das mensagens na DLQ que pertencem a ESTE teste (filtradas pelo marcador,
 * normalmente o id da carteira). Não dependemos de PurgeQueue: no SQS ele é assíncrono e só
 * pode rodar uma vez a cada 60 s, então testes seguidos poderiam ver mensagens uns dos outros.
 */
async function dlqCodes(marker: string, expected: number): Promise<string[]> {
  const codes: string[] = [];
  for (let i = 0; i < 10 && codes.length < expected; i++) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: config.sqs.wagerDlqUrl, MaxNumberOfMessages: 10, MessageAttributeNames: ['All'], WaitTimeSeconds: 1 }),
    );
    for (const m of Messages) {
      if (!m.Body?.includes(marker)) continue;
      codes.push(m.MessageAttributes?.failureCode?.StringValue ?? '?');
      await sqs.send(new DeleteMessageCommand({ QueueUrl: config.sqs.wagerDlqUrl, ReceiptHandle: m.ReceiptHandle! }));
    }
  }
  return codes.sort();
}

describe('Consumidor SQS', () => {
  test('processa em ordem por carteira, grava a inbox e confirma (ack) após o commit', async () => {
    const w = await openWallet(orm, '100.00');
    await send(envelope(request(w, 'BET', 'bet-1', '80.00'), 'msg-1'), 'd1', w);
    await send(envelope(request(w, 'BET', 'bet-2', '80.00'), 'msg-2'), 'd2', w);
    await drain();
    expect(await balanceOf(orm, w)).toBe('20.00');
    expect(await count(orm, `wager_transactions where status = 'REJECTED' and failure_code = 'INSUFFICIENT_FUNDS'`)).toBe(1);
    expect(await count(orm, `inbox_messages where consumer_name = ? and processed_at is not null`, [config.sqs.consumerName])).toBe(2);
    expect(await consumer.pollOnce(0)).toBe(0); // fila vazia: tudo confirmado
  });

  test('redelivery da mesma mensagem (mesmo messageId) → inbox reconhece, sem efeito duplicado', async () => {
    const w = await openWallet(orm, '100.00');
    const body = envelope(request(w, 'BET', 'bet-1', '30.00'), 'msg-1');
    await send(body, 'a', w);
    await send(body, 'b', w); // dedup id diferente → o SQS entrega de novo
    expect(await drain()).toBe(2); // as DUAS entregas foram processadas
    expect(await count(orm, `inbox_messages`)).toBe(1);
    expect(await balanceOf(orm, w)).toBe('70.00');
    expect(await count(orm, `wager_transactions where kind = 'BET'`)).toBe(1);
  });

  test('mesmo messageId com conteúdo diferente → DLQ com INBOX_PAYLOAD_MISMATCH', async () => {
    const w = await openWallet(orm, '100.00');
    await send(envelope(request(w, 'BET', 'bet-1', '30.00'), 'msg-1'), 'a', w);
    await send(envelope(request(w, 'BET', 'bet-1', '31.00'), 'msg-1'), 'b', w);
    await drain();
    expect(await dlqCodes(w, 1)).toEqual(['INBOX_PAYLOAD_MISMATCH']);
    expect(await balanceOf(orm, w)).toBe('70.00');
  }, 30_000);

  test('erros permanentes (JSON, tipo, OPENING, carteira inexistente) vão direto para a DLQ com o motivo', async () => {
    const w = await openWallet(orm, '10.00');
    const ok = request(w, 'BET', 'x', '1.00');
    await send(`isto não é json ${w}`, 'p1');
    await send(JSON.stringify({ ...JSON.parse(envelope(ok, 'm2')), type: 'Other' }), 'p2');
    const opening = JSON.parse(envelope(ok, 'm3'));
    opening.data.kind = 'OPENING';
    await send(JSON.stringify(opening), 'p3');
    // Carteira inexistente (o marcador `w` vai no externalTransactionId para filtrarmos a DLQ).
    await send(envelope(request('01a1d0f8-abcf-74e2-ba9a-8aa61550f864', 'BET', `y-${w}`, '1.00'), 'm4'), 'p4');
    await drain();
    expect(await dlqCodes(w, 4)).toEqual(['INVALID_JSON', 'INVALID_REQUEST', 'INVALID_REQUEST', 'WALLET_NOT_FOUND']);
    expect(await balanceOf(orm, w)).toBe('10.00');
  }, 30_000);

  test('erro TEMPORÁRIO → retry com espera; esgotado o limite, o redrive do SQS leva para a DLQ', async () => {
    // Caso de uso que sempre falha de forma temporária (ex.: banco fora do ar).
    const failing = new (class extends ProcessWagerService {
      override async execute(): Promise<never> {
        throw new TransientError('DATABASE_UNAVAILABLE', 'simulated outage');
      }
    })(orm.em);
    const flaky = new WagerQueueConsumer(sqs, failing);
    const w = await openWallet(orm, '10.00');
    await send(envelope(request(w, 'BET', 'bet-1', '1.00'), 'msg-1'), 't1', w);

    let receives = 0;
    for (let i = 0; i < 15; i++) {
      receives += await flaky.pollOnce(1);
      if (receives >= Number(process.env.SQS_TEST_MAX_RECEIVE_COUNT) && (await dlqCodes(w, 1)).length === 1) break;
    }
    expect(receives).toBe(Number(process.env.SQS_TEST_MAX_RECEIVE_COUNT)); // tentou o número configurado de vezes
    expect(await count(orm, `wager_transactions where kind = 'BET'`)).toBe(0);
  }, 60_000);

  test('desligando (SIGTERM): mensagens ainda não iniciadas voltam para a fila na hora', async () => {
    const w = await openWallet(orm, '10.00');
    await send(envelope(request(w, 'BET', 'bet-1', '1.00'), 'msg-1'), 's1');
    const stopping = new WagerQueueConsumer(sqs, new ProcessWagerService(orm.em));
    (stopping as unknown as { stopping: boolean }).stopping = true;
    expect(await stopping.pollOnce(1)).toBe(1); // recebeu e devolveu a visibilidade
    await drain(); // outra instância pega imediatamente
    expect(await balanceOf(orm, w)).toBe('9.00');
  });
});
