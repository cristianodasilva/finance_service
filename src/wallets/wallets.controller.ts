import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
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
}
