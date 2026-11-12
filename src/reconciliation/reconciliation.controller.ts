import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ReconciliationService } from './reconciliation.service';

@Controller('reconciliation')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  /** POST /reconciliation/runs — executa a conferência agora e devolve o relatório. */
  @Post('runs')
  @HttpCode(HttpStatus.OK)
  run() {
    return this.reconciliation.run();
  }

  /** GET /reconciliation/divergences — divergências abertas, aguardando análise. */
  @Get('divergences')
  divergences() {
    return this.reconciliation.openDivergences();
  }
}
