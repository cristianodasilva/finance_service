import { DomainError, FailureCode, InvalidTransactionStateError } from '../errors';
import { LedgerDirection } from '../ledger/wallet-ledger-entry';
import type { Money } from '../money/money';

export const WagerKind = {
  Opening: 'OPENING', // interno: crédito de abertura da carteira
  Bet: 'BET',
  Win: 'WIN',
  Loss: 'LOSS',
  Refund: 'REFUND',
  Rollback: 'ROLLBACK',
} as const;
export type WagerKind = (typeof WagerKind)[keyof typeof WagerKind];

/** Tipos que o provedor pode enviar (OPENING é interno). */
export const EXTERNAL_KINDS: readonly WagerKind[] = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'];

export const WagerStatus = {
  Pending: 'PENDING', // aceita, ainda não aplicada
  PendingReference: 'PENDING_REFERENCE', // aguardando a transação referenciada
  Processed: 'PROCESSED', // aplicada (FINAL)
  Rejected: 'REJECTED', // regra de negócio recusou (FINAL)
  Failed: 'FAILED', // erro permanente de infraestrutura (FINAL, auditável)
} as const;
export type WagerStatus = (typeof WagerStatus)[keyof typeof WagerStatus];

const TERMINAL: readonly WagerStatus[] = ['PROCESSED', 'REJECTED', 'FAILED'];

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  /** Obrigatórios para transações do provedor; nulos apenas no OPENING interno. */
  roundId: string | null;
  gameId: string | null;
  kind: WagerKind;
  money: Money;
  /** Id da referência NO PROVEDOR (não o nosso id interno). */
  referenceExternalTransactionId: string | null;
  createdAt: Date;
  status: WagerStatus;
  /** Nosso id interno da referência, preenchido quando ela é encontrada. */
  referenceTransactionId: string | null;
  failureCode: string | null;
  processedAt: Date | null;
}

export type CreateWagerTransactionProps = Omit<
  WagerTransactionState,
  'status' | 'referenceTransactionId' | 'failureCode' | 'processedAt'
>;

/**
 * Transação de aposta. Estados e transições válidas:
 *
 *   PENDING ──────────────► PROCESSED   (final)
 *      │  ╲───────────────► REJECTED    (final)
 *      │   ╲──────────────► FAILED      (final)
 *      ▼
 *   PENDING_REFERENCE ──┬─► PROCESSED / REJECTED / FAILED
 *      ▲                │
 *      └────────────────┘  (continua aguardando a referência)
 *
 * Tentar mudar uma transação FINAL lança InvalidTransactionStateError (erro de programação).
 */
export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string | null,
    readonly gameId: string | null,
    readonly kind: WagerKind,
    readonly money: Money,
    readonly referenceExternalTransactionId: string | null,
    readonly createdAt: Date,
    private _status: WagerStatus,
    private _referenceTransactionId: string | null,
    private _failureCode: string | null,
    private _processedAt: Date | null,
  ) {}

  /**
   * Cria uma transação vinda do provedor. Nasce em PENDING.
   * Valida: kind externo, referência quando exigida, rodada/jogo presentes, valor > 0 (LOSS pode ser 0).
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!EXTERNAL_KINDS.includes(props.kind)) {
      throw new DomainError(FailureCode.INVALID_REQUEST, `kind ${props.kind} cannot be submitted`);
    }
    if (!props.roundId || !props.gameId) {
      throw new DomainError(FailureCode.INVALID_REQUEST, 'roundId and gameId are required');
    }
    const tx = WagerTransaction.fromProps(props);
    if (tx.requiresReference() && !props.referenceExternalTransactionId) {
      throw new DomainError(FailureCode.INVALID_REQUEST, `referenceExternalTransactionId is required for ${props.kind}`);
    }
    if (props.money.isNegative() || (props.money.isZero() && props.kind !== WagerKind.Loss)) {
      throw new DomainError(FailureCode.INVALID_AMOUNT, 'Amount must be greater than zero');
    }
    return tx;
  }

  /** Cria a transação interna OPENING (saldo inicial), já PROCESSED. */
  static opening(props: { id: string; walletId: string; playerId: string; money: Money; payloadHash: string; at: Date }) {
    const tx = WagerTransaction.fromProps({
      id: props.id,
      providerId: 'internal',
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `internal:opening:${props.walletId}`,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: null,
      gameId: null,
      kind: WagerKind.Opening,
      money: props.money,
      referenceExternalTransactionId: null,
      createdAt: props.at,
    });
    tx.markProcessed(undefined, props.at);
    return tx;
  }

  /** Reconstrói a partir do banco (não revalida transições). */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id, s.providerId, s.externalTransactionId, s.idempotencyKey, s.payloadHash, s.walletId, s.playerId,
      s.roundId, s.gameId, s.kind, s.money, s.referenceExternalTransactionId, s.createdAt,
      s.status, s.referenceTransactionId, s.failureCode, s.processedAt,
    );
  }

  private static fromProps(p: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      p.id, p.providerId, p.externalTransactionId, p.idempotencyKey, p.payloadHash, p.walletId, p.playerId,
      p.roundId, p.gameId, p.kind, p.money, p.referenceExternalTransactionId ?? null, p.createdAt,
      WagerStatus.Pending, null, null, null,
    );
  }

  get status(): WagerStatus {
    return this._status;
  }
  get referenceTransactionId(): string | null {
    return this._referenceTransactionId;
  }
  get failureCode(): string | null {
    return this._failureCode;
  }
  get processedAt(): Date | null {
    return this._processedAt;
  }

  // ---------------- transições ----------------

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerStatus.Processed;
    this._referenceTransactionId = referenceTransactionId ?? this._referenceTransactionId;
    this._processedAt = at;
  }

  markPendingReference(): void {
    this.assertNotTerminal('markPendingReference');
    this._status = WagerStatus.PendingReference;
  }

  reject(code: FailureCode, at: Date = new Date()): void {
    this.assertNotTerminal('reject');
    this._status = WagerStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at;
  }

  fail(code: string, at: Date = new Date()): void {
    this.assertNotTerminal('fail');
    this._status = WagerStatus.Failed;
    this._failureCode = code;
    this._processedAt = at;
  }

  /** Guarda o id interno da referência assim que ela é encontrada (mesmo se a decisão for rejeitar). */
  linkReference(referenceTransactionId: string): void {
    this.assertNotTerminal('linkReference');
    this._referenceTransactionId = referenceTransactionId;
  }

  // ---------------- consultas ----------------

  isTerminal(): boolean {
    return TERMINAL.includes(this._status);
  }

  /** LOSS registra o resultado sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerKind.Loss;
  }

  /** REFUND e ROLLBACK precisam dizer o que estão revertendo. (WIN/LOSS podem referenciar, opcionalmente.) */
  requiresReference(): boolean {
    return this.kind === WagerKind.Refund || this.kind === WagerKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Para onde o dinheiro vai. ROLLBACK faz o movimento INVERSO da referência. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case 'BET':
        return LedgerDirection.Debit;
      case 'WIN':
      case 'REFUND':
      case 'OPENING':
        return LedgerDirection.Credit;
      case 'ROLLBACK': {
        if (!reference) throw new Error('ROLLBACK needs its reference to know the direction');
        const original = reference.ledgerDirectionFor();
        return original === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case 'LOSS':
        throw new Error('LOSS does not move balance');
    }
  }

  private assertNotTerminal(action: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`Cannot ${action}: transaction ${this.id} is already ${this._status}`);
    }
  }
}
