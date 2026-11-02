# Laboratorio de homologacao do ciclo completo (ACTIVATE -> restart -> REMOVE)

Scaffolding **descartavel** de laboratorio: exercita o motor de mitigacao REAL
(`HuaweiMitigationExecutor`, `AutomationMitigationBaselineStore`,
`PrismaAutomationStore`) contra um **postgres descartavel** e um **equipamento
Huawei simulado**, com fronteira real de processo.

Nao e codigo de produto: nada aqui e importado por `src/`.

## Por que existe

`src/testing/single-pilot-harness.ts` expoe `restart()` que recria objetos no
MESMO processo. Para provar que o baseline sobrevive a morte do processo, o
ciclo precisa de dois processos distintos — e o estado do "equipamento" precisa
viver fora da API, como num roteador real.

## Como rodar

1. PostgreSQL 18 descartavel, somente loopback, banco `mitigation_baseline_test`:

   ```bash
   docker run -d --name netvision-baseline-pg \
     -e POSTGRES_DB=mitigation_baseline_test \
     -e POSTGRES_USER=nv_baseline_lab \
     -e POSTGRES_PASSWORD=nv_lab_only_2026 \
     -p 127.0.0.1:55077:5432 \
     --tmpfs /var/lib/postgresql:rw,size=2g \
     postgres:18
   ```

2. Schema (43 migrations) no banco vazio:

   ```bash
   DATABASE_URL='postgresql://nv_baseline_lab:nv_lab_only_2026@127.0.0.1:55077/mitigation_baseline_test?schema=public' \
     npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
   ```

3. Ciclo em **processos separados** (cada `tsx` e um processo novo):

   ```bash
   cd apps/api
   npx tsx lab-homolog/step-activate.ts   # processo A: ACTIVATE
   npx tsx lab-homolog/step-remove.ts     # processo B: le o baseline do PG e faz REMOVE
   npx tsx lab-homolog/negatives.ts       # 6 cenarios negativos
   ```

`shared.ts` recusa qualquer URL fora de `127.0.0.1:55077` (ou `:55999`, usado no
cenario de PostgreSQL indisponivel). Nenhum `.env` produtivo e lido.

## Arquivos

| Arquivo | Papel |
| --- | --- |
| `router-sim.ts` | Huawei VRP8 simulado; estado em `%TEMP%/nv-lab-homolog/device.json`; erro de CLI descarta a candidata e nao comita |
| `shared.ts` | constantes, guarda de isolamento, fabricas de `PrismaClient`/store/executor |
| `step-activate.ts` | ETAPA 2 — ACTIVATE + readback + registro no PostgreSQL |
| `step-remove.ts` | ETAPAS 3/4 — recuperacao do baseline em processo novo + REMOVE + diff |
| `negatives.ts` | ETAPA 5 — negativos (ausente, corrompido, drift, PG offline, erro SSH, ambiguidade) |

Evidencia da ultima execucao: `RELATORIO-HOMOLOGACAO-CICLO-COMPLETO.md`.
