import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { DomainError, FailureCode } from '../domain/errors';
import { requireObject, requireString, requireUuid } from '../common/validation';
import { WalletMapper, type WalletResponse } from './wallet.mapper';
import { WalletsService } from './wallets.service';

/**
 * Controller = a "porta de entrada" HTTP. Ele só:
 *   1. lê e valida a requisição;
 *   2. chama o service (onde ficam as regras);
 *   3. devolve a resposta.
 */
@Controller('wallets')
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  /** POST /wallets — abre uma carteira. Responde 201 (Created). */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown): Promise<WalletResponse> {
    const obj = requireObject(body);
    const wallet = await this.wallets.create({
      playerId: requireString(obj, 'playerId'),
      currency: requireString(obj, 'currency', 3),
      // Repassado como veio: o Money recusa se não for string decimal (ex.: um number).
      initialBalance: obj.initialBalance === undefined ? undefined : (obj.initialBalance as string),
    });
    return WalletMapper.toResponse(wallet);
  }

  /** GET /wallets/:id — consulta uma carteira. */
  @Get(':id')
  async findOne(@Param('id') id: string): Promise<WalletResponse> {
    const wallet = await this.wallets.findById(requireUuid(id));
    return WalletMapper.toResponse(wallet);
  }

  /** GET /wallets?playerId=X — carteiras de um jogador. */
  @Get()
  async findByPlayer(@Query('playerId') playerId?: string): Promise<WalletResponse[]> {
    if (!playerId) throw new DomainError(FailureCode.INVALID_REQUEST, 'Query param "playerId" is required');
    const wallets = await this.wallets.findByPlayer(playerId);
    return wallets.map((w) => WalletMapper.toResponse(w));
  }

  /** GET /wallets/:id/ledger?limit=50&cursor=... — extrato paginado. */
  @Get(':id/ledger')
  async ledger(@Param('id') id: string, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    const parsedLimit = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
      throw new DomainError(FailureCode.INVALID_REQUEST, '"limit" must be an integer between 1 and 200');
    }
    return this.wallets.ledger(requireUuid(id), { limit: parsedLimit, cursor });
  }
}
