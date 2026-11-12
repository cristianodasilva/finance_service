/**
 * Verificação de concorrência contra o sistema RODANDO (docker compose up).
 *
 * Dispara apostas simultâneas pelo balanceador (que distribui entre as 3 instâncias)
 * e confere as regras: nenhuma aposta além do saldo, saldo == extrato.
 *
 * Uso:  bun scripts/race-check.ts [url]      (padrão: http://localhost:3000)
 */
const BASE = process.argv[2] ?? 'http://localhost:3000';
const run = crypto.randomUUID().slice(0, 8);

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, upstream: res.headers.get('x-upstream'), body: (await res.json()) as any };
}

async function scenario(name: string, opening: string, bets: number, amount: string) {
  const playerId = `race-${run}-${name}`;
  const wallet = (await post('/wallets', { playerId, currency: 'BRL', initialBalance: opening })).body;

  // Todas as apostas disparadas AO MESMO TEMPO.
  const results = await Promise.all(
    Array.from({ length: bets }, (_, i) =>
      post(
        '/wagering/transactions',
        { provider: 'race', providerTransactionId: `${playerId}-bet-${i}`, kind: 'BET', playerId, walletId: wallet.id, currency: 'BRL', amount },
        { 'Idempotency-Key': `${playerId}-key-${i}` },
      ),
    ),
  );

  const count = (s: number) => results.filter((r) => r.status === s).length;
  const instances = new Set(results.map((r) => r.upstream));
  const final = (await (await fetch(`${BASE}/wallets/${wallet.id}`)).json()) as any;

  let ledgerTotal = 0n;
  let debits = 0;
  for (let cursor: string | null = null, first = true; first || cursor; first = false) {
    const page = (await (await fetch(`${BASE}/wallets/${wallet.id}/ledger?limit=200${cursor ? `&cursor=${cursor}` : ''}`)).json()) as any;
    for (const e of page.items) {
      const cents = BigInt(e.amount.replace('.', ''));
      ledgerTotal += e.direction === 'CREDIT' ? cents : -cents;
      if (e.direction === 'DEBIT') debits++;
    }
    cursor = page.nextCursor;
  }
  const ledgerBalance = `${ledgerTotal / 100n}.${(ledgerTotal % 100n).toString().padStart(2, '0')}`;

  console.log(`\n▶ ${name}: saldo inicial ${opening}, ${bets} BETs simultâneas de ${amount}`);
  console.log(`  instâncias que atenderam: ${[...instances].join(', ')}`);
  console.log(`  201 PROCESSED: ${count(201)}   422 REJECTED: ${count(422)}   outros: ${bets - count(201) - count(422)}`);
  console.log(`  saldo final: ${final.balance}   saldo pelo extrato: ${ledgerBalance}   débitos no extrato: ${debits}`);
  return { processed: count(201), balance: final.balance, ledgerBalance, debits };
}

const a = await scenario('obrigatorio', '100.00', 2, '80.00');
const b = await scenario('carga', '100.00', 60, '10.00');

const ok =
  a.processed === 1 && a.balance === '20.00' && a.debits === 1 && a.ledgerBalance === a.balance &&
  b.processed === 10 && b.balance === '0.00' && b.debits === 10 && b.ledgerBalance === b.balance;

const recon = (await post('/reconciliation/runs', {})).body;
console.log(`\n▶ reconciliação: ${recon.checkedWallets} carteiras conferidas, ${recon.divergences.length} divergências`);
console.log(ok && recon.divergences.length === 0 ? '\n✅ TODAS AS VERIFICAÇÕES PASSARAM' : '\n❌ ALGUMA VERIFICAÇÃO FALHOU');
process.exit(ok ? 0 : 1);
