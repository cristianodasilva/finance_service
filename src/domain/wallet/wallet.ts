import { DomainError, FailureCode } from '../errors';
import { Currency } from '../money/currency';
import { Money } from '../money/money';

/** Dados necessários para montar uma carteira. */
export interface WalletProps {
  id: string;
  playerId: string;
  currency: Currency;
  balance: Money;
  version: number;
  createdAt: Date;
}

/**
 * Carteira (wallet): existe uma por jogador + moeda.
 *
 * Regras que esta classe garante (invariantes = regras sempre verdadeiras):
 *  - o saldo nunca fica negativo;
 *  - o saldo está sempre na mesma moeda da carteira;
 *  - `version` só aumenta quando o saldo realmente muda.
 *    (A versão será usada no banco para detectar alterações simultâneas.)
 *
 * Esta classe não sabe nada de banco de dados. O mapeamento para tabela fica em outro lugar.
 */
export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: Currency;
  readonly createdAt: Date;

  // "_" + private: só a própria classe altera. De fora, só leitura (pelos getters abaixo).
  private _balance: Money;
  private _version: number;

  private constructor(props: WalletProps) {
    if (!props.balance.currency.equals(props.currency)) {
      throw new DomainError(FailureCode.CURRENCY_MISMATCH, 'Balance currency differs from wallet currency');
    }
    if (props.balance.isNegative()) {
      throw new DomainError(FailureCode.INVALID_AMOUNT, 'Wallet balance cannot be negative');
    }
    this.id = props.id;
    this.playerId = props.playerId;
    this.currency = props.currency;
    this.createdAt = props.createdAt;
    this._balance = props.balance;
    this._version = props.version;
  }

  /**
   * Abre uma carteira NOVA, com saldo zero.
   * Se houver saldo inicial, ele entra depois via `credit` (transação OPENING),
   * para que também fique registrado no extrato (ledger).
   */
  static open(params: { id: string; playerId: string; currency: Currency; now?: Date }): Wallet {
    return new Wallet({
      id: params.id,
      playerId: params.playerId,
      currency: params.currency,
      balance: Money.zero(params.currency),
      version: 0,
      createdAt: params.now ?? new Date(),
    });
  }

  /** Remonta uma carteira que já existe, a partir dos dados lidos do banco. */
  static restore(props: WalletProps): Wallet {
    return new Wallet(props);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  /** Adiciona dinheiro (WIN, REFUND, OPENING, ou estorno de uma BET). */
  credit(amount: Money): void {
    this.assertValidAmount(amount);
    this.applyDelta(amount);
  }

  /** Retira dinheiro para uma aposta (BET). Falha com INSUFFICIENT_FUNDS se não houver saldo. */
  debit(amount: Money): void {
    this.assertValidAmount(amount);
    if (this._balance.lessThan(amount)) {
      throw new DomainError(
        FailureCode.INSUFFICIENT_FUNDS,
        `Insufficient funds: balance ${this._balance.toDecimal()}, requested ${amount.toDecimal()}`,
      );
    }
    this.applyDelta(amount.negate());
  }

  /**
   * Retira dinheiro para desfazer um crédito anterior (ROLLBACK de um WIN/REFUND).
   *
   * Usa um código de erro DIFERENTE do `debit`: aqui o prêmio já foi pago
   * e o jogador já gastou. Não é "aposta sem saldo"; é um caso que
   * normalmente precisa de atenção da equipe de operações.
   */
  reverseCredit(amount: Money): void {
    this.assertValidAmount(amount);
    if (this._balance.lessThan(amount)) {
      throw new DomainError(
        FailureCode.REVERSAL_WOULD_OVERDRAW,
        `Reversal would overdraw: balance ${this._balance.toDecimal()}, reversal ${amount.toDecimal()}`,
      );
    }
    this.applyDelta(amount.negate());
  }

  /** Aplica a variação (delta) no saldo e incrementa a versão. */
  private applyDelta(delta: Money): void {
    if (delta.isZero()) return; // saldo não mudou → versão não muda
    this._balance = this._balance.add(delta);
    this._version += 1;
  }

  /** O valor precisa ser da mesma moeda e maior que zero. */
  private assertValidAmount(amount: Money): void {
    if (!amount.currency.equals(this.currency)) {
      throw new DomainError(
        FailureCode.CURRENCY_MISMATCH,
        `Wallet currency is ${this.currency.code}, got ${amount.currency.code}`,
      );
    }
    if (!amount.isPositive()) {
      throw new DomainError(FailureCode.INVALID_AMOUNT, 'Amount must be greater than zero');
    }
  }
}
