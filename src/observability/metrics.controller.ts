import { Controller, Get, Header } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { metrics, registry } from './metrics';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly em: EntityManager) {}

  /** GET /metrics — formato texto do Prometheus (quem coleta é o servidor Prometheus). */
  @Get()
  @Header('Content-Type', registry.contentType)
  async scrape(): Promise<string> {
    // Atraso da outbox: calculado na hora, direto do banco (vale para todas as instâncias).
    const [row] = await this.em.fork().execute<{ pending: number; lag: number | null }[]>(
      `select count(*)::int as pending,
              extract(epoch from now() - min(occurred_at))::float as lag
         from outbox_events where published_at is null`,
    );
    metrics.outboxPending.set(row?.pending ?? 0);
    metrics.outboxLag.set(row?.lag ?? 0);
    return registry.metrics();
  }
}
