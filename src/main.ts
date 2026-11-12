import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DomainErrorFilter } from './common/domain-error.filter';
import { InfrastructureErrorFilter } from './common/infrastructure-error.filter';
import { config } from './config';
import { JsonLogger } from './observability/json-logger';

async function bootstrap(): Promise<void> {
  // LOG_FORMAT=pretty mostra os logs coloridos do Nest (útil no desenvolvimento).
  const logger = process.env.LOG_FORMAT === 'pretty' ? undefined : new JsonLogger();
  const app = await NestFactory.create(AppModule, logger ? { logger } : {});
  app.enableShutdownHooks();
  // Converte erros em respostas HTTP: regra de negócio (400/404/409/422) e falha temporária (503).
  app.useGlobalFilters(new DomainErrorFilter(), new InfrastructureErrorFilter());
  await app.listen(config.port);
}

void bootstrap();
