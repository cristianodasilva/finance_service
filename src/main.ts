import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DomainErrorFilter } from './common/domain-error.filter';
import { InfrastructureErrorFilter } from './common/infrastructure-error.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  // Converte erros em respostas HTTP: regra de negócio (400/404/409/422) e falha temporária (503).
  app.useGlobalFilters(new DomainErrorFilter(), new InfrastructureErrorFilter());
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
}

void bootstrap();
