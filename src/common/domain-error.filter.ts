import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError, FailureCode } from '../domain/errors';

/**
 * Converte DomainError (erro de regra de negócio) em resposta HTTP.
 *
 * Cada tipo de problema tem um status diferente, para o cliente saber o que fazer:
 *   400 → você mandou algo inválido (corrija e envie de novo)
 *   404 → não existe
 *   409 → conflito (ex.: já existe)
 *   422 → entendemos o pedido, mas a regra de negócio recusou (ex.: sem saldo)
 */
// Códigos não listados aqui são recusas de regra de negócio → 422.
const STATUS_BY_CODE: Partial<Record<FailureCode, number>> = {
  [FailureCode.INVALID_REQUEST]: HttpStatus.BAD_REQUEST,
  [FailureCode.INVALID_AMOUNT]: HttpStatus.BAD_REQUEST,
  [FailureCode.UNSUPPORTED_CURRENCY]: HttpStatus.BAD_REQUEST,
  [FailureCode.WALLET_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [FailureCode.TRANSACTION_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [FailureCode.WALLET_ALREADY_EXISTS]: HttpStatus.CONFLICT,
  [FailureCode.IDEMPOTENCY_KEY_REUSED]: HttpStatus.CONFLICT,
  [FailureCode.PROVIDER_TRANSACTION_CONFLICT]: HttpStatus.CONFLICT,
  [FailureCode.INBOX_PAYLOAD_MISMATCH]: HttpStatus.CONFLICT,
};

// @Catch(DomainError): este filtro só trata erros desse tipo; os demais seguem o padrão do Nest.
@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter {
  catch(error: DomainError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = STATUS_BY_CODE[error.code] ?? HttpStatus.UNPROCESSABLE_ENTITY;
    response.status(status).json({ code: error.code, message: error.message });
  }
}
