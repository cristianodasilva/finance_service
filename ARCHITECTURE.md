# Arquitetura — finance_service

Este documento explica **as decisões técnicas, os trade-offs e as limitações conhecidas**. O guia de setup está no [README.md](README.md).

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Princípios](#2-princípios)
3. [Dinheiro (`Money`)](#3-dinheiro-money)
4. [Modelo de domínio e escolha do ORM](#4-modelo-de-domínio-e-escolha-do-orm)
5. [Invariantes garantidos pelo banco](#5-invariantes-garantidos-pelo-banco)
6. [Estratégia transacional e concorrência](#6-estratégia-transacional-e-concorrência)
7. [Idempotência e deduplicação](#7-idempotência-e-deduplicação)
8. [Regras de negócio e ciclo de vida da transação](#8-regras-de-negócio-e-ciclo-de-vida-da-transação)
9. [Mensageria (SQS)](#9-mensageria-sqs)
10. [Outbox e eventos](#10-outbox-e-eventos)
11. [Contrato HTTP e classificação de erros](#11-contrato-http-e-classificação-de-erros)
12. [Extrato e reconciliação](#12-extrato-e-reconciliação)
13. [Observabilidade](#13-observabilidade)
14. [Autenticação](#14-autenticação)
15. [Estratégia de testes](#15-estratégia-de-testes)
16. [Limitações conhecidas e próximos passos](#16-limitações-conhecidas-e-próximos-passos)

---

## 1. Visão geral

```
                 ┌───────────────┐            ┌───────────────────────────┐
 provedor ─HTTP─►│ nginx (lb)    │            │ wager-transactions.fifo   │◄─ provedor
                 └──────┬────────┘            └─────────────┬─────────────┘
          ┌─────────────┼─────────────┐                     │
          ▼             ▼             ▼                     │
      ┌───────┐     ┌───────┐     ┌───────┐                 │
      │ app-1 │     │ app-2 │     │ app-3 │◄────────────────┘ (consumidor em cada instância)
      └───┬───┘     └───┬───┘     └───┬───┘
          │  API + consumidor + outbox publisher + pending-reference worker
          └─────────────┼─────────────┘
                        ▼
                 ┌─────────────┐   outbox    ┌─────────────────────┐
                 │ PostgreSQL  │────────────►│ wager-events.fifo   │
                 └─────────────┘  publisher  └─────────────────────┘
```

As 3 instâncias são **idênticas e sem estado em memória**: tudo que importa para a correção (saldo, versão, chaves de idempotência, inbox, outbox) está no PostgreSQL.

**Três portas de entrada, um único caminho para o dinheiro:** HTTP, fila SQS e o worker de PENDING_REFERENCE chamam o mesmo `ProcessWagerService`, que usa as mesmas regras puras (`decideWager`) e o mesmo `applyDecision`. Não existe lógica financeira duplicada.

## 2. Princípios

1. **O banco é a última linha de defesa.** Toda regra crítica existe no código *e* no schema (CHECK, UNIQUE, triggers). Um bug na aplicação não consegue gravar saldo negativo, debitar duas vezes nem alterar o extrato.
2. **Nada de estado em memória para correção.** Idempotência, deduplicação e concorrência funcionam entre instâncias e sobrevivem a reinícios.
3. **Uma transação SQL por decisão financeira.** Transação de aposta, saldo, extrato, eventos e chave de deduplicação são gravados juntos — ou nada é gravado.
4. **Falhar de forma explícita.** Recusa de negócio, conflito, entrada inválida e falha temporária têm respostas diferentes e códigos estáveis.

## 3. Dinheiro (`Money`)

[src/domain/money/money.ts](src/domain/money/money.ts)

| Camada | Representação | Motivo |
|---|---|---|
| Entrada/saída (JSON, fila, eventos) | string decimal `"100.50"` | `number` JSON perde precisão antes do nosso código ver o valor |
| Domínio | `bigint` em unidades mínimas (centavos) + `Currency` | aritmética inteira e exata, sem limite de tamanho |
| Banco | `numeric(20,2)` | decimal exato do PostgreSQL |

- **Parsing estrito:** `"10.999"` é recusado (não arredondamos dinheiro em silêncio); `number`, notação científica, vírgula e espaços também.
- **Imutável:** `Object.freeze` + operações que sempre devolvem um novo `Money`.
- **Multi-moeda modelada, uma aceita:** `Currency` tem código e *scale*; somar moedas diferentes lança `CURRENCY_MISMATCH`. Apenas `BRL` está na lista de suportadas.
- **Mapeamento com o ORM:** as colunas `numeric` são mapeadas como `decimal` no MikroORM, que as devolve como **string** (nunca `number`). A conversão string ↔ `Money` acontece num único lugar, o mapper ([wallet.mapper.ts](src/wallets/wallet.mapper.ts)).

## 4. Modelo de domínio e escolha do ORM

### Domínio separado da persistência

```
src/domain/         Money, Currency, Wallet, decideWager   ← TypeScript puro, sem ORM
src/database/       WalletRecord, WagerTransactionRecord…  ← espelho das tabelas (EntitySchema)
```

O domínio não importa nada do MikroORM. Os *records* são mapeados com `EntitySchema` (mapeamento declarado fora da classe, sem decorators) e um mapper converte entre os dois.

- **Ganho:** as regras financeiras (53 testes unitários) rodam em milissegundos, sem banco.
- **Custo:** um pouco de código de mapeamento. Aceitável pelo tamanho do domínio.

### Por que MikroORM

- É a opção preferida do desafio (Prisma fora de escopo).
- *Unit of Work* + `em.transactional()` dão controle explícito de fronteira transacional.
- Permite descer ao SQL quando necessário dentro da mesma transação (`em.execute`, `nativeUpdate`) — usado nos pontos críticos de concorrência, para que o comportamento seja **visível no código** em vez de implícito.
- Migrations versionadas com `up`/`down`.

### Migrations escritas à mão

As migrations ([migrations/](migrations/)) são SQL explícito, não geradas a partir das entidades: CHECKs, índices parciais e triggers são o coração das garantias e precisam ser revisáveis linha a linha. Todas são reversíveis (testado `down` → `up`).

## 5. Invariantes garantidos pelo banco

| Invariante | Mecanismo |
|---|---|
| saldo nunca negativo | `CHECK (balance >= 0)` |
| uma carteira por jogador + moeda | `UNIQUE (player_id, currency)` |
| provedor não repete id de transação | `UNIQUE (provider, provider_transaction_id)` |
| no máximo **uma** linha de extrato por carteira + transação | `UNIQUE (wallet_id, transaction_id)` |
| uma linha de extrato por versão da carteira | `UNIQUE (wallet_id, wallet_version)` |
| ROLLBACK desfaz uma transação **uma única vez** | índice único parcial em `referenced_transaction_id WHERE kind='ROLLBACK' AND status='PROCESSED'` |
| extrato imutável (append-only) | trigger que bloqueia `UPDATE` e `DELETE` |
| status final não muda (PROCESSED/REJECTED/FAILED) | trigger em `wager_transactions` |
| rejeição sempre com motivo | `CHECK (status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL)` |
| valores positivos (zero só em LOSS) | `CHECK` em `amount` |

## 6. Estratégia transacional e concorrência

### Unidade de concorrência: a carteira

Não existe lock global. Operações em carteiras diferentes nunca se bloqueiam; operações na **mesma** carteira são serializadas pela versão dela.

### Optimistic locking com UPDATE condicional

Cada tentativa, dentro de uma transação (`READ COMMITTED`):

1. lê a carteira e guarda a `version` lida;
2. decide em memória (`decideWager`);
3. grava com:

```sql
UPDATE wallets SET balance = :novo, version = :lida + 1, updated_at = now()
 WHERE id = :id AND version = :lida
```

4. se **0 linhas** forem afetadas, outra operação mudou a carteira no meio → `ConcurrentModificationError` → a transação inteira é desfeita e **recomeçamos do zero**, com backoff exponencial com *jitter* (5 ms → 200 ms) e limite de 25 tentativas. Esgotado o limite, responde `503` (falha temporária, não recusa).

O UPDATE é escrito explicitamente (`nativeUpdate`) em vez de delegado ao versionamento automático do ORM, para que o ponto exato que protege o dinheiro seja óbvio na leitura e no teste.

`version` só incrementa quando o saldo muda (LOSS e rejeições não mudam a versão).

### Por que otimista e não `SELECT … FOR UPDATE`

| | Otimista (escolhido) | Pessimista (`FOR UPDATE`) |
|---|---|---|
| Caso comum (carteiras diferentes / pouca disputa) | sem espera, sem lock mantido durante a decisão | lock em toda operação |
| Disputa alta na mesma carteira | retries (medidos em `wallet_concurrency_conflicts_total`) | fila de espera no banco, sem retries |
| Risco | starvation sob disputa extrema | conexões presas esperando lock; deadlocks se a ordem variar |

Uma carteira pertence a um jogador, então disputa intensa na mesma carteira é rara no mundo real. Mesmo assim o teste com **30 BETs simultâneas em 3 instâncias na mesma carteira** passa de forma estável. Se a métrica de conflitos indicar carteiras "quentes", trocar para `FOR UPDATE` é uma mudança localizada em `ProcessWagerService`.

### Outras corridas tratadas

- **Mesmo `providerTransactionId` em paralelo** (ex.: chegou pela API e pela fila): o segundo viola `UNIQUE (provider, provider_transaction_id)`, a tentativa é desfeita e a seguinte encontra a transação existente → devolve como repetição.
- **Dois ROLLBACKs da mesma aposta:** ambos alteram a mesma carteira → serializados pela versão; o segundo vê o primeiro e é rejeitado com `ALREADY_ROLLED_BACK` (o índice parcial é a garantia final).
- **Rejeições** não fazem UPDATE na carteira. Uma rejeição pode ser decidida com base num saldo que outra transação está alterando naquele instante; o resultado equivale a ordenar a rejeição antes da alteração concorrente, o que é aceitável (o saldo nunca é violado).

## 7. Idempotência e deduplicação

Três camadas, todas persistentes:

| Camada | Chave | Protege contra |
|---|---|---|
| `idempotency_keys` | header `Idempotency-Key` (HTTP) | o cliente repetir a mesma requisição |
| `inbox_messages` | `MessageId` do SQS | a fila entregar a mesma mensagem de novo (ex.: ack perdido) |
| `UNIQUE (provider, provider_transaction_id)` | id do provedor | a mesma transação chegar por caminhos diferentes |

### Como a chave é reservada

```sql
INSERT INTO idempotency_keys (key, request_hash) VALUES (?, ?)
ON CONFLICT (key) DO NOTHING RETURNING key
```

Executado **dentro da mesma transação** do processamento:

- inseriu → pedido novo;
- não inseriu → compara o `request_hash` (SHA-256 do conteúdo canônico, com valor normalizado):
  - igual → **replay**: devolve a transação original (mesmo status HTTP, header `Idempotent-Replayed: true`);
  - diferente → **409 `IDEMPOTENCY_KEY_REUSED`** (conflito, não replay).

Se duas requisições com a mesma chave chegam juntas, o PostgreSQL faz a segunda **esperar** o commit (ou rollback) da primeira no `INSERT … ON CONFLICT`. Se a primeira falhar, a chave não fica "presa", porque foi desfeita junto. Teste: 5 requisições simultâneas com a mesma chave → 1 processamento, 4 replays.

A resposta do replay é reconstruída a partir da transação gravada. Para uma transação `PENDING_REFERENCE`, o replay reflete o estado **atual** (que pode já ter virado PROCESSED) — escolha deliberada, mais útil ao cliente do que congelar a primeira resposta.

### Não depender do SQS FIFO

A deduplicação nativa do FIFO só vale por **5 minutos** e só para o mesmo `MessageDeduplicationId`. Ela é usada como otimização, nunca como garantia; a garantia é a inbox + o UNIQUE do provedor.

## 8. Regras de negócio e ciclo de vida da transação

[src/domain/wager/wager-rules.ts](src/domain/wager/wager-rules.ts)

| Tipo | Efeito | Referência |
|---|---|---|
| `OPENING` (interno) | crédito do saldo inicial | — |
| `BET` | débito; recusa com `INSUFFICIENT_FUNDS` | — |
| `WIN` | crédito | BET processada |
| `LOSS` | sem movimento de saldo | BET processada |
| `REFUND` | crédito; ≤ valor da BET; uma por BET | BET processada |
| `ROLLBACK` | movimento contrário ao original, **mesmo valor**, uma vez | BET, WIN ou REFUND processados |

**A referência precisa bater** em provedor, jogador, carteira, moeda e rodada (`REFERENCE_MISMATCH`), ter tipo compatível (`REFERENCE_INVALID_KIND`) e estar PROCESSED (`REFERENCE_NOT_PROCESSED`). WIN/LOSS/REFUND sobre uma BET já desfeita: `REFERENCE_ROLLED_BACK`.

**Insuficiência de saldo vs. estorno que deixaria negativo:** são códigos diferentes. `INSUFFICIENT_FUNDS` (BET) é rotina; `REVERSAL_WOULD_OVERDRAW` (ROLLBACK de um WIN/REFUND já gasto) significa dinheiro pago que não pode ser recuperado e precisa de atenção operacional — por isso filtrável em métrica e evento.

### Estados

```
                 ┌──────────────► PROCESSED   (final)
 (novo) ─────────┼──────────────► REJECTED    (final, com failure_code)
                 └─► PENDING_REFERENCE ─┬──► PROCESSED
                         ▲   │          └──► REJECTED (inclui REFERENCE_NOT_FOUND)
                         └───┘ nova tentativa com backoff
```

- `PENDING_REFERENCE` responde `202`. O worker tenta de novo com backoff exponencial (2 s, 4 s, 8 s, 16 s… até 5 min); após `PENDING_REFERENCE_MAX_ATTEMPTS` (padrão 6) rejeita com `REFERENCE_NOT_FOUND`.
- Vários workers são seguros: cada tentativa trava a linha com `SELECT … FOR UPDATE SKIP LOCKED`.
- Rejeições são **gravadas** (não descartadas): dão rastreabilidade e fazem o replay devolver a mesma recusa.
- `PENDING` e `FAILED` existem no modelo; `FAILED` está reservado para falha técnica permanente (hoje erros permanentes da fila vão para a DLQ sem criar transação — ver limitações).

## 9. Mensageria (SQS)

[src/messaging/wager-queue.consumer.ts](src/messaging/wager-queue.consumer.ts)

- **Mesmo caso de uso do HTTP:** mesmo parser de entrada, mesmo `ProcessWagerService`.
- **Ordem:** `MessageGroupId = walletId`. Mensagens da mesma carteira são processadas em sequência; carteiras diferentes, em paralelo.
- **Ack só depois do commit:** `DeleteMessage` acontece após `execute()` retornar. Crash entre commit e ack → a mensagem reaparece e a inbox devolve o resultado anterior (testado em [crash-recovery.test.ts](test/integration/crash-recovery.test.ts)).

### Classificação de falhas

| Tipo | Exemplo | Tratamento |
|---|---|---|
| **De negócio** | saldo insuficiente | não é falha da mensagem: transação REJECTED gravada, mensagem confirmada |
| **Permanente** | JSON inválido, carteira inexistente, conflito de conteúdo | enviada à DLQ com `failureCode`/`failureReason` nos atributos e removida da fila |
| **Temporária** | banco fora, conflitos esgotados, erro inesperado | não confirmada; visibilidade ajustada com backoff (2 s, 4 s, 8 s…); após 5 recebimentos o *redrive* do SQS move para a DLQ |

Erros desconhecidos são tratados como temporários: se forem bug, acabam na DLQ após as tentativas, sem perda.

### Desligamento gracioso

No SIGTERM: para de buscar mensagens, aborta o long polling em andamento, **espera** o lote atual terminar e só então libera o processo. Os workers fazem o mesmo. `stop_grace_period: 30s` no Compose.

## 10. Outbox e eventos

### Por que outbox

Banco e fila não participam da mesma transação. Publicar antes do commit gera **evento fantasma**; publicar depois pode **perder** o evento. Com a outbox, o evento é gravado em `outbox_events` **na mesma transação** da mudança de saldo e publicado depois por um worker.

### Publicador

```sql
SELECT … FROM outbox_events
 WHERE published_at IS NULL AND available_at <= now()
 ORDER BY occurred_at, id LIMIT 50
 FOR UPDATE SKIP LOCKED
```

- **Vários publicadores simultâneos** (um por instância) pegam lotes disjuntos; ninguém espera nem duplica trabalho. Testado com 3 publicadores e 40 eventos → 40 publicados, nenhum repetido.
- **At-least-once:** se o processo cair entre o envio e o commit da marcação, o evento é reenviado. Duplicata é preferível a perda; cada evento tem `eventId` único e `MessageDeduplicationId = eventId` (o FIFO descarta a cópia dentro de 5 min; fora disso, o consumidor descarta pelo `eventId`).
- Falha de envio: `attempts++`, `last_error`, `available_at` com backoff (até 5 min).

### Eventos

Classe abstrata `DomainEvent` (envelope: `eventId`, `eventType`, `eventVersion`, `aggregateType`, `aggregateId`, `occurredAt`, `payload`) com subclasses tipadas: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged` — este **somente quando o saldo muda** e com `walletVersion`, que permite ao consumidor ordenar e detectar lacunas.

## 11. Contrato HTTP e classificação de erros

| Status | Quando | Repetir adianta? |
|---|---|---|
| `201` | PROCESSED | — |
| `202` | PENDING_REFERENCE | consultar depois |
| `400` | entrada inválida | não, corrigir |
| `404` | carteira/transação inexistente | não |
| `409` | `IDEMPOTENCY_KEY_REUSED`, `PROVIDER_TRANSACTION_CONFLICT`, `WALLET_ALREADY_EXISTS` | não |
| `422` | REJECTED (regra de negócio) | não |
| `503` | falha temporária (`Retry-After`) | sim |

Os códigos de falha ([errors.ts](src/domain/errors.ts)) são **contrato estável**: aparecem na API, nos eventos e no banco, e não podem ser renomeados.

Dois filtros globais do NestJS traduzem erros sem que as regras conheçam HTTP: `DomainErrorFilter` (400/404/409/422) e `InfrastructureErrorFilter` (503).

## 12. Extrato e reconciliação

- **Paginação por cursor** sobre `wallet_version` (única e crescente por carteira), do mais recente para o mais antigo. Diferente de OFFSET, não repete nem pula linhas quando entram movimentos novos, e usa o índice `UNIQUE (wallet_id, wallet_version)`. O cursor é opaco (base64url). Pede-se `limit + 1` para saber se há próxima página sem `COUNT`.
- **Reconciliação** (`POST /reconciliation/runs`): uma consulta recalcula, para todas as carteiras, saldo = Σ créditos − Σ débitos e versão = maior `wallet_version` do extrato, e compara com `wallets`. Cada divergência é **logada como erro, contada** (`reconciliation_divergences_total`) e **sinalizada** em `reconciliation_divergences` (uma aberta por carteira, com `times_detected`). **Nunca corrige**: corrigir automaticamente esconderia a causa, apagaria a evidência e poderia piorar o problema se o erro estiver no extrato.

## 13. Observabilidade

- **Logs JSON** (uma linha por evento) via `JsonLogger`. Correlação com `AsyncLocalStorage`: `correlationId` (header `X-Correlation-Id`, devolvido na resposta; na fila, o `MessageId`), mais `walletId`, `providerTransactionId`, `transactionId` quando conhecidos. **Sem payloads financeiros**: nada de valores, saldos ou corpos de requisição.
- **Métricas Prometheus** em `/metrics`: status por tipo e origem, rejeições por código, duplicatas, conflitos de concorrência, latência (histograma), resultado das mensagens, DLQ por motivo, retries de PENDING_REFERENCE, publicações e falhas da outbox, **lag da outbox** (idade do evento mais antigo pendente, calculado no banco, portanto global) e divergências de reconciliação.
- **Health:** `/health/live` (processo vivo, sem dependências) e `/health/ready` (banco e fila; 503 se algum cair), ambos sem autenticação.

## 14. Autenticação

**Omitida deliberadamente.** O desafio a torna opcional e sem pontuação, e o foco foi a correção financeira. Num ambiente real:

- os endpoints de negócio seriam protegidos por **OAuth2 client credentials** com um provedor externo (Keycloak/Zitadel): cada provedor de jogos é um *client*, e o `provider` do corpo deve ser igual ao `client_id` do token (hoje qualquer um pode se passar por qualquer provedor);
- `/reconciliation/*` exigiria um papel administrativo;
- `/health/*` continua aberto; `/metrics` ficaria restrito à rede interna.

## 15. Estratégia de testes

| Nível | Onde | Infra |
|---|---|---|
| Unitário | `src/**/*.test.ts` — Money, Wallet, regras | nenhuma |
| Integração | `test/integration/` | PostgreSQL e SQS reais (banco `finance_test`, filas `*-test.fifo`) |
| Concorrência | `wagering.concurrency`, `workers` | 3 instâncias simuladas com pools independentes |
| Sistema | `scripts/race-check.ts` | as 3 instâncias reais do Compose atrás do nginx |

Invariante verificado ao final de cada cenário de concorrência: **saldo da carteira == saldo reconstruído pelo extrato**.

## 16. Limitações conhecidas e próximos passos

| Limitação | Impacto | Próximo passo |
|---|---|---|
| Sem autenticação | qualquer cliente pode enviar como qualquer provedor | OAuth2 client credentials (seção 14) |
| `numeric(20,2)` fixa 2 casas | moedas com outra *scale* exigem migration | coluna por *scale* ou armazenar unidades mínimas |
| Optimistic locking sob disputa extrema na mesma carteira | mais retries e latência; 503 após 25 tentativas | `FOR UPDATE` para carteiras quentes, guiado pela métrica de conflitos |
| Ordem dos eventos por entidade é "melhor esforço" | se um evento falha e o seguinte publica, a ordem na fila inverte | consumidores ordenam por `walletVersion`; ou publicar em ordem por `aggregate_id` |
| `idempotency_keys` e `inbox_messages` crescem para sempre | ocupação de disco | job de limpeza com TTL (ex.: 30 dias) |
| Vários WINs para a mesma BET são aceitos | depende do contrato com o provedor | limitar por rodada, se o contrato exigir |
| ROLLBACK que chega antes da BET fica pendente; quando a BET chega, ela é debitada e o ROLLBACK credita | saldo final correto, mas a BET chega a ser aplicada | política alternativa: rejeitar a BET se já existe ROLLBACK pendente para ela |
| Erros permanentes da fila não criam transação `FAILED` | o rastro fica só na DLQ | gravar FAILED quando houver carteira válida |
| Reconciliação é uma varredura completa, síncrona e sem autenticação | lenta com milhões de carteiras | incremental por janela de tempo, agendada, protegida |
| Métricas de contador são por instância | precisam ser somadas no Prometheus | padrão do Prometheus (agregação na consulta) |
| Teste de carga não incluído (opcional) | sem números de vazão | k6 contra o balanceador |
| MiniStack em vez de LocalStack | diferenças sutis de comportamento são possíveis | validar em LocalStack/AWS antes de produção |
