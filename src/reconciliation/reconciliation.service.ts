import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { newId } from '../common/ids';
import { metrics } from '../observability/metrics';

export interface Divergence {
  walletId: string;
  storedBalance: string;
  ledgerBalance: string;
  storedVersion: number;
  ledgerVersion: number;
}

export interface ReconciliationReport {
  checkedWallets: number;
  divergences: Divergence[];
  startedAt: string;
  finishedAt: string;
}

/**
 * Reconciliação: confere se o saldo de cada carteira bate com o extrato.
 *
 * Para cada carteira, recalcula a partir do extrato:
 *   saldo esperado  = soma dos CRÉDITOS − soma dos DÉBITOS
 *   versão esperada = maior wallet_version do extrato (cada movimento sobe 1)
 *
 * Se algo não bater: LOG de erro + MÉTRICA + registro em reconciliation_divergences.
 * NUNCA altera o saldo.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(private readonly em: EntityManager) {}

  async run(): Promise<ReconciliationReport> {
    const startedAt = new Date();
    const em = this.em.fork();

    // Uma única consulta compara TODAS as carteiras com o extrato.
    const rows = await em.execute<
      { wallet_id: string; stored_balance: string; ledger_balance: string; stored_version: number; ledger_version: number }[]
    >(`
      select w.id                                    as wallet_id,
             w.balance::text                         as stored_balance,
             coalesce(l.balance, 0)::numeric(20,2)::text as ledger_balance,
             w.version                               as stored_version,
             coalesce(l.max_version, 0)              as ledger_version
        from wallets w
        left join (
          select wallet_id,
                 sum(case when direction = 'CREDIT' then amount else -amount end) as balance,
                 max(wallet_version) as max_version
            from wallet_ledger_entries
           group by wallet_id
        ) l on l.wallet_id = w.id
    `);

    const divergences: Divergence[] = rows
      .filter((r) => r.stored_balance !== r.ledger_balance || r.stored_version !== r.ledger_version)
      .map((r) => ({
        walletId: r.wallet_id,
        storedBalance: r.stored_balance,
        ledgerBalance: r.ledger_balance,
        storedVersion: r.stored_version,
        ledgerVersion: r.ledger_version,
      }));

    for (const d of divergences) {
      metrics.reconciliationDivergences.inc();
      // Log de ERRO: alguém precisa olhar. Só ids e valores agregados (nada sensível).
      this.logger.error(
        `Reconciliation divergence on wallet ${d.walletId}: stored=${d.storedBalance} (v${d.storedVersion}) ledger=${d.ledgerBalance} (v${d.ledgerVersion})`,
      );
      // Sinaliza: cria a divergência aberta, ou atualiza a que já existe para esta carteira.
      await em.execute(
        `insert into reconciliation_divergences
           (id, wallet_id, stored_balance, stored_version, ledger_balance, ledger_version)
         values (?, ?, ?, ?, ?, ?)
         on conflict (wallet_id) where status = 'OPEN' do update set
           stored_balance = excluded.stored_balance,
           stored_version = excluded.stored_version,
           ledger_balance = excluded.ledger_balance,
           ledger_version = excluded.ledger_version,
           last_detected_at = now(),
           times_detected = reconciliation_divergences.times_detected + 1`,
        [newId(), d.walletId, d.storedBalance, d.storedVersion, d.ledgerBalance, d.ledgerVersion],
      );
    }

    if (divergences.length === 0) this.logger.log(`Reconciliation OK: ${rows.length} wallets checked`);
    return {
      checkedWallets: rows.length,
      divergences,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }

  /** Lista as divergências ainda em aberto. */
  async openDivergences() {
    return this.em.fork().execute(
      `select id, wallet_id as "walletId", stored_balance::text as "storedBalance", ledger_balance::text as "ledgerBalance",
              stored_version as "storedVersion", ledger_version as "ledgerVersion", status,
              first_detected_at as "firstDetectedAt", last_detected_at as "lastDetectedAt", times_detected as "timesDetected"
         from reconciliation_divergences where status = 'OPEN' order by first_detected_at`,
    );
  }
}
