import type { Wallet } from '../domain/wallet/wallet';

/** Formato da carteira nas respostas da API (dinheiro sempre como { amount, currency }). */
export function walletView(w: Wallet) {
  return {
    id: w.id,
    playerId: w.playerId,
    balance: w.balance.toJSON(),
    version: w.version,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}
export type WalletView = ReturnType<typeof walletView>;
