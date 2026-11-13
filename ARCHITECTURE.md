# Arquitetura — finance_service

Decisões técnicas, trade-offs e limitações. Setup e comandos: [README.md](README.md).

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Princípios](#2-princípios)
3. [Modelo de domínio](#3-modelo-de-domínio)
4. [Money e seu mapeamento](#4-money-e-seu-mapeamento)
5. [ORM e persistência](#5-orm-e-persistência)
6. [Invariantes no schema](#6-invariantes-no-schema)
7. [Estratégia transacional e de concorrência](#7-estratégia-transacional-e-de-concorrência)
8. [Idempotência e payloadHash](#8-idempotência-e-payloadhash)
9. [Regras de negócio e interpretações](#9-regras-de-negócio-e-interpretações)
10. [Códigos de falha](#10-códigos-de-falha)
11. [Referências fora de ordem](#11-referências-fora-de-ordem)
12. [Mensageria (SQS)](#12-mensageria-sqs)
13. [Outbox e eventos](#13-outbox-e-eventos)
14. [Contrato HTTP](#14-contrato-http)
15. [Extrato e reconciliação](#15-extrato-e-reconciliação)
16. [Observabilidade](#16-observabilidade)
17. [Autenticação](#17-autenticação)
18. [Testes](#18-testes)
19. [Limitações e próximos passos](#19-limitações-e-próximos-passos)

---

## 1. Visão geral

```
                 ┌─────────────┐             ┌──────────────────────────┐
 provedor ─HTTP─►│ nginx (lb)  │             │ wager-transactions.fifo  │◄─ provedor
                 └─────┬───────┘             └────────────┬─────────────┘
         ┌─────────────┼─────────────┐                    │
         ▼             ▼             ▼                    │
      app-1         app-2         app-3   ◄───────────────┘  (consumidor em cada uma)
         │  API · consumidor SQS · publicador da outbox · worker PENDING_REFERENCE
         └─────────────┼─────────────┘
                       ▼
                ┌─────────────┐   outbox    ┌───────────────────┐
                │ PostgreSQL  │────────────►│ wager-events.fifo │
                └─────────────┘  publisher  └───────────────────┘
```

As instâncias são idênticas e **sem estado em memória que afete a correção**: saldo, versão, chaves de idempotência, inbox e outbox estão no PostgreSQL.

**Três entradas, um caminho para o dinheiro.** HTTP, fila e o worker de referências pendentes chamam o mesmo `ProcessWagerService`, que usa as mesmas regras puras (`decideWager`) e o mesmo `applyOutcome`.

## 2. Princípios

1. **O banco é a última linha de defesa:** unicidade, imutabilidade e não-negatividade estão no schema, não só no código.
2. **Nada em memória como garantia:** idempotência, deduplicação e concorrência funcionam entre instâncias e após reinícios.
3. **Uma transação SQL por decisão:** transação de aposta, saldo, extrato, inbox e outbox são confirmados juntos ou nada.
4. **Domínio sem infraestrutura:** `src/domain` não importa NestJS nem MikroORM; regras testadas em milissegundos (85+ testes unitários).
5. **Falhar de forma explícita e classificável:** entrada inválida, conflito, rejeição, pendência e falha transitória têm respostas distintas.

## 3. Modelo de domínio

Todas as classes têm construtor `private` e factories estáticas (`create`/`from`/`open`/`receive`/`enqueue` para criar validando; `rehydrate` para reconstruir do banco **sem revalidar**).

| Classe | Arquivo | Pontos-chave |
|---|---|---|
| `Money` | [money.ts](src/domain/money/money.ts) | `from(MoneyProps)`, imutável, `bigint` em centavos |
| `Wallet` (aggregate root) | [wallet.ts](src/domain/wallet/wallet.ts) | `open` (versão 1), `credit`/`debit`/`reverseCredit` **devolvem o `WalletLedgerEntry`** — saldo e extrato nascem juntos |
| `WagerTransaction` | [wager-transaction.ts](src/domain/wager/wager-transaction.ts) | estados e transições explícitas; `InvalidTransactionStateError` |
| `WalletLedgerEntry` | [wallet-ledger-entry.ts](src/domain/ledger/wallet-ledger-entry.ts) | imutável (`readonly` + `Object.freeze`); `create` valida `balanceBefore ± money = balanceAfter` |
| `InboxMessage` / `OutboxMessage` | [messaging/](src/domain/messaging/) | `markProcessed`; `isDue`, `markPublished`, `scheduleRetry` (backoff) |
| `IntegrationEvent<T>` | [integration-event.ts](src/domain/events/integration-event.ts) | envelope abstrato; subclasses fixam `eventType`/`version` |

### Transições de `WagerTransaction`

```
 PENDING ─────────────────────► PROCESSED   (final)
    │  ╲──────────────────────► REJECTED    (final, failureCode)
    │   ╲─────────────────────► FAILED      (final, failureCode)
    ▼
 PENDING_REFERENCE ──┬────────► PROCESSED / REJECTED / FAILED
    ▲                │
    └────────────────┘ continua aguardando (nova tentativa)
```

`markProcessed`, `markPendingReference`, `reject` e `fail` lançam `InvalidTransactionStateError` se o estado já é final — é **erro de programação**, não caminho de negócio. A trigger `wager_tx_forbid_terminal_change` garante o mesmo no banco.

`affectsBalance()` é falso para `LOSS`; `requiresReference()` é verdadeiro para `REFUND` e `ROLLBACK`; `ledgerDirectionFor(reference)` devolve `DEBIT` para BET, `CREDIT` para WIN/REFUND/OPENING e o **inverso da referência** para ROLLBACK.

## 4. Money e seu mapeamento

| Camada | Representação | Por quê |
|---|---|---|
| Contratos (API, fila, eventos) | `{ "amount": "25.00", "currency": "BRL" }` | número JSON perde precisão antes do código ver |
| Domínio | `bigint` de unidades mínimas + `Currency` (código + escala) | aritmética exata e sem limite |
| Banco | `numeric(20,2)` + `char(3)` em colunas separadas | decimal exato do PostgreSQL |

- `Money.from` **rejeita** não-string, `""`, `NaN`, `Infinity`, `1e3`, vírgula, espaços, sinal e mais de 2 casas (nunca arredonda). Aceita 0–2 casas e serializa sempre com 2.
- Operações entre moedas diferentes lançam `CURRENCY_MISMATCH`. O modelo é multi-moeda (`Currency` com escala); só `BRL` está habilitada.
- **Mapeamento:** as colunas `numeric` são `decimal` no MikroORM, que as devolve como **string**; a conversão string ↔ `Money` acontece num só lugar, [mappers.ts](src/database/mappers.ts). O domínio não conhece tipos do ORM.

## 5. ORM e persistência

**MikroORM** (preferencial no desafio): `em.transactional()` dá a fronteira transacional explícita; dentro dela usamos `em.execute`/`nativeUpdate` nos pontos críticos para que o SQL que protege o dinheiro fique **visível** no código.

O domínio fica separado da persistência: as tabelas são mapeadas com `EntitySchema` (sem decorators nas classes de domínio) em *records* simples, e [mappers.ts](src/database/mappers.ts) converte nos dois sentidos. Custo: algum código de mapeamento. Ganho: domínio puro e testável.

**Migrations** em SQL explícito, versionadas e reversíveis (testado `down` até o início e `up` de novo). A migration 3 evoluiu o schema existente com *backfill* em vez de editar migrations já aplicadas.

## 6. Invariantes no schema

| Invariante | Mecanismo |
|---|---|
| saldo nunca negativo | `CHECK (balance >= 0)` |
| versão começa em 1 | `CHECK (version >= 1)`, default 1 |
| uma carteira por jogador + moeda | `UNIQUE (player_id, currency)` |
| Idempotency-Key única | `UNIQUE (idempotency_key)` em `wager_transactions` |
| provedor não repete id | `UNIQUE (provider_id, external_transaction_id)` |
| no máximo **um** lançamento por carteira + transação | `UNIQUE (wallet_id, transaction_id)` |
| um lançamento por versão | `UNIQUE (wallet_id, wallet_version)` |
| aritmética do lançamento | `CHECK` (`after = before ± amount`) |
| referência revertida **uma única vez** (REFUND **ou** ROLLBACK) | índice único parcial `wager_tx_single_reversal` |
| extrato imutável | trigger bloqueia `UPDATE`/`DELETE` |
| status final imutável | trigger em `wager_transactions` |
| REFUND/ROLLBACK com referência; rodada/jogo presentes; rejeição com motivo; valor > 0 (0 só em LOSS) | `CHECK`s |
| inbox única por consumidor | `PRIMARY KEY (consumer_name, message_id)` |

Todas testadas em [schema.test.ts](test/integration/schema.test.ts) gravando dados inválidos direto por SQL.

## 7. Estratégia transacional e de concorrência

**Unidade de concorrência: a carteira.** Sem lock global. Carteiras diferentes nunca se bloqueiam (testado com 10 carteiras × 5 apostas em paralelo).

**Optimistic locking com UPDATE condicional**, dentro de uma transação `READ COMMITTED`:

1. lê a carteira e guarda a `version` lida;
2. decide em memória (`decideWager`);
3. `UPDATE wallets SET balance = :novo, version = :lida + 1 WHERE id = :id AND version = :lida`;
4. **0 linhas** → outra operação mudou a carteira → a transação inteira é desfeita e recomeça, com backoff exponencial + jitter (5 → 200 ms), até 25 tentativas; esgotado → `503` (transitório, não rejeição).

`version` só muda quando o saldo muda (LOSS e rejeições não fazem UPDATE).

| | Otimista (escolhido) | Pessimista (`SELECT … FOR UPDATE`) |
|---|---|---|
| Caso comum | sem espera, sem lock durante a decisão | lock em toda operação |
| Carteira muito disputada | retries (medidos em `wallet_concurrency_conflicts_total`) | fila no banco, sem retries |
| Risco | starvation sob disputa extrema | conexões presas; deadlocks se a ordem variar |

Uma carteira é de um jogador; disputa extrema é rara. Mesmo assim, 50 envios simultâneos da mesma aposta e 30 apostas em 3 instâncias passam de forma estável. Trocar para `FOR UPDATE` seria localizado em `ProcessWagerService`.

**Outras corridas:** a mesma chave/transação em paralelo viola um `UNIQUE`, a tentativa é desfeita e a seguinte encontra a transação gravada → replay. Duas reversões da mesma referência alteram a mesma carteira (serializadas pela versão), e o índice `wager_tx_single_reversal` é a garantia final. Rejeições não fazem UPDATE na carteira: uma rejeição decidida enquanto outra operação altera o saldo equivale a ordená-la antes dessa operação — o saldo nunca é violado.

## 8. Idempotência e payloadHash

A **Idempotency-Key é a fonte da verdade** e fica na própria transação (`UNIQUE`). Fluxo, na mesma transação SQL:

1. **Fila:** `INSERT` na inbox `(consumer_name, message_id)` com `ON CONFLICT DO NOTHING`. Já existia → mesma mensagem: se o conteúdo diverge → `INBOX_PAYLOAD_MISMATCH` (DLQ); senão → replay.
2. Já existe transação com a chave → `matchesPayload(hash)`: igual → **replay**; diferente → `409 IDEMPOTENCY_KEY_REUSED`.
3. Já existe `(providerId, externalTransactionId)` com outra chave → mesmo conteúdo → replay; diferente → `409 PROVIDER_TRANSACTION_CONFLICT`.

**Replay devolve o resultado original**, inclusive o saldo observado na decisão (coluna `resulting_balance`), com `idempotentReplay: true` e o mesmo status HTTP. Para uma transação que estava `PENDING_REFERENCE` e já foi resolvida, o replay mostra o estado atual — mais útil ao provedor do que congelar a resposta 202.

### Algoritmo do payloadHash

```
payloadHash = "sha256:" + hex( SHA-256( canonicalJson(payload) ) )

payload = { providerId, externalTransactionId, playerId, walletId, roundId, gameId,
            kind, money: { amount (normalizado, 2 casas), currency },
            referenceExternalTransactionId (se houver) }

canonicalJson: chaves ordenadas em todos os níveis, sem espaços,
               null/undefined omitidos, arrays na ordem original
```

Ficam fora: header `Idempotency-Key`, `messageId`, `occurredAt` e qualquer metadado de transporte. `"80"` e `"80.00"` geram o mesmo hash. Implementação: [payload-hash.ts](src/domain/wager/payload-hash.ts).

Se dois pedidos com a mesma chave chegam juntos, o segundo bloqueia no `UNIQUE` até o commit do primeiro e então faz replay (testado com 50 simultâneos). A deduplicação do SQS FIFO (5 min, mesmo id) é só otimização.

## 9. Regras de negócio e interpretações

| Tipo | Saldo | Extrato | Referência |
|---|---|---|---|
| `OPENING` (interno) | crédito | 1 CREDIT | — (não aceito via API/fila) |
| `BET` | débito | 1 DEBIT | proibida |
| `WIN` | crédito | 1 CREDIT | opcional (BET da mesma rodada) |
| `LOSS` | — | — | opcional (BET da mesma rodada) |
| `REFUND` | crédito | 1 CREDIT | obrigatória: BET PROCESSED |
| `ROLLBACK` | inverso da referência | 1 invertido | obrigatória: BET, WIN ou REFUND PROCESSED |

A referência é resolvida por `(providerId, referenceExternalTransactionId)` e precisa ter mesmo provider, jogador, carteira, moeda e rodada. REFUND/ROLLBACK têm o **mesmo valor** da referência.

**Interpretações adotadas:**

1. **Uma referência é revertida no máximo uma vez, por REFUND ou por ROLLBACK** (não um de cada). Permitir os dois na mesma BET devolveria o dinheiro duas vezes (crédito duplicado). Garantido no domínio e no índice `wager_tx_single_reversal`. Desfazer um REFUND é um ROLLBACK *do REFUND*.
2. WIN/LOSS sobre uma BET já revertida → `REFERENCE_ALREADY_REVERSED`.
3. Referência que existe mas ainda não foi decidida (ex.: um WIN em `PENDING_REFERENCE`) é tratada como **ausente**: a transação aguarda, em vez de ser rejeitada prematuramente.
4. Vários WINs para a mesma BET são aceitos (jogos com múltiplos prêmios por rodada).
5. Rejeições são **gravadas** (auditáveis) e geram `WagerTransactionRejected`; não geram lançamento.
6. `FAILED` existe no modelo para falha técnica permanente; erros permanentes da fila vão para a DLQ sem criar transação quando não há carteira válida para referenciar.

## 10. Códigos de falha

Estáveis (contrato). A ação indica o que o provedor deve fazer.

| Código | HTTP | Ação do provedor |
|---|---|---|
| `INVALID_REQUEST`, `INVALID_AMOUNT`, `UNSUPPORTED_CURRENCY` | 400 | **corrigir** o payload |
| `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` | 404 | corrigir o identificador |
| `IDEMPOTENCY_KEY_REUSED`, `PROVIDER_TRANSACTION_CONFLICT`, `INBOX_PAYLOAD_MISMATCH` | 409 | **não reenviar**: a chave/id já foi usada com outro conteúdo |
| `WALLET_ALREADY_EXISTS` | 409 | usar a carteira existente |
| `CURRENCY_MISMATCH`, `PLAYER_MISMATCH`, `REFERENCE_MISMATCH`, `REFERENCE_INVALID_KIND`, `REVERSAL_AMOUNT_MISMATCH` | 422 | **corrigir** o payload |
| `INSUFFICIENT_FUNDS` | 422 | **desistir** (aposta sem saldo, rotina) |
| `REVERSAL_WOULD_OVERDRAW` | 422 | **desistir** e acionar operação: crédito já pago e gasto |
| `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED` | 422 | **desistir** (nada a pagar/reverter) |
| `REFERENCE_NOT_FOUND` | 422 (após 202) | **desistir** ou reenviar com nova chave depois de enviar a referência |
| `CONCURRENCY_RETRIES_EXHAUSTED`, `SERVICE_UNAVAILABLE` | 503 | **reenviar** com a mesma chave (seguro) |

## 11. Referências fora de ordem

Referência ausente → `PENDING_REFERENCE` (HTTP `202`, evento `WagerTransactionPendingReference`). Um worker em cada instância reprocessa as vencidas com `SELECT … FOR UPDATE SKIP LOCKED` (dois workers nunca pegam a mesma).

**Limite: 6 tentativas com backoff exponencial — 2 s, 4 s, 8 s, 16 s, 32 s — ≈ 1 min no total** (`PENDING_REFERENCE_MAX_ATTEMPTS`). Justificativa: provedores enviam as operações de uma rodada em segundos; a inversão de ordem vem de retries e paralelismo da entrega, não de atrasos longos. Um minuto cobre esses casos sem deixar a transação do provedor indefinida por muito tempo. Esgotado → `REJECTED` com `REFERENCE_NOT_FOUND` e evento `WagerTransactionRejected`.

## 12. Mensageria (SQS)

- Envelope `{ messageId, type: "WagerTransactionRequested", occurredAt, data }`; `data` passa pelo **mesmo parser e caso de uso do HTTP** e carrega a `idempotencyKey`.
- **Inbox** `(consumerName, messageId)` com o `messageId` do envelope (estável nas reentregas do produtor) e o hash do conteúdo.
- `MessageGroupId = walletId`: ordem por carteira; carteiras diferentes em paralelo.
- **Ack só depois do commit.** Crash entre commit e ack → reentrega → inbox reconhece (testado).

| Falha | Exemplo | Tratamento |
|---|---|---|
| Negócio | saldo insuficiente | não é falha: REJECTED gravado, ack |
| Permanente | JSON/envelope inválido, `OPENING`, carteira inexistente, conteúdo divergente | DLQ com `failureCode`/`failureReason`, removida da fila |
| Transitória | banco fora, conflitos esgotados, erro inesperado | sem ack; visibilidade com backoff (2, 4, 8 s…); após `maxReceiveCount` (5) o redrive leva para a DLQ |

**SIGTERM:** para de buscar mensagens, conclui as que estão em processamento e **devolve a visibilidade** (timeout 0) das recebidas e ainda não iniciadas; `stop_grace_period: 30s`.

## 13. Outbox e eventos

Banco e fila não compartilham transação: publicar antes do commit gera evento fantasma; publicar depois pode perder o evento. O evento é gravado em `outbox_events` **na mesma transação** e publicado depois.

- **Publicadores concorrentes:** `SELECT … WHERE published_at IS NULL AND next_attempt_at <= now() … FOR UPDATE SKIP LOCKED` — lotes disjuntos (testado com 3 publicadores).
- **Processo morre antes de publicar:** a conexão cai, o PostgreSQL desfaz e solta os locks; outra instância publica (testado matando a conexão com `pg_terminate_backend`).
- **At-least-once:** se cair entre enviar e marcar, reenvia com o mesmo `eventId` (`MessageDeduplicationId = eventId`; consumidor descarta pelo `eventId`).
- Envio em lotes de 10 (`SendMessageBatch`) em **faixas paralelas por `aggregateId`** (a mesma entidade fica sempre na mesma faixa e sai em ordem) e um único UPDATE para marcar os publicados. Falha parcial de um lote reagenda só as entradas falhas, e os lotes seguintes da faixa esperam.
- Falha de envio: `OutboxMessage.scheduleRetry` (2 s, 4 s… até 5 min).

Envelope `IntegrationEvent<T>`: `eventId`, `eventType`, `aggregateId`, `correlationId`, `causationId` (Idempotency-Key ou messageId que causou), `occurredAt` (ISO-8601), `version`, `data` (só `MoneyProps`, nunca `Money`). `WalletBalanceChanged.from(wallet, entry, ctx)` traz `direction`, `money`, `balanceBefore`, `balanceAfter`, `walletVersion` (permite ao consumidor ordenar e detectar lacunas).

## 14. Contrato HTTP

| Status | Situação | Reenviar? |
|---|---|---|
| 201 | PROCESSED | — |
| 202 | PENDING_REFERENCE (aceito, pendente) | consultar depois |
| 400 | payload inválido | não; corrigir |
| 404 | não encontrado | não |
| 409 | conflito de idempotência/provedor/carteira | não |
| 422 | REJECTED (regra de negócio) | não |
| 503 | falha transitória (`Retry-After`) | sim, com a mesma chave |

Dois filtros globais traduzem erros sem que o domínio conheça HTTP: `DomainErrorFilter` e `InfrastructureErrorFilter`.

## 15. Extrato e reconciliação

- **Extrato:** cursor opaco (base64url) sobre `wallet_version` — único e crescente por carteira, não repete nem pula linhas quando entram movimentos (diferente de OFFSET). `limit + 1` para saber se há próxima página.
- **Reconciliação** (`POST /wallets/:walletId/reconciliation`; `POST /reconciliation/runs` para todas): saldo reconstruído = Σ créditos − Σ débitos; versão esperada = maior `wallet_version` (1 se não houver lançamentos). Divergência → **log de erro + métrica + `reconciliation_divergences` + `consistent: false`**. Nunca corrige: esconderia a causa, apagaria a evidência e poderia piorar se o erro estiver no extrato.

## 16. Observabilidade

- Logs JSON (`JsonLogger`) com `correlationId` (`X-Correlation-Id` no HTTP), `messageId`, `transactionId`, `walletId`, `providerId`, via `AsyncLocalStorage`. Sem valores, saldos ou corpos.
- Métricas Prometheus: status por tipo/origem, rejeições por código, duplicatas, conflitos de concorrência, latência, mensagens por resultado, DLQ por motivo, retries de pendentes, publicações/falhas e **lag da outbox** (calculado no banco, global), divergências.
- `/health/live` (sem dependências) e `/health/ready` (banco + fila), abertos.

## 17. Autenticação

**Ponto de extensão explícito:** [`ProviderIdentityPort`](src/auth/provider-identity.ts) + [`ProviderAuthGuard`](src/auth/provider-auth.guard.ts) nos endpoints de negócio. A implementação ativa é `AnonymousProviderIdentity` (no-op): o guard não bloqueia nada. Health continua aberto; a fila é canal interno confiável, mas o `providerId` da mensagem passa pelas mesmas validações de domínio.

**Desenho adotado:** Identity Provider externo (Keycloak) no Compose, **OAuth2 client credentials** — cada provedor de jogos é um *client*. A implementação da porta valida o JWT (assinatura via JWKS, `iss`, `aud`, `exp`) e mapeia o client para o `providerId`; o guard já recusa (`403 PROVIDER_FORBIDDEN`) quando o `providerId` do corpo/rota difere do token. Reconciliação exigiria papel administrativo; `/metrics` ficaria na rede interna. Não pontua no desafio e foi priorizado depois da correção financeira.

## 18. Testes

| Nível | Onde | Infra |
|---|---|---|
| Unitário | `src/**/*.test.ts` | nenhuma |
| Integração | `test/integration/` | PostgreSQL + SQS reais (`finance_test`, filas `*-test.fifo`) |
| Concorrência | `wagering.concurrency`, `workers`, `crash-recovery` | 3 pools independentes, paralelismo real |
| Processos | `processes.test.ts` | **3 processos reais** da aplicação; SIGKILL e reinício |
| Sistema | `scripts/race-check.ts` | as 3 instâncias do Compose atrás do nginx |
| Carga | `bun run test:load` ([LOAD_TEST.md](docs/LOAD_TEST.md)) | ~250 req/s distribuído sem erros; hot wallet medido |

**Invariante final em todos os testes de integração** (`afterEach`): saldo == extrato reconstruído, versão coerente e extrato sem buracos.

Lições registradas: testes não dependem de `PurgeQueue` (assíncrono, uma vez a cada 60 s) e usam `MessageDeduplicationId` único por envio (o FIFO descarta repetidos por 5 min).

## 19. Limitações e próximos passos

| Limitação | Impacto | Próximo passo |
|---|---|---|
| Autenticação no-op | qualquer cliente pode enviar como qualquer provedor | implementar a porta com Keycloak (seção 17) |
| `numeric(20,2)` fixa 2 casas | outra escala exige migration | escala por moeda |
| Disputa extrema na mesma carteira | retries e latência; 503 após 25 tentativas | `FOR UPDATE` guiado pela métrica de conflitos |
| Ordem de eventos por entidade é melhor esforço | falha de um evento e sucesso do seguinte inverte a ordem | consumidor ordena por `walletVersion` |
| Inbox e transações crescem indefinidamente | disco | arquivamento/TTL da inbox |
| Reconciliação global é varredura síncrona | lenta com milhões de carteiras | incremental e agendada |
| Métricas por instância | somar no Prometheus | padrão do Prometheus |
| Hot wallet: ~3,4 conflitos/requisição, p99 ~2,5 s e 0,1–0,3% de 503 com 20 concorrentes na mesma carteira ([LOAD_TEST.md](docs/LOAD_TEST.md)) | latência sob disputa extrema | `FOR UPDATE` para carteiras quentes |
| Vazão da outbox no ambiente local limitada pelo MiniStack (~150 eventos/s, uma chamada por vez) | lag de eventos sob carga alta (o dinheiro e a API não são afetados) | medir contra SQS real/LocalStack |
| MiniStack em vez de LocalStack/AWS | diferenças sutis possíveis | validar em LocalStack/AWS |
