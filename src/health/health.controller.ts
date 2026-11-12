import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';

@Controller('health')
export class HealthController {
  constructor(private readonly orm: MikroORM) {}

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
    try {
      await this.orm.em.getConnection().execute('select 1');
      checks.database = 'ok';
    } catch {
      checks.database = 'down';
      throw new ServiceUnavailableException({ status: 'error', checks });
    }
    // A FAZER: verificar também a fila SQS quando ela for configurada.
    return { status: 'ok', checks };
  }
}
