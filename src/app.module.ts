import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import ormConfig from './database/mikro-orm.config';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    // Conecta ao banco usando a configuração do MikroORM.
    // registerRequestContext: cria um "EntityManager" separado para cada requisição HTTP,
    // assim uma requisição não enxerga as alterações em andamento de outra.
    MikroOrmModule.forRoot({ ...ormConfig, registerRequestContext: true }),
    HealthModule,
  ],
})
export class AppModule {}
