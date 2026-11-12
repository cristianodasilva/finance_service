import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DomainErrorFilter } from './common/domain-error.filter';
import { InfrastructureErrorFilter } from './common/infrastructure-error.filter';
import { config } from './config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  // Converte erros em respostas HTTP: regra de negócio (400/404/409/422) e falha temporária (503).
  app.useGlobalFilters(new DomainErrorFilter(), new InfrastructureErrorFilter());
  await app.listen(config.port);
}

void bootstrap();
