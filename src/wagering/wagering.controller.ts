import { Body, Controller, Get, Headers, Param, Post, Query, Res } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import type { Response } from 'express';
import { requireUuid } from '../common/validation';
import { WagerTransactionRecord } from '../database/entities/wager-transaction.record';
import { DomainError, FailureCode } from '../domain/errors';
import { ProcessWagerService } from './process-wager.service';
import { parseWagerCommand } from './wager-command.parser';
import { httpStatusFor, toWagerResponse } from './wager.mapper';

@Controller('wagering/transactions')
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerService,
    private readonly em: EntityManager,
  ) {}

  /**
   * POST /wagering/transactions
   * Header obrigatório: Idempotency-Key (o mesmo pedido repetido não é processado duas vezes).
   */
  @Post()
  async create(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    // passthrough: deixa o Nest montar a resposta, mas nos permite escolher o status.
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.trim() === '' || idempotencyKey.length > 200) {
      throw new DomainError(FailureCode.INVALID_REQUEST, 'Header "Idempotency-Key" is required (max 200 chars)');
    }
    const command = parseWagerCommand(body);
    const { transaction, replayed } = await this.processWager.execute(command, {
      type: 'http',
      idempotencyKey,
    });

    res.status(httpStatusFor(transaction));
    // Avisa o cliente que esta resposta é uma repetição de um pedido anterior.
    if (replayed) res.setHeader('Idempotent-Replayed', 'true');
    return toWagerResponse(transaction);
  }

  /**
   * GET /wagering/transactions?provider=X&providerTransactionId=Y
   * Busca pelo id que o provedor usa (útil para o provedor conferir o resultado).
   */
  @Get()
  async findByProvider(@Query('provider') provider?: string, @Query('providerTransactionId') providerTxId?: string) {
    if (!provider || !providerTxId) {
      throw new DomainError(FailureCode.INVALID_REQUEST, 'Query params "provider" and "providerTransactionId" are required');
    }
    const record = await this.em.fork().findOne(WagerTransactionRecord, { provider, providerTransactionId: providerTxId });
    if (!record) throw new DomainError(FailureCode.TRANSACTION_NOT_FOUND, 'Transaction not found');
    return toWagerResponse(record);
  }

  /** GET /wagering/transactions/:id — busca pelo nosso id interno. */
  @Get(':id')
  async findOne(@Param('id') id: string) {
    const record = await this.em.fork().findOne(WagerTransactionRecord, { id: requireUuid(id) });
    if (!record) throw new DomainError(FailureCode.TRANSACTION_NOT_FOUND, 'Transaction not found');
    return toWagerResponse(record);
  }
}
