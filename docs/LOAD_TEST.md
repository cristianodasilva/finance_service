# Teste de carga — metodologia, resultados e análise

```bash
docker compose up -d --build
bun run test:load
```

O script [scripts/load-test.ts](../scripts/load-test.ts) grava os números da execução em [load-test-results.md](load-test-results.md). Este documento registra a metodologia e a análise.

## Ambiente

| Item | Valor |
|---|---|
| Máquina | MacBook, Intel Core i5-1038NG7 @ 2.0 GHz (4 núcleos / 8 threads), 16 GB |
| Docker Desktop | 8 CPUs, ~8 GB para os containers |
| Topologia | nginx → **3 instâncias** (cada uma com API, consumidor SQS, publicador da outbox e worker de pendentes) · PostgreSQL 18 · MiniStack (SQS) |
| Cliente de carga | Bun 1.4.4, **na mesma máquina** que o sistema |

Tudo roda num notebook só: cliente, 3 instâncias, banco, emulador de SQS e balanceador disputam os mesmos 4 núcleos. Os números servem para **comparar cenários e achar gargalos**, não como capacidade de produção.

## Metodologia

- **Modelo fechado:** *C* trabalhadores concorrentes. Cada um envia uma requisição, espera a resposta e envia a próxima, durante *D* segundos. A latência é medida no cliente, ponta a ponta (passa pelo nginx).
- **Mistura de operações:** 85% BET nova, 10% WIN nova e **5% reenvio** de uma requisição já feita (mesma `Idempotency-Key`), para exercitar a idempotência sob carga. Valor de R$ 1,00 e carteiras com saldo alto: o objetivo é medir o caminho de sucesso, não as recusas.
- **Aquecimento** de 3 s antes da medição (JIT, pools de conexão). Não entra nos resultados.
- **Cenários:**
  1. **distribuído:** 50 trabalhadores, 200 carteiras sorteadas, 30 s. É o caso real, com jogadores diferentes;
  2. **hot wallet:** 20 trabalhadores, **1 carteira**, 15 s. É o pior caso do *optimistic locking*.
- **Métricas coletadas:**
  - throughput e p50/p95/p99/máximo, medidos no cliente;
  - status HTTP;
  - **conflitos de concorrência**: soma de `wallet_concurrency_conflicts_total` nas 3 instâncias, antes e depois;
  - **outbox lag** e eventos pendentes: amostrados a cada 500 ms em `outbox_lag_seconds` e `outbox_pending_events`;
  - tempo para a outbox esvaziar depois do fim da carga;
  - **reconciliação de todas as carteiras** no final.
- **Taxa de erro:** respostas que não são 201/202 nem rejeição de negócio (422). Na prática, os 503 de tentativas esgotadas.

## Resultados

### Primeira execução: publicador da outbox enviando 1 evento por chamada, em sequência

| Cenário | Req/s | p50 | p95 | p99 | Erros | Conflitos | Outbox lag máx | Outbox esvazia em |
|---|---|---|---|---|---|---|---|---|
| distribuído (50 × 200 carteiras) | **252** | 84 ms | 512 ms | 816 ms | 0,00% | 358 (0,05/req) | 67,7 s (11.224 pendentes) | 67,6 s |
| hot wallet (20 × 1 carteira) | **70** | 71 ms | 1.342 ms | 2.564 ms | 0,09% (1 × 503) | 3.779 (3,45/req) | 7,8 s | 6,9 s |

Reconciliação: **0 divergências.** Detalhes em [load-test-results-before.md](load-test-results-before.md).

### Última execução: lotes de 10 (`SendMessageBatch`) em faixas paralelas por entidade, com um único UPDATE

| Cenário | Req/s | p50 | p95 | p99 | Erros | Conflitos | Outbox lag máx | Outbox esvazia em |
|---|---|---|---|---|---|---|---|---|
| distribuído | **249** | 85 ms | 544 ms | 865 ms | 0,00% | 315 (0,04/req) | 78,7 s (12.782 pendentes) | 68,4 s |
| hot wallet | **71** | 65 ms | 1.333 ms | 2.449 ms | 0,18% (2 × 503) | 3.793 (3,41/req) | — ¹ | 48,2 s |

Reconciliação: **0 divergências em 639 carteiras.** Detalhes em [load-test-results.md](load-test-results.md).

¹ O cenário de hot wallet começa com a fila de eventos do cenário anterior ainda sendo drenada, então o lag dele mistura os dois.

## Análise

### 1. A API sustenta ~250 transações/s sem erros

No cenário distribuído, **nenhuma requisição falhou** e cada transação gravou na mesma transação SQL o saldo, o extrato, os eventos e a chave. O p50 fica em 60–85 ms. O p95/p99 (0,5–0,9 s) reflete a disputa de CPU numa máquina só com 5 containers e o cliente.

Houve 0,04–0,05 conflitos por requisição: com 50 trabalhadores e 200 carteiras sorteadas, às vezes dois pegam a mesma carteira ao mesmo tempo, e o *retry* resolve sem que o cliente perceba.

### 2. Hot wallet: o *trade-off* do optimistic locking, medido

Com 20 trabalhadores na **mesma** carteira, foram **~3,4 conflitos por requisição**: cada transação precisa, em média, de 4 tentativas até ganhar a corrida da versão. O throughput cai para ~70/s e o p99 sobe para ~2,5 s. Algumas requisições (0,1–0,3%) esgotaram as 25 tentativas e receberam **503**, que é transitório e seguro de reenviar com a mesma chave.

**Nenhum saldo ficou errado** e a reconciliação seguinte não achou divergências.

Este é exatamente o limite descrito no [ARCHITECTURE.md](../ARCHITECTURE.md) (seção 7). O cenário é artificial, porque uma carteira pertence a um jogador e 20 apostas simultâneas do mesmo jogador não são o padrão. Se em produção a métrica de conflitos mostrar carteiras "quentes", o próximo passo é usar `SELECT … FOR UPDATE` para elas: as requisições fazem fila no banco em vez de repetir o trabalho.

### 3. O atraso da outbox é limitado pelo emulador de SQS, não pelo código

Na primeira execução, os eventos se acumularam (pico de 11 mil pendentes, cerca de 68 s para esvaziar). A hipótese inicial era o número de chamadas ao SQS, então mudei para **lotes de 10** e depois para **faixas paralelas**. **O resultado não mudou.** Medindo as partes isoladamente:

| Medida | Resultado |
|---|---|
| buscar 100 pendentes com `FOR UPDATE SKIP LOCKED` | ~10 ms |
| 100 UPDATEs individuais | ~84 ms (agora: 1 UPDATE só) |
| 1 `SendMessageBatch` (10 eventos) no MiniStack | ~78 ms |
| **10 lotes em paralelo × em sequência** | **660 ms × 704 ms, ganho de 1,1x** |

O MiniStack **atende uma chamada por vez**, com um teto de **~150 eventos/s**. Isso bate com a vazão observada da outbox (~160 eventos/s), qualquer que fosse a estratégia do publicador. Como cada transação gera ~2 eventos, 250 transações/s produzem ~500 eventos/s, acima do teto do emulador. Por isso o acúmulo.

Conclusões:
- **Corretude:** mesmo com 12 mil eventos acumulados, **nenhum foi perdido nem duplicado indevidamente**. A outbox esvaziou sozinha e a reconciliação ficou consistente. Esse é o comportamento que o padrão outbox promete: a fila lenta atrasa os eventos, mas não afeta o dinheiro nem a API (a latência das transações não mudou).
- **As melhorias ficam:** em SQS real (que escala horizontalmente, com latência típica de 10–30 ms), lotes de 10 reduzem as chamadas em 10x e as faixas paralelas escondem a latência de rede. As faixas são definidas pelo `aggregateId`, então os eventos de uma mesma entidade continuam saindo em ordem. Não dá para comprovar o ganho localmente, e prefiro registrar isso a apresentar um número que não medi.
- **Para validar:** repetir o teste contra LocalStack ou uma conta AWS de teste, acompanhando `outbox_lag_seconds`.

## Próximos passos

| Experimento | Objetivo |
|---|---|
| repetir contra SQS real ou LocalStack | medir o ganho real do envio em lote e em paralelo |
| cliente de carga em outra máquina | separar o custo do cliente do custo do sistema |
| curva de carga: concorrência 10 → 200 | achar o ponto de saturação da API, onde o p99 dispara |
| hot wallet com `FOR UPDATE` | comparar com o otimista: conflitos, p99 e 503s |
| modelo aberto, com taxa fixa de chegada | medir a latência sob uma taxa constante de chegada, em vez de concorrência fixa |
