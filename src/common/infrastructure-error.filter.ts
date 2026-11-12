import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { ConnectionException, LockWaitTimeoutException } from '@mikro-orm/core';
import type { Response } from 'express';
import { TransientError } from './transient-error';

/**
 * Falhas temporárias → HTTP 503 (Service Unavailable) + header Retry-After.
 * Diz ao cliente: "não é culpa sua e não foi recusado; tente de novo em instantes".
 */
@Catch(TransientError, ConnectionException, LockWaitTimeoutException)
export class InfrastructureErrorFilter implements ExceptionFilter {
  catch(error: Error, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const code = error instanceof TransientError ? error.code : 'SERVICE_UNAVAILABLE';
    response
      .status(HttpStatus.SERVICE_UNAVAILABLE)
      .setHeader('Retry-After', '1')
      .json({ code, message: 'Temporary failure, please retry' });
  }
}
