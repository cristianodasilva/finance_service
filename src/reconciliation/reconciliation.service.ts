import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { newId } from '../common/ids';
import { DomainError, FailureCode } from '../domain/errors';
import { Currency } from '../domain/money/currency';
import { Money, type MoneyProps } from '../domain/money/money';
import { metrics } from '../observability/metrics';

export interface WalletReconciliation {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  /** Extra: a versão gravada deve ser 1 (abertura) + número de movimentos após a abertura. */
  storedVersion: number;
  expectedVersion: number;
}

interface Row {
  wallet_id: string;
  currency: string;
  stored_balance: string;
  calculated_balance: string;
  checked_entries: number;
  stored_version: number;
  expected_version: number;
}

/**
 * Reconciliação: saldo gravado × saldo reconstruído pelo extrato.
 * Divergência → LOG de erro + MÉTRICA + registro em reconciliation_divergences + `consistent: false`.
 * NUNCA corrige o saldo: corrigir sozinho esconderia a causa e apagaria a evidência.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(private readonly em: EntityManager) {}

  private static readonly SQL = `
    select w.id as wallet_id, w.currency,
           w.balance::text as stored_balance,
           coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text
             as calculated_balance,
           count(l.id)::int as checked_entries,
           w.version as stored_version,
           -- versão 1 na abertura; cada lançamento sobe 1 (o da abertura também é a versão 1)
           coalesce(max(l.wallet_version), 1) as expected_version
      from wallets w
      left join wallet_ledger_entries l on l.wallet_id = w.id`;

  /** POST /wallets/:walletId/reconciliation */
  async reconcileWallet(walletId: string): Promise<WalletReconciliation> {
    const [row] = await this.em.fork().execute<Row[]>(`${ReconciliationService.SQL} where w.id = ? group by w.id`, [walletId]);
    if (!row) throw new DomainError(FailureCode.WALLET_NOT_FOUND, `Wallet ${walletId} not found`);
    return this.evaluate(row);
  }

  /** POST /reconciliation/runs — todas as carteiras. */
  async run() {
    const startedAt = new Date();
    const rows = await this.em.fork().execute<Row[]>(`${ReconciliationService.SQL} group by w.id`);
    const results = await Promise.all(rows.map((r) => this.evaluate(r)));
    const divergences = results.filter((r) => !r.consistent);
    if (divergences.length === 0) this.logger.log(`Reconciliation OK: ${rows.length} wallets checked`);
    return { checkedWallets: rows.length, divergences, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString() };
  }

  async openDivergences() {
    return this.em.fork().execute(
      `select id, wallet_id as "walletId", stored_balance::text as "storedBalance", ledger_balance::text as "calculatedBalance",
              stored_version as "storedVersion", ledger_version as "expectedVersion", status,
              first_detected_at as "firstDetectedAt", last_detected_at as "lastDetectedAt", times_detected as "timesDetected"
         from reconciliation_divergences where status = 'OPEN' order by first_detected_at`,
    );
  }

  private async evaluate(r: Row): Promise<WalletReconciliation> {
    const currency = Currency.of(r.currency);
    const stored = Money.fromDecimal(r.stored_balance, currency);
    const calculated = Money.fromDecimal(r.calculated_balance, currency);
    const result: WalletReconciliation = {
      walletId: r.wallet_id,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: stored.subtract(calculated).toJSON(),
      consistent: stored.equals(calculated) && r.stored_version === r.expected_version,
      checkedEntries: r.checked_entries,
      storedVersion: r.stored_version,
      expectedVersion: r.expected_version,
    };
    if (!result.consistent) await this.flag(result);
    return result;
  }

  private async flag(d: WalletReconciliation): Promise<void> {
    metrics.reconciliationDivergences.inc();
    this.logger.error(
      `Reconciliation divergence on wallet ${d.walletId}: stored=${d.storedBalance.amount} (v${d.storedVersion}) ` +
        `calculated=${d.calculatedBalance.amount} (v${d.expectedVersion})`,
    );
    await this.em.fork().execute(
      `insert into reconciliation_divergences (id, wallet_id, stored_balance, stored_version, ledger_balance, ledger_version)
       values (?, ?, ?, ?, ?, ?)
       on conflict (wallet_id) where status = 'OPEN' do update set
         stored_balance = excluded.stored_balance, stored_version = excluded.stored_version,
         ledger_balance = excluded.ledger_balance, ledger_version = excluded.ledger_version,
         last_detected_at = now(), times_detected = reconciliation_divergences.times_detected + 1`,
      [newId(), d.walletId, d.storedBalance.amount, d.storedVersion, d.calculatedBalance.amount, d.expectedVersion],
    );
  }
}
