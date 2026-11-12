import { Module } from '@nestjs/common';
import { ProcessWagerService } from './process-wager.service';
import { WageringController } from './wagering.controller';

@Module({
  controllers: [WageringController],
  providers: [ProcessWagerService],
  exports: [ProcessWagerService], // o consumidor da fila também vai usar
})
export class WageringModule {}
