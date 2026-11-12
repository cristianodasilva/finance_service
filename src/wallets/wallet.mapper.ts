import { Currency } from '../domain/money/currency';
import { Money } from '../domain/money/money';
import { Wallet } from '../domain/wallet/wallet';
import type { WalletRecord } from '../database/entities/wallet.record';

/**
 * Converte entre a linha do banco (WalletRecord) e o objeto de domínio (Wallet).
 * É aqui que o texto "100.00" vira Money (e vice-versa).
 */
export const WalletMapper = {
  toDomain(record: WalletRecord): Wallet {
    const currency = Currency.of(record.currency);
    return Wallet.restore({
      id: record.id,
      playerId: record.playerId,
      currency,
      balance: Money.fromDecimal(record.balance, currency),
      version: record.version,
      createdAt: record.createdAt,
    });
  },

  /** Formato devolvido pela API (dinheiro sempre como texto decimal). */
  toResponse(wallet: Wallet) {
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency.code,
      balance: wallet.balance.toDecimal(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
    };
  },
};

export type WalletResponse = ReturnType<typeof WalletMapper.toResponse>;
