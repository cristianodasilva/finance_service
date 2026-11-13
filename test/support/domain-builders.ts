import { Currency } from '../../src/domain/money/currency';
import { Money } from '../../src/domain/money/money';
import { payloadHash } from '../../src/domain/wager/payload-hash';
import { WagerTransaction, type WagerKind } from '../../src/domain/wager/wager-transaction';
import { Wallet } from '../../src/domain/wallet/wallet';

/** Atalhos para montar objetos de domínio nos testes unitários. */
export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

let seq = 0;
export const id = (prefix = 'id') => `${prefix}-${++seq}`;

export function walletWith(balance: string, playerId = 'player-1'): Wallet {
  const initial = brl(balance);
  return Wallet.open({
    id: 'wallet-1',
    playerId,
    initialBalance: initial,
    openingTransactionId: initial.isPositive() ? id('opening') : undefined,
    openingEntryId: initial.isPositive() ? id('entry') : undefined,
  });
}

export function wager(
  kind: WagerKind,
  amount: string,
  extra: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
): WagerTransaction {
  const props = {
    id: id('tx'),
    providerId: 'provider-a',
    externalTransactionId: id(`${kind.toLowerCase()}`),
    idempotencyKey: id('key'),
    payloadHash: 'sha256:test',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl(amount),
    referenceExternalTransactionId: null,
    createdAt: new Date(),
    ...extra,
  };
  return WagerTransaction.create({ ...props, payloadHash: extra.payloadHash ?? payloadHash({ ...props, money: props.money.toJSON() }) });
}

/** Uma referência já PROCESSED (ex.: a BET original). */
export function processed(tx: WagerTransaction): WagerTransaction {
  tx.markProcessed(undefined, new Date());
  return tx;
}

export const BRL = Currency.BRL;
