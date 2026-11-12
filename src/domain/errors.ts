/**
 * Stable failure codes. They are part of the public contract (API responses,
 * events, persisted rejections), so values must never be renamed.
 */
export const FailureCode = {
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  UNSUPPORTED_CURRENCY: 'UNSUPPORTED_CURRENCY',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  REVERSAL_WOULD_OVERDRAW: 'REVERSAL_WOULD_OVERDRAW',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

/** Base class for business rule violations (expected, non-retryable). */
export class DomainError extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
