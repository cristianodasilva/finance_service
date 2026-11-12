import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { config } from '../config';
import { ProcessWagerService } from '../wagering/process-wager.service';
import { PollingWorker } from './polling-worker';

/**
 * Reprocessa transações em PENDING_REFERENCE (ex.: WIN que chegou antes da BET).
 *
 * A cada tentativa sem sucesso, a espera dobra: 2s, 4s, 8s, 16s, 32s...
 * Depois de `maxAttempts` tentativas, a transação é REJEITADA com REFERENCE_NOT_FOUND.
 */
@Injectable()
export class PendingReferenceWorker extends PollingWorker {
  protected readonly logger = new Logger(PendingReferenceWorker.name);
  protected readonly enabled = config.pendingReference.workerEnabled;
  protected readonly intervalMs = config.pendingReference.pollIntervalMs;

  constructor(
    private readonly em: EntityManager,
    private readonly processWager: ProcessWagerService,
  ) {
    super();
  }

  async runOnce(batchSize = 20): Promise<number> {
    const due = await this.em.fork().execute<{ id: string }[]>(
      `select id from wager_transactions
        where status = 'PENDING_REFERENCE' and next_attempt_at <= now()
        order by next_attempt_at
        limit ?`,
      [batchSize],
    );

    let handled = 0;
    for (const { id } of due) {
      const status = await this.processWager.retryPendingReference(id, {
        maxAttempts: config.pendingReference.maxAttempts,
        backoffMs: (attempt) => Math.min(2_000 * 2 ** attempt, 5 * 60_000),
      });
      if (status === null) continue; // outro worker pegou antes
      handled++;
      if (status !== 'PENDING_REFERENCE') this.logger.log(`Pending transaction ${id} → ${status}`);
    }
    return handled;
  }
}
