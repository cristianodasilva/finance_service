import { Module } from '@nestjs/common';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

@Module({
  imports: [ReconciliationModule],
  controllers: [WalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
