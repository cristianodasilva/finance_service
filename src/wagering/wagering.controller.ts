import { Body, Controller, Get, Headers, Param, Post, Res, UseGuards } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import type { Response } from 'express';
import { ProviderAuthGuard } from '../auth/provider-auth.guard';
import { requireUuid } from '../common/validation';
import { WagerTransactionRecord } from '../database/entities/wager-transaction.record';
import { transactionFromRecord } from '../database/mappers';
import { DomainError, FailureCode } from '../domain/errors';
import { ProcessWagerService } from './process-wager.service';
import { parseIdempotencyKey, parseWagerRequest } from './wager-request.parser';
import { httpStatusFor, submitView, transactionView } from './wager.view';

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerService,
    private readonly em: EntityManager,
  ) {}

  /** POST /wagering/transactions — header Idempotency-Key obrigatório (fonte da verdade). */
  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const key = parseIdempotencyKey(idempotencyKey);
    const result = await this.processWager.execute(parseWagerRequest(body), key, { type: 'http' });
    res.status(httpStatusFor(result.transaction));
    return submitView(result);
  }

  /** GET /wagering/transactions/:transactionId */
  @Get('wagering/transactions/:transactionId')
  async findOne(@Param('transactionId') transactionId: string) {
    const record = await this.em.fork().findOne(WagerTransactionRecord, { id: requireUuid(transactionId, 'transactionId') });
    return this.view(record);
  }

  /** GET /providers/:providerId/wagering/transactions/:externalTransactionId */
  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async findByExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const record = await this.em.fork().findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return this.view(record);
  }

  private view(record: WagerTransactionRecord | null) {
    if (!record) throw new DomainError(FailureCode.TRANSACTION_NOT_FOUND, 'Transaction not found');
    return transactionView(transactionFromRecord(record), { amount: record.resultingBalance, currency: record.currency });
  }
}
