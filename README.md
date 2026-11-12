# finance_service — Distributed Wagering Processor

Serviço de carteira e processamento de transações de aposta (BET, WIN, LOSS, REFUND, ROLLBACK), feito para continuar correto com **várias instâncias em paralelo**, **mensagens duplicadas ou fora de ordem** e **falhas no meio do processamento**.

- **Stack:** Bun 1.4 · TypeScript (strict) · NestJS 12 · MikroORM 7 · PostgreSQL 18 · AWS SQS FIFO (MiniStack) · Docker Compose
- **Decisões, trade-offs e limitações:** ver [ARCHITECTURE.md](ARCHITECTURE.md)

---

## Sumário

1. [Pré-requisitos](#pré-requisitos)
2. [Subindo tudo com Docker (3 instâncias)](#subindo-tudo-com-docker-3-instâncias)
3. [Rodando localmente (desenvolvimento)](#rodando-localmente-desenvolvimento)
4. [Testes](#testes)
5. [API](#api)
6. [Fila SQS](#fila-sqs)
7. [Observabilidade](#observabilidade)
8. [Comandos úteis](#comandos-úteis)
9. [Estrutura do projeto](#estrutura-do-projeto)

---

## Pré-requisitos

| Ferramenta | Versão usada |
|---|---|
| [Bun](https://bun.sh) | 1.4.4 |
| Docker + Docker Compose | Compose v2 |

> **Sobre o LocalStack:** as versões atuais do LocalStack exigem token de conta para rodar. Por isso usamos o **MiniStack** (open-source, MIT), que expõe a mesma API da AWS na porta 4566 — alternativa permitida pelo desafio.

---

## Subindo tudo com Docker (3 instâncias)

```bash
docker compose up -d --build
```

Isso sobe, nesta ordem:

```
postgres ──┐
aws ───────┼─► aws-init (cria as filas) ─┐
           └─► migrate (roda migrations) ┴─► app-1, app-2, app-3 ─► lb (nginx)
```

| Endereço | O que é |
|---|---|
| `http://localhost:3000` | balanceador (nginx, round-robin entre as 3 instâncias) |
| `http://localhost:3001` · `3002` · `3003` | cada instância diretamente |
| `localhost:5432` | PostgreSQL (`finance` / `finance`, banco `finance`) |
| `http://localhost:4566` | SQS (MiniStack) |

Cada instância roda **API HTTP + consumidor SQS + publicador da outbox + worker de PENDING_REFERENCE**. A resposta do balanceador traz o header `X-Upstream` com a instância que atendeu.

### Verificação de concorrência no sistema rodando

```bash
bun install            # só na primeira vez
bun scripts/race-check.ts
```

Dispara, pelo balanceador, o **cenário obrigatório** (2 BETs de 80.00 simultâneas sobre 100.00) e um cenário de carga (60 BETs de 10.00 sobre 100.00), e confere saldo, extrato e reconciliação:

```
▶ obrigatorio: saldo inicial 100.00, 2 BETs simultâneas de 80.00
  201 PROCESSED: 1   422 REJECTED: 1
  saldo final: 20.00   saldo pelo extrato: 20.00   débitos no extrato: 1
▶ carga: saldo inicial 100.00, 60 BETs simultâneas de 10.00
  instâncias que atenderam: 172.20.0.4:3000, 172.20.0.5:3000, 172.20.0.6:3000
  201 PROCESSED: 10   422 REJECTED: 50
  saldo final: 0.00   saldo pelo extrato: 0.00   débitos no extrato: 10
✅ TODAS AS VERIFICAÇÕES PASSARAM
```

### Desligar

```bash
docker compose down        # mantém os dados
docker compose down -v     # apaga também o banco
```

---

## Rodando localmente (desenvolvimento)

```bash
bun install
cp .env.example .env
docker compose up -d postgres aws aws-init   # só a infraestrutura
bun run migration:up
bun run dev                                   # logs coloridos, reinicia ao salvar
```

> Se as 3 instâncias do Docker estiverem no ar, a porta 3000 já é do balanceador: use `PORT=4000 bun run dev`.

### Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `DATABASE_URL` | `postgresql://finance:finance@localhost:5432/finance` | PostgreSQL |
| `AWS_ENDPOINT_URL` | `http://localhost:4566` | endpoint SQS (MiniStack) |
| `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `us-east-1` / `test` / `test` | credenciais (fictícias no MiniStack) |
| `SQS_WAGER_QUEUE_URL` | `.../wager-transactions.fifo` | fila de entrada |
| `SQS_WAGER_DLQ_URL` | `.../wager-transactions-dlq.fifo` | DLQ da fila de entrada |
| `SQS_EVENTS_QUEUE_URL` | `.../wager-events.fifo` | fila onde a outbox publica os eventos |
| `SQS_CONSUMER_ENABLED` | `true` | liga o consumidor nesta instância |
| `OUTBOX_PUBLISHER_ENABLED` | `true` | liga o publicador da outbox |
| `PENDING_REFERENCE_WORKER_ENABLED` | `true` | liga o worker de PENDING_REFERENCE |
| `PENDING_REFERENCE_MAX_ATTEMPTS` | `6` | tentativas antes de rejeitar com `REFERENCE_NOT_FOUND` |
| `LOG_FORMAT` | `json` | `pretty` para logs coloridos do Nest |
| `DEBUG_SQL` | `false` | mostra os SQLs gerados |

---

## Testes

```bash
docker compose up -d postgres aws aws-init   # os testes usam PostgreSQL e SQS reais
bun test                                     # tudo (72 testes)
bun run test:unit                            # só unitários (sem banco)
bun run test:integration                     # só integração
```

- **Banco e filas isolados:** os testes usam o banco `finance_test` (criado e migrado automaticamente) e filas `*-test.fifo` (criadas pelo [test/support/env.ts](test/support/env.ts)). Podem rodar com as 3 instâncias do Docker no ar.
- **Sem mocks totais:** a integração roda contra o PostgreSQL e o SQS de verdade. Para simular "várias instâncias", os testes abrem **3 conexões independentes** com o banco (cada uma com seu próprio pool e memória).

| Arquivo | O que cobre |
|---|---|
| [money.test.ts](src/domain/money/money.test.ts) | `Money`: precisão, parsing, imutabilidade, moeda |
| [wallet.test.ts](src/domain/wallet/wallet.test.ts) | `Wallet`: crédito, débito, estorno, versão |
| [wager-rules.test.ts](src/domain/wager/wager-rules.test.ts) | regras de BET / WIN / LOSS / REFUND / ROLLBACK e referências |
| [wagering.concurrency.test.ts](test/integration/wagering.concurrency.test.ts) | **cenário obrigatório**, 30 BETs em 3 instâncias, ROLLBACK duplicado, idempotência |
| [wager-queue.consumer.test.ts](test/integration/wager-queue.consumer.test.ts) | consumidor SQS: ordem, duplicatas, DLQ |
| [workers.test.ts](test/integration/workers.test.ts) | 3 publicadores concorrentes da outbox; PENDING_REFERENCE |
| [crash-recovery.test.ts](test/integration/crash-recovery.test.ts) | crash após commit (ack perdido; evento enviado e não marcado) |
| [ledger-reconciliation.test.ts](test/integration/ledger-reconciliation.test.ts) | paginação por cursor; reconciliação sinaliza sem corrigir |

Em todos os testes de concorrência é verificado o invariante final: **saldo da carteira == saldo reconstruído pelo extrato**.

---

## API

Dinheiro é sempre **string decimal com 2 casas** (`"100.00"`). Números JSON (`100.5`) e mais de 2 casas (`"10.999"`) são recusados com `400`.

### Carteiras

```bash
# Abrir carteira (com saldo inicial → transação OPENING + crédito no extrato)
curl -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","currency":"BRL","initialBalance":"100.00"}'

curl localhost:3000/wallets/{id}                          # consultar
curl 'localhost:3000/wallets?playerId=player-1'           # carteiras do jogador
curl 'localhost:3000/wallets/{id}/ledger?limit=50'        # extrato (mais recente primeiro)
curl 'localhost:3000/wallets/{id}/ledger?limit=50&cursor={nextCursor}'   # próxima página
```

### Transações de aposta

```bash
curl -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: 7f9c2b1e-0001' \
  -d '{
    "provider": "provider-x",
    "providerTransactionId": "bet-1001",
    "kind": "BET",
    "playerId": "player-1",
    "walletId": "{id}",
    "currency": "BRL",
    "amount": "80.00",
    "roundId": "round-55"
  }'
```

| Campo | Obrigatório | Observação |
|---|---|---|
| `provider`, `providerTransactionId` | sim | únicos juntos |
| `kind` | sim | `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` |
| `playerId`, `walletId`, `currency`, `amount` | sim | `amount` > 0 (LOSS aceita `"0.00"`) |
| `roundId` | não | se informado nos dois lados, a referência precisa ser da mesma rodada |
| `referenceProviderTransactionId` | WIN, LOSS, REFUND, ROLLBACK | `providerTransactionId` da transação referenciada |

```bash
curl localhost:3000/wagering/transactions/{id}
curl 'localhost:3000/wagering/transactions?provider=provider-x&providerTransactionId=bet-1001'
```

### Códigos HTTP

| Status | Significado | Exemplo |
|---|---|---|
| `201` | **PROCESSED** — aplicada | BET com saldo |
| `202` | **PENDING_REFERENCE** — aceita, aguardando a referência | WIN antes da BET |
| `400` | entrada inválida | sem `Idempotency-Key`, valor `10.999`, moeda `USD` |
| `404` | não encontrado | carteira inexistente |
| `409` | conflito | mesma `Idempotency-Key` com outro conteúdo (`IDEMPOTENCY_KEY_REUSED`) |
| `422` | **REJECTED** — regra de negócio recusou | `INSUFFICIENT_FUNDS`, `ALREADY_ROLLED_BACK` |
| `503` | falha temporária de infraestrutura (`Retry-After: 1`) | banco fora, conflitos esgotados |

Repetir a mesma requisição com a mesma `Idempotency-Key` devolve **o mesmo status e corpo**, com o header `Idempotent-Replayed: true`.

### Reconciliação, saúde e métricas

```bash
curl -X POST localhost:3000/reconciliation/runs      # confere saldo × extrato de todas as carteiras
curl localhost:3000/reconciliation/divergences       # divergências abertas (nunca corrigidas automaticamente)
curl localhost:3000/health/live                      # processo vivo
curl localhost:3000/health/ready                     # banco e fila acessíveis (503 se não)
curl localhost:3000/metrics                          # métricas Prometheus
```

---

## Fila SQS

| Fila | Uso |
|---|---|
| `wager-transactions.fifo` | entrada de transações (mesmo formato do corpo do POST) |
| `wager-transactions-dlq.fifo` | mensagens que não podem ser processadas (`failureCode` nos atributos) |
| `wager-events.fifo` | eventos publicados pela outbox |

Enviar uma transação pela fila (simula o provedor):

```bash
bun scripts/send-wager.ts '{"provider":"provider-x","providerTransactionId":"bet-2001","kind":"BET","playerId":"player-1","walletId":"{id}","currency":"BRL","amount":"10.00"}'
```

O `MessageGroupId` é o `walletId` (ordem por carteira) e o `MessageDeduplicationId` é `provider:providerTransactionId`.

### Eventos publicados

Todos usam o mesmo envelope (`eventId`, `eventType`, `eventVersion`, `aggregateType`, `aggregateId`, `occurredAt`, `payload`):

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | transação aplicada |
| `WagerTransactionRejected` | recusada (com `failureCode`) |
| `WagerTransactionPendingReference` | aguardando referência |
| `WalletBalanceChanged` | **somente** quando o saldo muda (`previousBalance`, `newBalance`, `walletVersion`) |

Entrega **at-least-once**: consumidores devem descartar repetições pelo `eventId`.

---

## Observabilidade

- **Logs:** uma linha JSON por evento, com `correlationId` (header `X-Correlation-Id` no HTTP; `messageId` na fila) e, quando conhecidos, `walletId`, `providerTransactionId`, `transactionId`. Valores, saldos e corpos de requisição **não** são logados.
- **Métricas** (`GET /metrics`):

| Métrica | Tipo |
|---|---|
| `wager_transactions_total{kind,status,source}` | counter |
| `wager_rejections_total{failure_code}` | counter |
| `wager_duplicates_total{source}` | counter |
| `wallet_concurrency_conflicts_total` | counter |
| `wager_processing_duration_seconds{source}` | histogram |
| `sqs_messages_total{outcome}` / `sqs_dead_lettered_total{reason}` | counter |
| `pending_reference_retries_total{result}` | counter |
| `outbox_published_total{event_type}` / `outbox_publish_failures_total` | counter |
| `outbox_pending_events` / `outbox_lag_seconds` | gauge |
| `reconciliation_divergences_total` | counter |

---

## Comandos úteis

| Comando | O que faz |
|---|---|
| `bun run dev` | API em modo desenvolvimento |
| `bun run start` | API (logs JSON) |
| `bun run typecheck` | checagem de tipos (`tsc --noEmit`, strict) |
| `bun test` | todos os testes |
| `bun run migration:up` / `migration:down` / `migration:list` | migrations |
| `bun scripts/race-check.ts [url]` | verificação de concorrência no sistema rodando |
| `bun scripts/send-wager.ts '<json>'` | envia transação pela fila |
| `docker compose logs -f app-1` | logs de uma instância |

---

## Estrutura do projeto

```
src/
  domain/            regras de negócio puras (sem banco): Money, Wallet, decideWager
  wallets/           abertura de carteira, consulta, extrato paginado
  wagering/          processamento de transações (HTTP + caso de uso compartilhado)
  messaging/         consumidor SQS e classificação de erros
  workers/           publicador da outbox e worker de PENDING_REFERENCE
  reconciliation/    conferência saldo × extrato
  events/            envelope abstrato e eventos tipados
  outbox/            gravação de eventos na mesma transação
  observability/     logs JSON, contexto de correlação, métricas
  database/          configuração do MikroORM e mapeamento das tabelas
  health/            /health/live e /health/ready
migrations/          migrations versionadas e reversíveis (SQL explícito)
test/                testes de integração e utilitários
scripts/             race-check e envio para a fila
infra/               criação das filas e configuração do nginx
```
