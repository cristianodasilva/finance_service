import { EntitySchema } from '@mikro-orm/core';

/**
 * Representação de UMA LINHA da tabela `wallets`, do jeito que está no banco.
 *
 * Por que existe esta classe além da `Wallet` do domínio?
 *  - `Wallet` (domínio) tem as REGRAS de negócio e usa `Money`.
 *  - `WalletRecord` (banco) é só um "espelho" da tabela: textos, números, datas.
 * Um "mapper" converte de um para o outro (ver wallet.mapper.ts).
 * Assim o domínio não depende da ORM e continua testável sem banco.
 */
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  /** Decimal vem do banco como TEXTO ("100.00"), nunca como number. */
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'text' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { type: 'decimal', columnType: 'numeric(20,2)' },
    version: { type: 'integer' },
    createdAt: { type: 'Date', columnType: 'timestamptz' },
    updatedAt: { type: 'Date', columnType: 'timestamptz' },
  },
});
