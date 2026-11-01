# RELATORIO — CORRECOES DA AUDITORIA CLAUDE (mitigacao BGP)

Worktree: `C:\projetos\GMJ-NetVision-aglink-activate-safety`
Branch: `feature/aglink-activate-safety`
Commit auditado: `6acfd14` (mecanismo unico)
Commit desta correcao: **`98dde0a`**
Data: 2026-11-01

Escopo cumprido: somente worktree Windows. Zero deploy, zero escrita no Huawei,
zero ACTIVATE/REMOVE fisico, AUTO desligado, nenhuma outra route-policy tocada.

---

## 1. Causa raiz dos cinco testes vermelhos (comprovada)

**Sintoma**: `single-pilot.integration.test.ts` (2) e `aglink-bgp-plan.test.ts` (3)
falhavam no caminho de REMOVE com `REVALIDATION_FAILED`, mesmo com o par 1/2
fisicamente correto e o baseline intacto.

**Diagnostico pontual (instrumentacao temporaria, ja removida)**

1. `parseHuaweiRoutePolicyNodesLenient` extraia exatamente **1** `deny`+BOGONS
   (node 1) e **1** `permit`+lista alvo+RT660 (node 2) — parser e multi-RT
   (RT140 + RT660 na mesma instrucao) corretos.
2. `resolveActivePair` **nao** retornava `null`: o par era encontrado.
3. O node sinalizado como divergente era o **node 10** — o node NORMAL do
   cliente, que referencia a mesma prefix-list autorizada e nao carrega a RT de
   mitigacao.
4. `inspectPolicyMitigation` classificava o node 10 como propriedade temporaria
   (`partialNodes` → `AGLINK mitigation attributes divergent`), o check
   `policy_mitigation_scope` falhava e o preflight de retirada bloqueava.

**Mecanismo exato do defeito**

```ts
// huawei-mitigation-executor.ts (antes)
private inspectMitigation(
  input, readBack,
  baselineNodes: readonly number[] = [],   // <-- [] quando nao informado
)
// mitigation-policy-physical.ts (antes)
input.baselineNodes ?? (aglink ? [AGLINK_BGP_PLAN.baselineNode] : [])
```

O default `[]` **nunca e nullish**, logo o `??` jamais caia no fallback da
AGLINK. O REMOVE chamava `inspectMitigation(input, readBackOutput)` sem baseline
→ conjunto de baseline vazio → node 10 avaliado como par de mitigacao.

**Correcao (duas camadas, ambas testadas)**

| Camada | Mudanca |
| --- | --- |
| 1 | parametro passa a ser `baselineNodes?: readonly number[]` (undefined quando nao informado) → o fallback volta a ser alcancavel |
| 2 | o fallback tambem trata **lista vazia** como "nao informado": `input.baselineNodes && input.baselineNodes.length > 0 ? ... : aglink ? [10] : []` |

Prova de carga: restaurando apenas a expressao `??` antiga, os 5 testes
originais passam e **somente** o teste novo de lista vazia falha — confirmando
que (1) elimina o defeito observado e (2) fecha o contrato do caller.

---

## 2. Correcoes 1–4 da auditoria

### Correcao 1 — baseline ausente bloqueia

`derivePreservedClauses` sem node `permit` que cubra a lista autorizada →
`baselineNode = null` → check `preserved_attributes` **bloqueia** com
`MITIGATION_BASELINE_NOT_DERIVABLE`. Nunca se cria node 2 apenas com a RT.
(`huawei-mitigation-executor.ts`)

### Correcao 2 — baseline nao reproduzivel bloqueia

`baselineUnsafeReasons` (em `mitigation-policy-clauses.ts`) recusa:

- `if-match` adicional nao reproduzido;
- `goto`;
- `apply` fora do whitelist reproduzivel
  (`local-preference`, `extcommunity rt`, `community`, `as-path`, `cost`, `med`,
  `origin`, `preferred-value`);
- node anterior que case a mesma prefix-list ou seja catch-all (poderia capturar
  as rotas antes do baseline).

Motivo exposto: `MITIGATION_BASELINE_UNSAFE: <razoes>`. Portao fail-closed, sem
interpretador generico de route-policy. AGLINK simples continua aprovada.

### Correcao 3 — erro de CLI nunca chega ao commit

`ssh-client-impl.ts`:

- `abortOnCommandError` + `CLI_ERROR`
  (`Error:`, `% Error|Unrecognized|Incomplete|Wrong|Too many|Ambiguous`,
  `Info: Unrecognized|Wrong|...`);
- a verificacao roda em `onCommandOutput` **antes** de `advance()`, portanto o
  `commit` (ultimo comando da lista canonica) nunca e enviado depois de um
  comando rejeitado;
- `abortOnInteractivePrompt` (correcao anterior) encerra a sessao em qualquer
  prompt desconhecido, sem responder `Y`;
- `safeSshError` distingue `SSH interactive prompt blocked` e
  `SSH command rejected by device`.

`applyMitigationCommands` (`huawei-bgp-ssh.ts`) liga os dois guardas na mesma
sessao de escrita.

### Correcao 4 — preview igual a escrita

`MitigationCommandService` obtem `preservedClauses` do preflight e passa o
**mesmo** objeto para `buildMitigation(..., preservedClauses)`, para
`this.activate(...)` e para `verifyActivation(...)`. SIMULATE/preview e escrita
compartilham o plano canonico; teste dedicado garante igualdade comando a
comando e que uma escrita sem `preserved` nunca coincide com o preview aprovado.

---

## 3. Correcao adicional — baseline generico no REMOVE

O item "nao criar excecao especifica para AGLINK" expunha um defeito real que a
instrumentacao revelou: **o REMOVE so funcionava para a AGLINK**, porque o unico
produtor de `baselineNodes` era a constante `AGLINK_BGP_PLAN.baselineNode`.
Para qualquer outro cliente, o node normal que referencia a lista autorizada
seria classificado como suspeito e a retirada ficaria permanentemente bloqueada
— o mecanismo unico poderia ativar, mas nunca retirar.

Correcao: `baselineNodesForRemoval` (`mitigation-policy-clauses.ts`) deriva, do
proprio read-back, os nodes normais do cliente:

- `permit`;
- que referenciam a lista autorizada do par;
- que **nao** carregam nenhuma RT de mitigacao;
- excluindo explicitamente o par esperado (`bogonNode`/`mitigationNode`).

Sem enfraquecer nada: um node com a lista e **com** a RT de mitigacao continua
ambiguo (bloqueia); um segundo par (nodes 3/4) continua bloqueando; o par
esperado continua exigindo casamento exato em `resolveActivePair`
(**exatamente um** deny+BOGONS e **exatamente um** permit+alvo+RT).

---

## 4. Testes

| Arquivo | Casos | Estado |
| --- | --- | --- |
| `mitigation-audit-corrections.test.ts` (novo) | 15 | verde |
| `mitigation-policy-physical.test.ts` (+5 de regressao) | 16 | verde |
| `aglink-activate-contract.test.ts` | 19 | verde |
| `mitigation-node-snapshot.test.ts` | 17 | verde |
| `huawei-mitigation-executor.test.ts` | 41 | verde |
| Suite completa (`apps/api`) | **2762 verdes / 39 skip / 2801** | exit 0 |
| `tsc --noEmit` | — | exit 0 |
| `eslint --max-warnings=0` (arquivos alterados) | — | exit 0 |

Casos que travam a auditoria:

1. policy sem node que cubra os prefixos → `MITIGATION_BASELINE_NOT_DERIVABLE`,
   nada escrito;
2. `if-match` adicional → `MITIGATION_BASELINE_UNSAFE`;
3. `goto` → bloqueia; `3b` `apply` sem semantica reproduzivel → bloqueia;
4. node anterior catch-all → bloqueia; `4b` node anterior com a mesma
   prefix-list vira o proprio baseline (nao bloqueia);
5. AGLINK simples continua aprovada (deriva LP e RT do baseline);
6. CLI error impede commit (`testes de ssh` + `mitigation-live-write`);
7. prompt inesperado impede novos comandos;
8. preview e escrita identicos;
9. nodes 1/2 ocupados continuam bloqueados;
10. REMOVE sem regressao: par correto, baseline com a mesma prefix-list **sem**
    RT de mitigacao nao bloqueia; segundo par bloqueia; node com a lista e
    **com** a RT de mitigacao nunca vira baseline.

Matriz de validacao pedida (todas verdes):

| Item pedido | Resultado |
| --- | --- |
| ACTIVATE seguido de REMOVE | verde (`aglink-activate-contract`, `single-pilot.integration`) |
| Node 2 com multiplas RTs | verde (RT140 + RT660 na mesma instrucao `apply extcommunity ... additive`) |
| Node 10 com a mesma prefix-list, sem RT de mitigacao | verde (baseline do cliente, nao e par) |
| Ambiguidade real continua bloqueada | verde (`huawei-mitigation-executor.test.ts:404`, dois nodes BOGONS → `null`) |
| Os cinco testes vermelhos | verdes |
| Os doze testes das correcoes 1–4 | verdes (agora 15, com os tres do baseline/ambiguidade) |

Instrumentacao temporaria: **removida** (nenhum `console.*`, `debugger` ou
`TEMP-DIAG` restante; arquivo de sonda `zz-temp-*.test.ts` apagado).

---

## 5. Arquivos alterados (commit `98dde0a`)

| Arquivo | Mudanca |
| --- | --- |
| `ssh-client-impl.ts` | `abortOnCommandError`, `CLI_ERROR`, aborto por comando |
| `huawei-bgp-ssh.ts` | guardas ligados na sessao de escrita; mapeamento de erros |
| `mitigation-policy-clauses.ts` | `unsafeReasons`, whitelist reproduzivel, `baselineNodesForRemoval` |
| `mitigation-policy-physical.ts` | `baselineNodes` + fallback corrigido |
| `huawei-mitigation-executor.ts` | `preserved_attributes` bloqueante, `baselineNodes` nas duas direcoes |
| `mitigation-executor.ts` | `verifyActivation(..., preserved)` |
| `mitigation-command-service.ts` | preview == escrita |
| `aglink-bgp-plan.ts` | `baselineNode: 10` nomeado |
| `mitigation-audit-corrections.test.ts` | 15 casos (novo) |
| `mitigation-policy-physical.test.ts` | 5 casos de regressao |

---

## 6. Riscos residuais e limitacoes

1. `CLI_ERROR` e heuristica de texto do VRP8. Falso positivo aborta a escrita
   (fail-safe), nunca o contrario. Nao cobre erro que o equipamento reporte sem
   nenhum dos prefixos conhecidos.
2. Se o estado de commit ficar incerto (queda de sessao entre `commit` e
   read-back), a mitigacao segue exigindo `REVALIDATION_REQUIRED`/read-back —
   nada e marcado como concluido sem prova fisica.
3. O baseline derivado no REMOVE usa o read-back do momento; um node normal que
   legitimamente carregue a RT de mitigacao sera tratado como ambiguo
   (bloqueia). Direcao segura, porem exige reconciliacao manual.
4. `AGLINK_BGP_PLAN.baselineNode` permanece como fallback historico para os
   chamadores que nao informam baseline (reconciler). Nao e caminho de escrita —
   e apenas o conjunto de nodes ignorados na classificacao.

---

## 7. GO / NO-GO

**GO para reauditoria do Claude** — branch `feature/aglink-activate-safety`,
commit `98dde0a`.

**NO-GO para deploy / ACTIVATE fisico** ate:

- parecer da reauditoria independente;
- autorizacao explicita do responsavel;
- janela LAB one-shot com o par/VSI definidos.

Nada foi publicado, nada foi escrito no Huawei, AUTO permanece desligado.

---

## 8. Evidencia compacta para revisao curta do Claude

```
base auditada : 6acfd14
correcao      : 98dde0a  (10 arquivos, +687 / -46)
suite         : 2762 passed, 39 skipped (2801) - exit 0
typecheck     : tsc --noEmit exit 0
lint          : eslint --max-warnings=0 exit 0

causa raiz REMOVE:
  inspectMitigation(..., baselineNodes: readonly number[] = [])
  + input.baselineNodes ?? (aglink ? [10] : [])   -> fallback inalcancavel
  -> node 10 (baseline) classificado como par -> REVALIDATION_FAILED

correcoes:
  1 baseline ausente            -> MITIGATION_BASELINE_NOT_DERIVABLE (bloqueia)
  2 baseline nao reproduzivel   -> MITIGATION_BASELINE_UNSAFE (bloqueia)
  3 CLI error / prompt          -> aborta antes do commit
  4 preview == escrita          -> mesmo preservedClauses
  + baseline generico no REMOVE -> derivado do read-back, sem excecao AGLINK

garantias mantidas:
  exatamente um par valido; sem parser lenient como fallback;
  nodes 1/2 ocupados bloqueiam; REMOVE nao cria nada; AUTO desligado.
```
