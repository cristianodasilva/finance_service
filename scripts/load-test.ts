/**
 * TESTE DE CARGA — `bun run test:load` (com `docker compose up -d --build` no ar).
 *
 * Mede, contra as 3 instâncias atrás do nginx:
 *   - throughput (transações/s), latência p50/p95/p99, taxa de erro;
 *   - conflitos de concorrência (métrica das instâncias, antes × depois);
 *   - outbox lag (pior valor amostrado durante o teste) e tempo para a outbox esvaziar;
 *   - consistência final (reconciliação de todas as carteiras).
 *
 * Modelo "fechado": C trabalhadores enviam uma requisição, esperam a resposta e enviam a próxima,
 * durante D segundos. Cenários:
 *   1. distribuído: muitas carteiras (o caso real: jogadores diferentes);
 *   2. hot wallet: todas as requisições na MESMA carteira (o pior caso do optimistic locking).
 *
 * Parâmetros (variáveis de ambiente): LOAD_BASE_URL, LOAD_DURATION_S, LOAD_CONCURRENCY,
 * LOAD_WALLETS, LOAD_HOT_DURATION_S, LOAD_HOT_CONCURRENCY, LOAD_REPORT (arquivo de saída).
 */
import os from 'node:os';

const BASE = process.env.LOAD_BASE_URL ?? 'http://localhost:3000';
const INSTANCES = (process.env.LOAD_INSTANCE_URLS ?? 'http://localhost:3001,http://localhost:3002,http://localhost:3003').split(',');
const DURATION_S = Number(process.env.LOAD_DURATION_S ?? 30);
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 50);
const WALLETS = Number(process.env.LOAD_WALLETS ?? 200);
const HOT_DURATION_S = Number(process.env.LOAD_HOT_DURATION_S ?? 15);
const HOT_CONCURRENCY = Number(process.env.LOAD_HOT_CONCURRENCY ?? 20);
const REPORT = process.env.LOAD_REPORT ?? 'docs/load-test-results.md';
const RUN = crypto.randomUUID().slice(0, 8);

// ---------------------------------------------------------------- utilidades

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}

/** Lê um valor de métrica (soma de todas as séries com esse nome) no texto do Prometheus. */
function metric(text: string, name: string): number {
  return text
    .split('\n')
    .filter((l) => l.startsWith(name) && !l.startsWith('#'))
    .filter((l) => l.slice(name.length, name.length + 1) === ' ' || l.slice(name.length, name.length + 1) === '{')
    .reduce((sum, l) => sum + Number(l.trim().split(/\s+/).pop()), 0);
}

async function scrape(url: string): Promise<string> {
  return fetch(`${url}/metrics`).then((r) => r.text()).catch(() => '');
}

/** Soma uma métrica nas 3 instâncias (contadores são por processo). */
async function sumAcrossInstances(name: string): Promise<number> {
  const texts = await Promise.all(INSTANCES.map(scrape));
  return texts.reduce((s, t) => s + metric(t, name), 0);
}

/** Percentil (ex.: 0.95) de uma lista já ordenada. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

const fmt = (n: number, d = 1) => n.toFixed(d);

// ---------------------------------------------------------------- cenário

interface ScenarioResult {
  name: string;
  durationS: number;
  concurrency: number;
  wallets: number;
  requests: number;
  throughput: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  statusCounts: Record<string, number>;
  errorRate: number;
  businessRejections: number;
  replays: number;
  conflicts: number;
  conflictsPerRequest: number;
  maxOutboxLagS: number;
  maxOutboxPending: number;
  outboxDrainS: number;
}

async function scenario(name: string, walletCount: number, durationS: number, concurrency: number): Promise<ScenarioResult> {
  console.log(`\n▶ ${name}: ${concurrency} trabalhadores, ${walletCount} carteira(s), ${durationS}s`);

  // Preparação: carteiras com saldo alto (o objetivo é medir o caminho de sucesso, não recusas).
  const wallets: { id: string; playerId: string }[] = [];
  for (let i = 0; i < walletCount; i++) {
    const playerId = `load-${RUN}-${name}-${i}`;
    const r = await post('/wallets', { playerId, initialBalance: { amount: '1000000.00', currency: 'BRL' } });
    wallets.push({ id: r.body.id, playerId });
  }

  const conflictsBefore = await sumAcrossInstances('wallet_concurrency_conflicts_total');
  const latencies: number[] = [];
  const statusCounts: Record<string, number> = {};
  let replays = 0;
  let seq = 0;
  const sentKeys: { key: string; body: unknown }[] = [];

  // Amostragem do outbox lag durante o teste (a métrica é calculada no banco: vale para todas).
  let maxLag = 0;
  let maxPending = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const t = await scrape(INSTANCES[0]!);
      maxLag = Math.max(maxLag, metric(t, 'outbox_lag_seconds'));
      maxPending = Math.max(maxPending, metric(t, 'outbox_pending_events'));
      await Bun.sleep(500);
    }
  })();

  const deadline = performance.now() + durationS * 1000;
  const worker = async () => {
    while (performance.now() < deadline) {
      const w = wallets[Math.floor(Math.random() * wallets.length)]!;
      const roll = Math.random();
      let key: string;
      let body: unknown;
      // Mistura: 85% BET nova, 10% WIN nova, 5% REENVIO de uma já enviada (testa a idempotência sob carga).
      if (roll < 0.05 && sentKeys.length > 0) {
        ({ key, body } = sentKeys[Math.floor(Math.random() * sentKeys.length)]!);
      } else {
        const ext = `${RUN}-${name}-${++seq}`;
        key = `load:${ext}`;
        body = {
          providerId: 'load', externalTransactionId: ext, playerId: w.playerId, walletId: w.id,
          roundId: `round-${seq}`, gameId: 'load-game', kind: roll < 0.15 ? 'WIN' : 'BET',
          money: { amount: '1.00', currency: 'BRL' },
        };
        if (sentKeys.length < 5000) sentKeys.push({ key, body });
      }
      const start = performance.now();
      try {
        const r = await post('/wagering/transactions', body, { 'Idempotency-Key': key });
        statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
        if (r.body.idempotentReplay === true) replays++;
      } catch {
        statusCounts.network = (statusCounts.network ?? 0) + 1;
      }
      latencies.push(performance.now() - start);
    }
  };
  const startedAt = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedS = (performance.now() - startedAt) / 1000;

  // Quanto tempo a outbox leva para esvaziar depois que a carga para.
  const drainStart = performance.now();
  for (let i = 0; i < 240; i++) {
    if (metric(await scrape(INSTANCES[0]!), 'outbox_pending_events') === 0) break;
    await Bun.sleep(250);
  }
  const outboxDrainS = (performance.now() - drainStart) / 1000;
  sampling = false;
  await sampler;

  const conflicts = (await sumAcrossInstances('wallet_concurrency_conflicts_total')) - conflictsBefore;
  latencies.sort((a, b) => a - b);
  const requests = latencies.length;
  const ok = (statusCounts['201'] ?? 0) + (statusCounts['202'] ?? 0);
  const businessRejections = statusCounts['422'] ?? 0;
  const errors = requests - ok - businessRejections;

  const result: ScenarioResult = {
    name, durationS: elapsedS, concurrency, wallets: walletCount, requests,
    throughput: requests / elapsedS,
    p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99),
    max: latencies[latencies.length - 1] ?? 0,
    statusCounts, errorRate: requests ? errors / requests : 0, businessRejections, replays,
    conflicts, conflictsPerRequest: requests ? conflicts / requests : 0,
    maxOutboxLagS: maxLag, maxOutboxPending: maxPending, outboxDrainS,
  };
  console.log(
    `  ${requests} req · ${fmt(result.throughput)} req/s · p50 ${fmt(result.p50)} ms · p95 ${fmt(result.p95)} ms · ` +
      `p99 ${fmt(result.p99)} ms · erros ${fmt(result.errorRate * 100, 2)}% · conflitos ${conflicts} · ` +
      `outbox lag máx ${fmt(maxLag, 2)} s`,
  );
  return result;
}

// ---------------------------------------------------------------- execução

const ready = await fetch(`${BASE}/health/ready`).then((r) => r.ok).catch(() => false);
if (!ready) {
  console.error(`Sistema não está pronto em ${BASE}. Rode: docker compose up -d --build`);
  process.exit(1);
}

const environment = {
  date: new Date().toISOString(),
  cpu: `${os.cpus()[0]?.model ?? 'desconhecida'} (${os.cpus().length} threads)`,
  memoryGb: Math.round(os.totalmem() / 1024 ** 3),
  os: `${os.type()} ${os.release()}`,
  bun: Bun.version,
  target: `${BASE} (nginx → ${INSTANCES.length} instâncias)`,
};
console.log('Ambiente:', environment);

// Aquecimento curto (JIT, pools de conexão) — não entra nos resultados.
await scenario('aquecimento', 10, 3, 10);

const results = [
  await scenario('distribuido', WALLETS, DURATION_S, CONCURRENCY),
  await scenario('hot-wallet', 1, HOT_DURATION_S, HOT_CONCURRENCY),
];

// Consistência final: nenhuma divergência entre saldo e extrato depois da carga.
const recon = await post('/reconciliation/runs', {});
const divergences = (recon.body.divergences ?? []).length;
console.log(`\n▶ reconciliação: ${recon.body.checkedWallets} carteiras, ${divergences} divergências`);

// ---------------------------------------------------------------- relatório

const row = (r: ScenarioResult) =>
  `| ${r.name} | ${r.concurrency} | ${r.wallets} | ${fmt(r.durationS)} s | ${r.requests} | **${fmt(r.throughput)}** | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${fmt(r.max)} | ${fmt(r.errorRate * 100, 2)}% | ${r.conflicts} (${fmt(r.conflictsPerRequest, 2)}/req) | ${r.replays} | ${fmt(r.maxOutboxLagS, 2)} s / ${r.maxOutboxPending} | ${fmt(r.outboxDrainS, 1)} s |`;

const md = `# Resultados do teste de carga

> Gerado por \`bun run test:load\` em ${environment.date}. Análise em [LOAD_TEST.md](LOAD_TEST.md).

## Ambiente

| Item | Valor |
|---|---|
| CPU | ${environment.cpu} |
| Memória | ${environment.memoryGb} GB |
| Sistema | ${environment.os} |
| Bun | ${environment.bun} |
| Alvo | ${environment.target} |
| Observação | cliente de carga, 3 instâncias, PostgreSQL, MiniStack e nginx na **mesma máquina** (Docker Desktop) |

## Resultados

| Cenário | Concorrência | Carteiras | Duração | Requisições | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Taxa de erro | Conflitos de concorrência | Replays | Outbox lag máx / pendentes | Outbox esvazia em |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
${results.map(row).join('\n')}

Status HTTP por cenário: ${results.map((r) => `**${r.name}** ${JSON.stringify(r.statusCounts)}`).join(' · ')}

Reconciliação após a carga: **${recon.body.checkedWallets} carteiras, ${divergences} divergências**.
`;
await Bun.write(REPORT, md);
console.log(`\nRelatório salvo em ${REPORT}`);
process.exit(divergences === 0 ? 0 : 1);
