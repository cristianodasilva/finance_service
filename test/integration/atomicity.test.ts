import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerService } from '../../src/wagering/process-wager.service';
import { assertLedgerInvariant, createInstances, resetDatabase } from '../support/database';
import { balanceOf, count, openWallet, request, submit } from '../support/fixtures';

/**
 * Atomicidade: transação, saldo, extrato, inbox e outbox são confirmados JUNTOS ou nada.
 * Forçamos a última gravação (outbox) a falhar com uma constraint temporária no banco.
 */
let orm: MikroORM;

beforeAll(async () => {
  [orm] = (await createInstances(1)) as [MikroORM];
});
afterAll(async () => {
  await orm.close();
});
beforeEach(async () => {
  await resetDatabase(orm);
});
afterEach(async () => {
  await orm.em.fork().execute(`alter table outbox_events drop constraint if exists test_force_failure`);
  await assertLedgerInvariant(orm);
});

describe('Atomicidade', () => {
  test('falha ao gravar o evento na outbox desfaz TUDO: transação, saldo, extrato e inbox', async () => {
    const w = await openWallet(orm, '100.00');
    const before = { tx: await count(orm, 'wager_transactions'), ledger: await count(orm, 'wallet_ledger_entries'), outbox: await count(orm, 'outbox_events') };
    // Qualquer evento novo passa a violar esta constraint.
    await orm.em.fork().execute(`alter table outbox_events add constraint test_force_failure check (false) not valid`);

    const error = await submit(new ProcessWagerService(orm.em), request(w, 'BET', 'bet-1', '40.00'), {
      type: 'sqs', consumerName: 'test', messageId: 'msg-1', messagePayloadHash: 'h',
    }).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(await balanceOf(orm, w)).toBe('100.00');
    expect(await count(orm, 'wager_transactions')).toBe(before.tx);
    expect(await count(orm, 'wallet_ledger_entries')).toBe(before.ledger);
    expect(await count(orm, 'outbox_events')).toBe(before.outbox);
    expect(await count(orm, 'inbox_messages')).toBe(0);
  });

  test('abertura de carteira com saldo: carteira, OPENING, CREDIT e eventos — ou nada', async () => {
    await orm.em.fork().execute(`alter table outbox_events add constraint test_force_failure check (false) not valid`);
    await openWallet(orm, '50.00').catch(() => undefined);
    // A carteira chega a ser gravada num passo anterior? Não: tudo está na mesma transação.
    expect(await count(orm, 'wallets')).toBe(0);
    expect(await count(orm, 'wager_transactions')).toBe(0);
    expect(await count(orm, 'wallet_ledger_entries')).toBe(0);
  });
});
