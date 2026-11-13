# finance_service — Distributed Wagering Processor

Serviço de carteira e processamento de transações de aposta (BET, WIN, LOSS, REFUND, ROLLBACK), correto com **várias instâncias em paralelo**, **mensagens duplicadas ou fora de ordem** e **processos que morrem antes ou depois do commit**.

- **Stack:** Bun 1.4 · TypeScript (strict) · NestJS 12 · MikroORM 7 · PostgreSQL 18 · AWS SQS FIFO (MiniStack) · Docker Compose
- **Decisões, trade-offs e limitações:** [ARCHITECTURE.md](ARCHITECTURE.md)
- **Teste de carga (metodologia e análise):** [docs/LOAD_TEST.md](docs/LOAD_TEST.md)

## Sumário

1. [Pré-requisitos](#pré-requisitos)
2. [Subindo tudo com Docker (3 instâncias)](#subindo-tudo-com-docker-3-instâncias)
3. [Rodando localmente](#rodando-localmente)
4. [Testes](#testes)
5. [API HTTP](#api-http)
6. [Fila SQS](#fila-sqs)
7. [Eventos publicados](#eventos-publicados)
8. [Observabilidade](#observabilidade)
9. [Comandos úteis](#comandos-úteis)
10. [Estrutura do projeto](#estrutura-do-projeto)

---

## Pré-requisitos

| Ferramenta | Versão usada |
|---|---|
| [Bun](https://bun.sh) | 1.4.4 |
| Docker + Docker Compose | Compose v2 |

> **LocalStack × MiniStack:** as versões atuais do LocalStack exigem token de conta. Usamos o **MiniStack** (open-source, MIT), que expõe a API da AWS na porta 4566 — alternativa prevista no desafio.

## Subindo tudo com Docker (3 instâncias)

```bash
docker compose up -d --build
```

```
postgres ──┐
aws ───────┼─► aws-init (cria as filas) ─┐
           └─► migrate (roda migrations) ┴─► app-1, app-2, app-3 ─► lb (nginx)
```

| Endereço | O que é |
|---|---|
| `http://localhost:3000` | balanceador nginx (round-robin entre as 3 instâncias; header `X-Upstream` mostra quem atendeu) |
| `http://localhost:3001` · `3002` · `3003` | cada instância |
| `localhost:5432` | PostgreSQL (`finance` / `finance`) |
| `http://localhost:4566` | SQS (MiniStack) |

Cada instância roda **API + consumidor SQS + publicador da outbox + worker de PENDING_REFERENCE**.

### Verificação de concorrência no sistema rodando

```bash
bun install
bun scripts/race-check.ts
```

```
▶ obrigatorio: saldo inicial 100.00, 2 BETs simultâneas de 80.00
  201: 1   422: 1   replays: 0
  saldo: 20.00   pelo extrato: 20.00   lançamentos: 2   consistente: true
▶ carga: saldo inicial 100.00, 60 BETs simultâneas de 10.00
  instâncias que atenderam: 172.20.0.4:3000, 172.20.0.6:3000, 172.20.0.5:3000
  201: 10   422: 50
  saldo: 0.00   pelo extrato: 0.00   lançamentos: 11   consistente: true
▶ mesma-aposta-50x: saldo inicial 100.00, 50 BETs simultâneas de 30.00 (MESMA aposta)
  201: 50   replays: 49
  saldo: 70.00   pelo extrato: 70.00   lançamentos: 2   consistente: true
✅ TODAS AS VERIFICAÇÕES PASSARAM
```

```bash
docker compose down        # mantém os dados
docker compose down -v     # apaga também o banco
```

## Rodando localmente

```bash
bun install
cp .env.example .env
docker compose up -d postgres aws aws-init
bun run migration:up
bun run dev                 # logs coloridos; reinicia ao salvar
```

> Com as 3 instâncias do Docker no ar, a porta 3000 é do balanceador: use `PORT=4000 bun run dev`.

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `DATABASE_URL` | `postgresql://finance:finance@localhost:5432/finance` | PostgreSQL |
| `AWS_ENDPOINT_URL` / `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `http://localhost:4566` / `us-east-1` / `test` / `test` | SQS (MiniStack) |
| `SQS_WAGER_QUEUE_URL` / `SQS_WAGER_DLQ_URL` | `.../wager-transactions.fifo` / `.../wager-transactions-dlq.fifo` | entrada e DLQ |
| `SQS_EVENTS_QUEUE_URL` | `.../wager-events.fifo` | saída dos eventos da outbox |
| `SQS_CONSUMER_NAME` | `wager-transactions-consumer` | parte da chave da inbox |
| `SQS_CONSUMER_ENABLED` / `OUTBOX_PUBLISHER_ENABLED` / `PENDING_REFERENCE_WORKER_ENABLED` | `true` | liga cada processo de fundo |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `6` | tentativas antes de `REFERENCE_NOT_FOUND` |
| `LOG_FORMAT` | `json` | `pretty` para logs coloridos |
| `DEBUG_SQL` | `false` | mostra os SQLs |

## Testes

```bash
docker compose up -d postgres aws aws-init   # integração usa PostgreSQL e SQS reais
bun test                                     # tudo: 126 testes (~40 s)
bun run test:unit                            # só domínio (sem infraestrutura)
bun run test:integration
bun run test:load                            # teste de carga contra o docker compose (ver docs/LOAD_TEST.md)
```

- **Isolamento:** banco `finance_test` (criado e migrado automaticamente) e filas `*-test.fifo`. Podem rodar com o Docker no ar.
- **Sem mocks de infraestrutura:** PostgreSQL e SQS de verdade. "Instâncias" = pools de conexão independentes; o teste de processos sobe **3 processos reais** da aplicação.
- **Invariante final em todos os testes de integração** (`afterEach`): para cada carteira, saldo == saldo reconstruído pelo extrato, versão coerente e extrato sem buracos.

| Arquivo | Cobre |
|---|---|
| `src/domain/**/*.test.ts` | `Money` (escala, entradas inválidas, conflito de moeda), `Wallet`, `WagerTransaction` (transições), `WalletLedgerEntry`, regras dos 5 tipos, `payloadHash`, inbox/outbox, eventos |
| [schema.test.ts](test/integration/schema.test.ts) | migrations reversíveis e cada constraint do schema |
| [wagering.concurrency.test.ts](test/integration/wagering.concurrency.test.ts) | **cenário obrigatório**, mesma aposta 50×, 30 apostas em 3 instâncias, carteiras distintas em paralelo, REFUND+ROLLBACK simultâneos, replay com saldo original, conflitos |
| [atomicity.test.ts](test/integration/atomicity.test.ts) | falha na outbox desfaz transação, saldo, extrato e inbox |
| [wager-queue.consumer.test.ts](test/integration/wager-queue.consumer.test.ts) | inbox e redelivery, payload divergente, erros permanentes → DLQ, erro temporário → retry → DLQ, SIGTERM |
| [workers.test.ts](test/integration/workers.test.ts) | 3 publicadores concorrentes, REFUND/ROLLBACK antes da referência, `REFERENCE_NOT_FOUND` |
| [crash-recovery.test.ts](test/integration/crash-recovery.test.ts) | worker morto após commit e antes do ack; publicador morto antes de publicar |
| [ledger-reconciliation.test.ts](test/integration/ledger-reconciliation.test.ts) | cursor do extrato; reconciliação consistente/divergente |
| [processes.test.ts](test/integration/processes.test.ts) | **3 processos reais**; SIGKILL durante o consumo e reinício com consistência final |

## API HTTP

Dinheiro sempre como `{ "amount": "25.00", "currency": "BRL" }` (string com 2 casas). Número JSON, mais de 2 casas, negativo, `NaN`, notação científica → `400`.

### Carteiras

```bash
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
# → 201 {"id":"…","playerId":"player-1","balance":{"amount":"1000.00","currency":"BRL"},"version":1,…}

curl localhost:3000/wallets/{walletId}
curl 'localhost:3000/wallets/{walletId}/ledger?limit=50'             # mais recente primeiro
curl 'localhost:3000/wallets/{walletId}/ledger?limit=50&cursor={nextCursor}'
curl -X POST localhost:3000/wallets/{walletId}/reconciliation
# → {"walletId":"…","storedBalance":{…},"calculatedBalance":{…},"difference":{…},"consistent":true,"checkedEntries":42,…}
```

Saldo inicial > 0 cria a transação interna `OPENING` e o lançamento `CREDIT` na mesma transação SQL. Segunda carteira para o mesmo `playerId` + moeda → `409 WALLET_ALREADY_EXISTS`.

### Transações

```bash
curl -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "player-1",
    "walletId": "{walletId}",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
# → 201 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}

curl localhost:3000/wagering/transactions/{transactionId}
curl localhost:3000/providers/provider-a/wagering/transactions/transaction-123
```

`referenceExternalTransactionId` é obrigatório em `REFUND` e `ROLLBACK`, opcional em `WIN`/`LOSS` e proibido em `BET`. Rejeições trazem `failureCode` (taxonomia no ARCHITECTURE.md).

**Idempotência:** o header `Idempotency-Key` é obrigatório e é a fonte da verdade (padrão recomendado `"{providerId}:{externalTransactionId}"`). Requisição idêntica → mesma resposta com `idempotentReplay: true` (inclusive o saldo observado na primeira vez). Mesma chave com payload diferente → `409 IDEMPOTENCY_KEY_REUSED`.

| Status | Significa |
|---|---|
| `201` | **PROCESSED** |
| `202` | **PENDING_REFERENCE** — aceita, processamento pendente |
| `400` | payload inválido |
| `404` | carteira/transação inexistente |
| `409` | conflito (idempotência, provedor, carteira duplicada) |
| `422` | **REJECTED** por regra de negócio (`failureCode`) |
| `503` | falha transitória de infraestrutura (`Retry-After`) |

### Saúde e operação

```bash
curl localhost:3000/health/live            # processo vivo
curl localhost:3000/health/ready           # PostgreSQL e SQS alcançáveis (503 se não)
curl localhost:3000/metrics                # Prometheus
curl -X POST localhost:3000/reconciliation/runs     # todas as carteiras
curl localhost:3000/reconciliation/divergences      # divergências abertas (nunca corrigidas sozinhas)
```

## Fila SQS

Filas: `wager-transactions.fifo` (entrada), `wager-transactions-dlq.fifo` (DLQ, motivo em `failureCode`/`failureReason`), `wager-events.fifo` (eventos da outbox).

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "player-1",
    "walletId": "{walletId}",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

```bash
# Monta o envelope e envia (MessageGroupId = walletId):
bun scripts/send-wager.ts '{"providerId":"provider-a","externalTransactionId":"bet-2001","playerId":"player-1","walletId":"{walletId}","roundId":"r1","gameId":"fortune-chimp","kind":"BET","money":{"amount":"10.00","currency":"BRL"}}'
```

## Eventos publicados

Envelope comum (`IntegrationEvent<T>`): `eventId`, `eventType`, `aggregateId`, `correlationId`, `causationId`, `occurredAt`, `version`, `data`.

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | transação aplicada, inclusive `LOSS` |
| `WagerTransactionRejected` | rejeição por regra de negócio (inclui `REFERENCE_NOT_FOUND`) |
| `WalletBalanceChanged` | somente quando o saldo muda — `direction`, `money`, `balanceBefore`, `balanceAfter`, `walletVersion` |
| `WagerTransactionPendingReference` | referência ausente |

Entrega **at-least-once**: consumidores descartam repetições pelo `eventId`.

## Observabilidade

- **Logs JSON** com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`. Sem valores, saldos ou corpos de requisição.
- **Métricas** (`/metrics`): `wager_transactions_total{kind,status,source}`, `wager_rejections_total{failure_code}`, `wager_duplicates_total`, `wallet_concurrency_conflicts_total`, `wager_processing_duration_seconds`, `sqs_messages_total{outcome}`, `sqs_dead_lettered_total{reason}`, `pending_reference_retries_total`, `outbox_published_total`, `outbox_publish_failures_total`, `outbox_pending_events`, `outbox_lag_seconds`, `reconciliation_divergences_total`.

## Comandos úteis

| Comando | O que faz |
|---|---|
| `bun run dev` / `bun run start` | API (dev / logs JSON) |
| `bun run typecheck` | `tsc --noEmit` (strict) |
| `bun test` | todos os testes |
| `bun run migration:up` / `migration:down` / `migration:list` | migrations |
| `bun scripts/race-check.ts [url]` | concorrência no sistema rodando |
| `bun run test:load` | teste de carga (gera `docs/load-test-results.md`; análise em `docs/LOAD_TEST.md`) |
| `bun scripts/send-wager.ts '<json>'` | envia pela fila |
| `docker compose logs -f app-1` | logs de uma instância |

## Estrutura do projeto

```
src/
  domain/           regras puras: Money, Wallet, WagerTransaction, WalletLedgerEntry,
                    decideWager, payloadHash, InboxMessage, OutboxMessage, IntegrationEvent
  database/         MikroORM (EntitySchema), mapeamento banco ↔ domínio, gravação na outbox
  wallets/          abertura, consulta, extrato
  wagering/         caso de uso compartilhado (HTTP + fila), parser e respostas
  messaging/        consumidor SQS, envelope, classificação de falhas
  workers/          publicador da outbox, worker de PENDING_REFERENCE
  reconciliation/   saldo × extrato
  auth/             ponto de extensão da autenticação (ProviderIdentityPort + guard)
  observability/    logs JSON, contexto de correlação, métricas
  health/           /health/live, /health/ready
migrations/         versionadas e reversíveis (SQL explícito)
test/               integração e utilitários
scripts/            race-check, send-wager
infra/              filas e nginx
```
