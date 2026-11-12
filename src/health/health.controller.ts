import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { config } from '../config';
import { SQS_CLIENT } from '../messaging/sqs.client';

@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
  ) {}

  /**
   * "Estou vivo?" — responde ok se o processo está rodando.
   * Não consulta nada externo: serve só para saber se a aplicação travou.
   */
  @Get('live')
  live(): { status: string } {
    return { status: 'ok' };
  }

  /**
   * "Estou pronto para receber tráfego?" — confere as dependências.
   * Se o banco estiver fora, responde 503 (Service Unavailable).
   */
  @Get('ready')
  async ready(): Promise<{ status: string; checks: Record<string, string> }> {
    const checks: Record<string, string> = {};
    // Confere banco e fila em paralelo; cada um com o seu resultado.
    const [database, queue] = await Promise.allSettled([
      this.orm.em.getConnection().execute('select 1'),
      this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: config.sqs.wagerQueueUrl, AttributeNames: ['QueueArn'] })),
    ]);
    checks.database = database.status === 'fulfilled' ? 'ok' : 'down';
    checks.queue = queue.status === 'fulfilled' ? 'ok' : 'down';
    if (Object.values(checks).includes('down')) {
      throw new ServiceUnavailableException({ status: 'error', checks });
    }
    return { status: 'ok', checks };
  }
}
