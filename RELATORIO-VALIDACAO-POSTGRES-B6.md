# RELATORIO — VALIDACAO POSTGRESQL B6 NO SERVIDOR IMPLANTAR

Ambiente: `netvision-implantar` (45.163.144.8, porta 2222) — acesso READ-ONLY
Codigo aprovado: `2ad62b8` (branch `feature/aglink-activate-safety`)
Data: 2026-11-01 20:32–20:45 UTC

**Resultado: NAO EXECUTADO — nao existe banco PostgreSQL de teste isolado neste
servidor.** Regra 7 da missao: informar a ausencia e PARAR, sem improvisar com
producao.

---

## 1. Ambiente observado (somente leitura)

| Item | Resultado |
| --- | --- |
| Clusters PostgreSQL | **apenas** `18/main` em `127.0.0.1:5432` (online) |
| Porta 55077 (teste documentado) | ausente / livre |
| Porta 55439 (`netvision_auto_isolated`) | ausente |
| Containers PostgreSQL | nenhum (`docker ps` sem postgres) |
| Bancos no cluster | `netvision` (producao), `postgres`, `template0/1`, `netvision_alarm_preview`, `netvision_autoall_qa`, `netvision_fast_observe`, `netvision_predeploy_qa`, `netvision_trends_qa`, `netvision_x15_qa`, `nv_l3_dbg` |
| Tabela `MitigationAutomationRecord` em producao | existe, **0 linhas** (nenhum baseline gravado) |
| Mesma tabela nos bancos QA | **nao existe** (nunca receberam a migration) |
| Node/npm no host | v24.19.0 / 11.17.0 |
| Disco `/` | 5,2 GB livres (93% usado) |
| `/tmp` | tmpfs 3,5 GB livres |

Todos os comandos foram de leitura: `pg_lsclusters`, `ss -ltnp`, `psql -tAc`
(select em `pg_database`/`pg_stat_user_tables`/`count(*)`), `docker ps`, `ls`,
`df`, `command -v`. Nenhum DDL, DML, restart, migration ou alteracao de flag.

## 2. Por que nao foi possivel executar

Os dois testes de `baseline-store.postgres.test.ts` exigem
`MITIGATION_BASELINE_TEST_DATABASE_URL` apontando para um banco **descartavel**
— o proprio teste recusa qualquer outro destino (guard de host/porta/nome).

O servidor IMPLANTAR **nao possui** esse banco isolado:

- o unico cluster e o de **producao** (5432);
- as bases QA/preview vivem **no mesmo cluster de producao** e nao possuem a
  tabela `MitigationAutomationRecord`, entao o teste faria `deleteMany()` e DDL
  em ambiente alheio;
- nao ha cluster descartavel em 55077/55439 nem container PostgreSQL.

Criar um cluster temporario, instalar dependencias e buildar o projeto neste
host seria improvisacao de infraestrutura em servidor de producao — fora do
escopo autorizado.

## 3. Prova de que producao nao foi tocada

- Nenhum comando de escrita foi emitido (`INSERT/UPDATE/DELETE/DDL` ausentes).
- A contagem em `netvision.public."MitigationAutomationRecord"` foi **0 antes e
  0 depois** das sondagens.
- Nenhum servico foi reiniciado; nenhuma flag/arquivo de configuracao alterado.

## 4. O que falta para concluir esta validacao

Pre-requisitos (nao executados):

1. autorizar um PostgreSQL descartavel **fora** do cluster de producao, em
   `127.0.0.1:55077` com database `mitigation_baseline_test` (o mesmo padrao ja
   usado por `SINGLE_PILOT_TEST_DATABASE_URL`);
2. checkout do commit `2ad62b8` em diretorio temporario;
3. `npm ci`, `prisma generate`, `npm run build -w @gmj/api` (o build precede a
   suite) e aplicacao da migration existente em banco vazio;
4. `MITIGATION_BASELINE_TEST_DATABASE_URL=postgresql://...@127.0.0.1:55077/mitigation_baseline_test`
   e executar apenas `baseline-store.postgres.test.ts` (2 casos).

Alternativa equivalente e ja homologada no fluxo do projeto: executar os mesmos
dois testes em ambiente descartavel (cluster/container local), nao no servidor
de producao.

## 5. Evidencia ja obtida (independente de PostgreSQL)

O comportamento entre instancias ja esta provado em teste automatizado com
backend persistente serializado (`mitigation-b6-durability.test.ts`):

- instancia A grava o baseline e e descartada;
- instancia B (adaptador novo) le o mesmo registro e aprova o `preflight(REMOVE)`;
- registro ausente/corrompido bloqueia o REMOVE;
- device, policy, nodes e hash sao conferidos apos a gravacao.

O que falta e **somente** a prova de que o adaptador `AutomationMitigationBaselineStore`
persiste e recupera o payload em um PostgreSQL real.

## 6. Correcao documental aplicada

`RELATORIO-CORRECAO-B6.md`: referencia de commit corrigida de `146953f` para
`2ad62b8` (o commit foi reescrito para normalizar a mensagem). Nenhum codigo
funcional foi alterado.

## 7. GO / NO-GO

**NO-GO para homologacao fisica** enquanto a validacao PostgreSQL real nao for
executada em banco descartavel. O restante (B3, B4, B5, B6 + regressao) esta
verde: 2790 testes, `tsc` e ESLint limpos em `2ad62b8`.

**Proximo passo autorizado, se desejar:** provisionar o banco descartavel
(55077/`mitigation_baseline_test`) e repetir esta missao — roteiro da secao 4.
