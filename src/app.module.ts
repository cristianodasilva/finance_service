import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import ormConfig from './database/mikro-orm.config';
import { HealthModule } from './health/health.module';
import { MessagingModule } from './messaging/messaging.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { WageringModule } from './wagering/wagering.module';
import { WalletsModule } from './wallets/wallets.module';
import { WorkersModule } from './workers/workers.module';

@Module({
  imports: [
    // Conecta ao banco usando a configuração do MikroORM.
    // registerRequestContext: cria um "EntityManager" separado para cada requisição HTTP,
    // assim uma requisição não enxerga as alterações em andamento de outra.
    MikroOrmModule.forRoot({ ...ormConfig, registerRequestContext: true }),
    HealthModule,
    WalletsModule,
    WageringModule,
    MessagingModule,
    WorkersModule,
    ReconciliationModule,
  ],
})
export class AppModule {}
