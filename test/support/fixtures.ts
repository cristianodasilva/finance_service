import type { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/domain/money/money';
import type { WagerKind } from '../../src/domain/wager/wager-transaction';
import type { WagerRequest, WagerSource } from '../../src/wagering/process-wager.service';
import { ProcessWagerService } from '../../src/wagering/process-wager.service';
import { WalletsService } from '../../src/wallets/wallets.service';

/** Atalhos para os testes de integração. */

export const PLAYER = 'player-1';

export async function openWallet(orm: MikroORM, amount: string, playerId = PLAYER): Promise<string> {
  const wallet = await new WalletsService(orm.em).create({ playerId, initialBalance: { amount, currency: 'BRL' } });
  return wallet.id;
}

export function request(walletId: string, kind: WagerKind, externalTransactionId: string, amount: string, extra: Partial<WagerRequest> = {}): WagerRequest {
  return {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: PLAYER,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: Money.from({ amount, currency: 'BRL' }),
    referenceExternalTransactionId: null,
    ...extra,
  };
}

/** Envia com a chave padrão recomendada: "{providerId}:{externalTransactionId}". */
export function submit(service: ProcessWagerService, r: WagerRequest, source: WagerSource = { type: 'http' }, key?: string) {
  return service.execute(r, key ?? `${r.providerId}:${r.externalTransactionId}`, source);
}

export const services = (instances: MikroORM[]) => instances.map((orm) => new ProcessWagerService(orm.em));

/** Envelope da fila no formato do contrato. */
export function envelope(r: WagerRequest, messageId: string, idempotencyKey = `${r.providerId}:${r.externalTransactionId}`) {
  return JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: r.providerId,
      externalTransactionId: r.externalTransactionId,
      idempotencyKey,
      playerId: r.playerId,
      walletId: r.walletId,
      roundId: r.roundId,
      gameId: r.gameId,
      kind: r.kind,
      money: r.money.toJSON(),
      ...(r.referenceExternalTransactionId ? { referenceExternalTransactionId: r.referenceExternalTransactionId } : {}),
    },
  });
}

export async function balanceOf(orm: MikroORM, walletId: string): Promise<string> {
  const [row] = await orm.em.fork().execute(`select balance::text from wallets where id = ?`, [walletId]);
  return row!.balance;
}

export async function count(orm: MikroORM, sql: string, params: unknown[] = []): Promise<number> {
  const [row] = await orm.em.fork().execute(`select count(*)::int as n from ${sql}`, params);
  return row!.n;
}
