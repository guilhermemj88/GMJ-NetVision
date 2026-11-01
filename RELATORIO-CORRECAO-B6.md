# RELATORIO — CORRECAO PONTUAL B6

Worktree: `C:\projetos\GMJ-NetVision-aglink-activate-safety`
Branch: `feature/aglink-activate-safety`
Referencia: `a5d2f4a` / `7b1dd86` · **Commit B6: `2ad62b8`**
Suite: **2790 verdes / 41 skip (2831)** · `tsc --noEmit` 0 · `eslint --max-warnings=0` 0

Zero deploy, zero escrita no Huawei, zero ACTIVATE fisico, n8n intocado,
policies OUT intactas, AUTO desligado.

---

## Causa

O registro do baseline (B5) podia viver apenas na memoria do processo: o
executor instanciava `MemoryMitigationBaselineStore` como default. Uma escrita
real seguia sem nenhuma prova persistente do estado anterior — e um restart da
API apagava o registro, deixando o REMOVE sem referencia fisica confiavel.

O auditor apontou tambem uma segunda assimetria: os comandos do node 2 vinham do
baseline do **preflight**, mas o snapshot persistido vinha de uma **segunda
leitura fisica**, sem comparacao entre as duas.

---

## Correcao

### Persistencia duravel obrigatoria

- `MitigationBaselineStore` passou a expor `readonly durable: boolean`.
  - `MemoryMitigationBaselineStore` → `durable = false`.
  - `AutomationMitigationBaselineStore` (payload em `MitigationAutomationRecord`,
    PostgreSQL/Prisma) → `durable = true`.
- Preflight de ACTIVATE ganhou o check `baseline_record_store`: com
  `canWriteLive = true` e store nao duravel (ausente — persistencia desabilitada —
  ou em memoria), o preflight bloqueia com
  **`MITIGATION_BASELINE_RECORD_UNAVAILABLE`**.
- `activate()` repete a guarda antes de qualquer SSH (defesa em profundidade):
  store em memoria, store indisponivel, `save` com erro ou registro nao
  confirmado ⇒ `MITIGATION_BASELINE_RECORD_UNAVAILABLE` e **zero comandos de
  escrita**.
- Depois do `save`, o registro e **relido do proprio store** e conferido
  (device, policy, par, hash do read-back) antes da primeira escrita.

### Comparacao das duas leituras (verificacao adicional)

`activate()` faz a leitura fisica imediatamente anterior a escrita com o MESMO
par `display route-policy` + `ip ip-prefix` do preflight, rededuz as clausulas
preservadas e compara com as que geraram os comandos: node de baseline,
`local-preference`, `route-targets`, `apply` adicionais e seguranca da derivacao.
Qualquer divergencia ⇒ **`MITIGATION_BASELINE_DIVERGED`**, sem commit, sem
adaptacao automatica dos comandos.

### MOCK

`MockMitigationExecutor` nao usa baseline store: continua com o baseline
simulado deterministico do estado inicial. Nenhuma flexibilizacao no executor
Huawei real. Persistencia do baseline **nao** habilita AUTO (segue desligado).

---

## Evidencia de persistencia entre instancias

`mitigation-b6-durability.test.ts` usa um backend persistente simulado em JSON
(`FakeDurableBackend`) — nada de duas referencias ao mesmo `Map` de objetos:

1. **Instancia A** (executor + adaptador proprios) executa ACTIVATE; o registro
   e gravado e confirmado.
2. **Instancia A e descartada** (executor e adaptador nao sao reaproveitados).
3. **Instancia B** cria um adaptador NOVO sobre o mesmo backend, le o registro e
   aprova o `preflight(REMOVE)`, retirando apenas os nodes 1 e 2.

Integracao real: `baseline-store.postgres.test.ts` (opt-in por
`MITIGATION_BASELINE_TEST_DATABASE_URL`, `describe.skipIf`) grava via
`PrismaAutomationStore`, **desconecta o cliente**, reconecta e le o registro por
um adaptador novo — provando que o payload esta no PostgreSQL e nao em memoria.

---

## Testes obrigatorios

| Caso | Resultado |
| --- | --- |
| `canWriteLive=true` sem store duravel | ACTIVATE bloqueado, zero comandos |
| Persistencia desabilitada (store em memoria) | bloqueado |
| Banco indisponivel (`save`/`load` lancam) | bloqueado |
| Falha no `save` | bloqueado |
| Registro nao confirmado apos a gravacao | bloqueado |
| Leitura fisica divergente do preflight | `MITIGATION_BASELINE_DIVERGED`, zero escrita |
| `save` persistente OK | ACTIVATE permitido; registro no backend com device/policy/par corretos |
| Instancia A grava → descartada → B le e valida REMOVE | verde |
| Instancia B sem registro | REMOVE bloqueado (`RECORD_MISSING`) |
| Registro corrompido no backend | REMOVE bloqueado |
| MOCK | continua funcionando sem store duravel |
| ACTIVATE → REMOVE ponta a ponta | verde (B5 + B6) |

Total: **11 casos novos** em `mitigation-b6-durability.test.ts` + 2 de integracao
PostgreSQL (skip sem banco de teste).

---

## Arquivos

| Arquivo | Mudanca |
| --- | --- |
| `mitigation-baseline-record.ts` | `durable` no contrato; memória = `false` |
| `baseline-store.ts` | `AutomationMitigationBaselineStore` = `durable: true` |
| `huawei-mitigation-executor.ts` | check `baseline_record_store`, guarda no `activate`, relitura de confirmacao, comparacao das duas leituras |
| `mitigation-test-support.ts` | backend duravel simulado (JSON) + `FakeDurableBaselineStore` |
| `huawei-mitigation-executor.test.ts`, `mitigation-audit-corrections.test.ts`, `mitigation-final-defects.test.ts`, `mitigation-codex-rc14f-audit.test.ts`, `single-pilot-harness.ts`, `auto-lifecycle.test.ts` | injecao do store duravel nos harnesses |
| `mitigation-b6-durability.test.ts` (novo) | 11 casos B6 |
| `baseline-store.postgres.test.ts` (novo) | integracao PostgreSQL opt-in |

---

## Riscos residuais

1. Sem `MITIGATION_AUTO_PERSISTENCE_ENABLED`/persistencia configurada, a escrita
   real fica **bloqueada** por desenho (era o comportamento exigido) — o
   operador precisa habilitar persistencia para mitigar de verdade.
2. O store duravel depende do `MitigationAutomationRecord`; indisponibilidade do
   banco bloqueia ACTIVATE (nunca degrada para memoria).
3. `MITIGATION_BASELINE_DIVERGED` pode exigir nova leitura/reconciliacao manual
   quando houver alteracao legitima entre preflight e escrita — direcao segura.

## GO / NO-GO

**GO para deploy em laboratorio com autorizacao explicita.**
**NO-GO para ACTIVATE fisico** sem essa autorizacao: nada publicado, nada
escrito no Huawei, AUTO desligado.
