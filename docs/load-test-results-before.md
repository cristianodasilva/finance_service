# Resultados do teste de carga

> Gerado por `bun run test:load` em 2026-11-13T19:09:20.984Z. Análise em [LOAD_TEST.md](LOAD_TEST.md).

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
| distribuido | 50 | 200 | 30.3 s | 7629 | **252.0** | 84.0 | 512.2 | 815.5 | 2187.2 | 0.00% | 358 (0.05/req) | 370 | 67.68 s / 11224 | 67.6 s |
| hot-wallet | 20 | 1 | 15.6 s | 1094 | **70.0** | 71.0 | 1341.8 | 2564.2 | 4200.3 | 0.09% | 3779 (3.45/req) | 50 | 7.84 s / 884 | 6.9 s |

Status HTTP por cenário: **distribuido** {"201":7629} · **hot-wallet** {"201":1093,"503":1}

Reconciliação após a carga: **217 carteiras, 0 divergências**.
