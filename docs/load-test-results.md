# Resultados do teste de carga

> Gerado por `bun run test:load` em 2026-11-13T19:17:41.608Z. Análise em [LOAD_TEST.md](LOAD_TEST.md).

## Ambiente

| Item | Valor |
|---|---|
| CPU | Intel(R) Core(TM) i5-1038NG7 CPU @ 2.00GHz (8 threads) |
| Memória | 16 GB |
| Sistema | Darwin 24.1.0 |
| Bun | 1.4.4 |
| Alvo | http://localhost:3000 (nginx → 3 instâncias) |
| Observação | cliente de carga, 3 instâncias, PostgreSQL, MiniStack e nginx na **mesma máquina** (Docker Desktop) |

## Resultados

| Cenário | Concorrência | Carteiras | Duração | Requisições | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Taxa de erro | Conflitos de concorrência | Replays | Outbox lag máx / pendentes | Outbox esvazia em |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| distribuido | 50 | 200 | 30.3 s | 7547 | **249.3** | 84.8 | 544.2 | 864.8 | 2052.5 | 0.00% | 315 (0.04/req) | 374 | 78.74 s / 12782 | 68.4 s |
| hot-wallet | 20 | 1 | 15.6 s | 1111 | **71.4** | 64.9 | 1332.7 | 2448.5 | 3884.8 | 0.18% | 3793 (3.41/req) | 49 | 115.29 s / 5836 | 48.2 s |

Status HTTP por cenário: **distribuido** {"201":7547} · **hot-wallet** {"201":1109,"503":2}

Reconciliação após a carga: **639 carteiras, 0 divergências**.
