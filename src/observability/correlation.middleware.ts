import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { newId } from '../common/ids';
import { runWithLogContext } from './log-context';

/**
 * Para cada requisição HTTP: usa o header X-Correlation-Id (se o cliente mandar)
 * ou gera um novo. Devolve o mesmo id na resposta e o coloca em todos os logs
 * gerados durante essa requisição.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const header = req.header('x-correlation-id');
    const correlationId = header && header.length <= 128 ? header : newId();
    res.setHeader('X-Correlation-Id', correlationId);
    runWithLogContext({ correlationId }, () => next());
  }
}
