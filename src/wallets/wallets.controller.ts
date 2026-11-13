import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ProviderAuthGuard } from '../auth/provider-auth.guard';
import { requireObject, requireString, requireUuid } from '../common/validation';
import { DomainError, FailureCode } from '../domain/errors';
import type { MoneyProps } from '../domain/money/money';
import { ReconciliationService } from '../reconciliation/reconciliation.service';
import { walletView, type WalletView } from './wallet.view';
import { WalletsService } from './wallets.service';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    private readonly wallets: WalletsService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  /** POST /wallets — { playerId, initialBalance: { amount, currency } } → 201. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown): Promise<WalletView> {
    const obj = requireObject(body);
    const initialBalance = obj.initialBalance;
    if (typeof initialBalance !== 'object' || initialBalance === null) {
      throw new DomainError(FailureCode.INVALID_REQUEST, '"initialBalance" must be { amount, currency }');
    }
    const wallet = await this.wallets.create({
      playerId: requireString(obj, 'playerId'),
      initialBalance: initialBalance as MoneyProps,
    });
    return walletView(wallet);
  }

  /** GET /wallets?playerId=X — carteiras de um jogador. */
  @Get()
  async findByPlayer(@Query('playerId') playerId?: string): Promise<WalletView[]> {
    if (!playerId) throw new DomainError(FailureCode.INVALID_REQUEST, 'Query param "playerId" is required');
    return (await this.wallets.findByPlayer(playerId)).map(walletView);
  }

  /** GET /wallets/:walletId */
  @Get(':walletId')
  async findOne(@Param('walletId') walletId: string): Promise<WalletView> {
    return walletView(await this.wallets.findById(requireUuid(walletId, 'walletId')));
  }

  /** GET /wallets/:walletId/ledger?cursor=...&limit=50 */
  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    const parsedLimit = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
      throw new DomainError(FailureCode.INVALID_REQUEST, '"limit" must be an integer between 1 and 200');
    }
    return this.wallets.ledger(requireUuid(walletId, 'walletId'), { limit: parsedLimit, cursor });
  }

  /** POST /wallets/:walletId/reconciliation — confere saldo × extrato desta carteira. */
  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  reconcile(@Param('walletId') walletId: string) {
    return this.reconciliation.reconcileWallet(requireUuid(walletId, 'walletId'));
  }
}
