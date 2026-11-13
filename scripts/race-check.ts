/**
 * Verificação de concorrência contra o sistema RODANDO (docker compose up).
 * Dispara apostas simultâneas pelo balanceador (3 instâncias) e confere as regras.
 *
 * Uso:  bun scripts/race-check.ts [url]      (padrão: http://localhost:3000)
 */
const BASE = process.argv[2] ?? 'http://localhost:3000';
const run = crypto.randomUUID().slice(0, 8);

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, upstream: res.headers.get('x-upstream'), body: (await res.json()) as any };
}

async function scenario(name: string, opening: string, bets: number, amount: string, sameKey = false) {
  const playerId = `race-${run}-${name}`;
  const wallet = (await call('POST', '/wallets', { playerId, initialBalance: { amount: opening, currency: 'BRL' } })).body;
  const results = await Promise.all(
    Array.from({ length: bets }, (_, i) => {
      const externalTransactionId = sameKey ? `${playerId}-bet` : `${playerId}-bet-${i}`;
      return call(
        'POST',
        '/wagering/transactions',
        {
          providerId: 'race', externalTransactionId, playerId, walletId: wallet.id,
          roundId: 'round-1', gameId: 'race-game', kind: 'BET', money: { amount, currency: 'BRL' },
        },
        { 'Idempotency-Key': `race:${externalTransactionId}` },
      );
    }),
  );
  const n = (s: number) => results.filter((r) => r.status === s).length;
  const recon = (await call('POST', `/wallets/${wallet.id}/reconciliation`)).body;
  const replays = results.filter((r) => r.body.idempotentReplay === true).length;

  console.log(`\n▶ ${name}: saldo inicial ${opening}, ${bets} BETs simultâneas de ${amount}${sameKey ? ' (MESMA aposta)' : ''}`);
  console.log(`  instâncias que atenderam: ${[...new Set(results.map((r) => r.upstream))].join(', ')}`);
  console.log(`  201: ${n(201)}   422: ${n(422)}   replays: ${replays}   outros: ${bets - n(201) - n(422)}`);
  console.log(`  saldo: ${recon.storedBalance.amount}   pelo extrato: ${recon.calculatedBalance.amount}   lançamentos: ${recon.checkedEntries}   consistente: ${recon.consistent}`);
  return { n201: n(201), replays, balance: recon.storedBalance.amount, entries: recon.checkedEntries, consistent: recon.consistent };
}

const a = await scenario('obrigatorio', '100.00', 2, '80.00');
const b = await scenario('carga', '100.00', 60, '10.00');
const c = await scenario('mesma-aposta-50x', '100.00', 50, '30.00', true);

const ok =
  a.n201 === 1 && a.balance === '20.00' && a.entries === 2 && a.consistent &&
  b.n201 === 10 && b.balance === '0.00' && b.entries === 11 && b.consistent &&
  c.n201 === 50 && c.replays === 49 && c.balance === '70.00' && c.entries === 2 && c.consistent;

console.log(ok ? '\n✅ TODAS AS VERIFICAÇÕES PASSARAM' : '\n❌ ALGUMA VERIFICAÇÃO FALHOU');
process.exit(ok ? 0 : 1);
