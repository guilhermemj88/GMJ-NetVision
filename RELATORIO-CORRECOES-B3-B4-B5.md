# RELATORIO — CORRECOES FINAIS B3, B4 E B5

Worktree: `C:\projetos\GMJ-NetVision-aglink-activate-safety`
Branch: `feature/aglink-activate-safety`
Base: `98dde0a` / `ab22ba2` · **Commit desta missao: `a5d2f4a`**
Suite: **2779 verdes / 39 skip (2818)** · `tsc --noEmit` 0 · `eslint --max-warnings=0` 0

Zero deploy, zero escrita no Huawei, zero ACTIVATE/REMOVE fisico, AUTO desligado,
nenhuma policy OUT alterada, nenhuma migration.

---

## B3 — NODES ANTERIORES AO BASELINE

### Causa
O `derivePreservedClauses` so olhava o node de onde os atributos eram derivados.
Um node ANTERIOR ao baseline que negasse um sub-bloco do que o node 2 aceitaria
fazia o node de mitigacao **ampliar** o conjunto de prefixos aceitos: o node 2
casa primeiro e aplica `permit`, e o `deny` original nunca era avaliado.

### Correcao
`mitigation-policy-clauses.ts`:

- `parseIpPrefixLists` interpreta as `ip ip-prefix` reais do equipamento
  (`index`, acao, rede, comprimento, `greater-equal`/`less-equal`) e converte
  cada entrada na faixa de enderecos que ela cobre;
- `earlierNodeConflictReasons` compara, para cada node ANTERIOR ao baseline,
  as faixas da lista referenciada com as faixas da lista autorizada:
  - sobreposicao → `node anterior N (acao) com a lista X alcanca prefixos do
    bloco autorizado Y`;
  - lista ausente do dump, entrada `deny` ou entrada ilegivel → `ausencia de
    conflito com o bloco autorizado NAO pode ser comprovada`;
  - `if-match` que nao seja `ip-prefix` (community/as-path) → nao reproduzivel;
- o derivador recebe `{ prefixListConfiguration, pair }`; os nodes 1 e 2 do
  proprio par sao excluidos da avaliacao (nunca sao "nodes anteriores" nem
  baseline) para nao mascararem a causa real do bloqueio.

Fail-closed por construcao: qualquer duvida bloqueia; nao existe interpretador
completo de route-policy.

### Testes
`mitigation-final-defects.test.ts`:

- deny anterior com **prefix-list diferente e sobreposta** → BLOQUEIA;
- node anterior em faixa **sem sobreposicao** → baseline simples aprovado;
- node anterior com lista **nao dumpada** → BLOQUEIA (conflito nao comprovavel).

---

## B4 — TRANSPORTE SSH DE ESCRITA

### Causa
`armIdle()` chamava `advance()` depois de 2,5 s de silencio: sem prompt de
conclusao o proximo comando (inclusive o `commit`) era enviado assim mesmo.
A resposta automatica `N` ao prompt de troca de senha tambem podia ocorrer antes
do primeiro comando, e o erro de CLI so era verificado quando o comando terminava
por prompt.

### Correcao
`ssh-client-impl.ts`:

- nova opcao `requirePromptCompletion` (ligada em `applyMitigationCommands`):
  o comando ATUAL so termina quando o **prompt normal** do VRP aparece. Silencio
  → `SSH_PROMPT_NOT_CONFIRMED` (`promptIdleMs`, default 10 s) e a sequencia para;
- `abortWrite()` centraliza o aborto: nada mais e escrito, em especial o `commit`;
- erro de CLI passou a ser avaliado no **acumulado** de stdout a cada chunk
  (pega erro dividido entre chunks) e **antes** de qualquer avanco →
  `SSH_COMMAND_REJECTED`;
- `abortOnInteractivePrompt` vale **desde o primeiro byte** (inclusive antes do
  primeiro comando) e a resposta automatica `N` foi removida na sessao de
  escrita;
- o comentario que presumia "o VRP descarta a candidata" foi corrigido:
  encerrar o canal **nao** e prova de descarte. O servico de comandos ja marca o
  escopo como `RECONCILIATION_REQUIRED` quando a escrita foi iniciada e o
  resultado fisico nao foi comprovado;
- `safeSshError` distingue `prompt nao confirmado`, `comando rejeitado` e
  `prompt interativo bloqueado`.

### Testes
`ssh-client-write-guards.test.ts` (ssh2 substituido por transporte em memoria,
`SshClientImpl` real):

1. erro de CLI → `SSH_COMMAND_REJECTED`, `commit` **nao** enviado;
2. erro dividido em dois chunks → idem;
3. silencio sem prompt → `SSH_PROMPT_NOT_CONFIRMED`, `commit` nao enviado;
4. prompt desconhecido (`Please wait...`) → interrompe a sequencia;
5. prompt interativo antes do primeiro comando → aborta sem escrever nada;
6. caminho feliz: 3 comandos so saem depois do prompt de cada um e a sessao
   termina no `quit` (sem `commit` extra).

---

## B5 — DETECCAO DE ALTERACAO FISICA NO REMOVE

### Causa
`baselineNodesForRemoval` derivava os nodes "permanentes" do **read-back do
momento**: qualquer `permit` com a lista autorizada e sem a RT de mitigacao era
tratado como original. Um node criado ou alterado depois do ACTIVATE entrava
como baseline e a retirada seguia sobre uma configuracao que nunca existiu.

### Correcao
Novo `mitigation-baseline-record.ts`:

- `captureMitigationBaseline` grava, a partir do read-back, **todos** os nodes
  permanentes (action + clausulas normalizadas), o par usado e o `sha256` do
  read-back integral;
- `isBaselineRecordComplete` valida a forma do registro (versao, escopo, nodes,
  hash, data) — registro corrompido nunca e aceito;
- `baselineDriftReasons` compara o estado fisico atual com o registro e devolve
  divergencias: node removido, node novo, mudanca de action, clausulas alteradas;
- `MitigationBaselineStore` (`save`/`load`) + `MemoryMitigationBaselineStore`;
- `worker/mitigation/baseline-store.ts` — `AutomationMitigationBaselineStore`
  sobre `MitigationAutomationRecord` (payload Json): **duravel, sem migration**.

`huawei-mitigation-executor.ts`:

- `activate()` grava o registro **imediatamente antes da primeira escrita**
  (leitura fresca → captura → `save`); falha de leitura/registro interrompe o
  ACTIVATE antes de qualquer comando chegar ao equipamento;
- `preflight(REMOVE)` carrega o registro, valida escopo/integridade e compara:
  - ausente/invalido/outro escopo → `MITIGATION_BASELINE_RECORD_MISSING`;
  - divergencia → `MITIGATION_BASELINE_DRIFT: ...`;
  - somente os nodes do par sao ignorados; o skip list da inspecao passa a ser
    exatamente os nodes registrados;
- nenhum node permanente e restaurado ou alterado (nao e rollback: e deteccao).

`routes.ts` injeta o store duravel quando a persistencia esta ligada.

### Testes
`mitigation-final-defects.test.ts` + `mitigation-audit-corrections.test.ts`:

- registro ausente / registro corrompido → retirada BLOQUEADA;
- node permanente ALTERADO / ACRESCENTADO / REMOVIDO desde o ACTIVATE → bloqueia
  com `MITIGATION_BASELINE_DRIFT` e zero escrita;
- segundo par instalado continua bloqueando;
- `ACTIVATE → REMOVE` ponta a ponta: o ACTIVATE cria **somente** os nodes 1 e 2,
  o REMOVE e aprovado pelo registro e retira apenas o par;
- o fingerprint lista `[10, 1000]` e nunca os nodes 1/2.

---

## DEFESA ADICIONAL — builder fail-closed (inclusive em MOCK)

`buildMitigationActivateCommands` agora recusa gerar comandos quando
`PreservedClauses` esta ausente (`MITIGATION_BASELINE_NOT_DERIVABLE`) ou marcada
como insegura (`MITIGATION_BASELINE_UNSAFE`). Sem baseline verificado **nao
existe** lista de comandos — nem no executor MOCK.

MOCK (decisao do responsavel): baseline simulado **deterministico no estado
inicial/fixture** — `MockMitigationExecutor({ baseline: { node: 10,
targetPrefixList } })` materializa o node normal junto com a policy. Nao existe
criacao automatica por leitura/validacao que encontrou a policy vazia; o
`ACTIVATE` continua criando somente os nodes 1 e 2; `routes.ts` instancia o MOCK
com a lista autorizada do motor. **Nenhuma logica de baseline simulado existe no
executor Huawei real** (que deriva do equipamento e grava o registro duravel).

Efeito colateral explicito: a simulacao de trafego offline (`/simulate`), que
nao le equipamento, deixa de exibir `commandPreview` (lista vazia) em vez de
mostrar um node 2 apenas com a RT.

---

## Compatibilidade e regressao

| Item | Estado |
| --- | --- |
| Suite completa da API | 2779 verdes / 39 skip (2818) |
| `tsc --noEmit` | 0 |
| `eslint --max-warnings=0` | 0 |
| Testes de regressao do REMOVE | verdes (19 em `mitigation-audit-corrections`) |
| Ambiguidade real (2 nodes BOGONS) | continua bloqueada |
| Nodes 1/2 ocupados | continuam bloqueando |
| AGLINK simples / cliente generico seguro | aprovados |
| Diff revisado | 29 arquivos alterados + 5 novos |

Fixture ajustada em `huawei-mitigation-executor.test.ts`: o dump de prefix-lists
passou a incluir `PREFIX-HORIZONTES-IPV4` (referenciada pelo node 11), como no
equipamento real — sem ela o B3 corretamente recusaria.

---

## Riscos residuais

1. O B3 depende do dump de `ip ip-prefix`; dump truncado bloqueia (fail-closed).
2. Node normal que legitimamente carregue a RT de mitigacao e tratado como
   ambiguo → exige reconciliacao manual.
3. Mitigacoes ativas anteriores a esta versao nao tem registro: o REMOVE fica
   bloqueado ate reconciliacao (comportamento exigido pelo B5.6).
4. `CLI_ERROR`/`INTERACTIVE_PROMPT` sao heuristicas de texto do VRP8: falso
   positivo aborta a escrita, nunca libera.

## GO / NO-GO

**GO para deploy em laboratorio com autorizacao explicita do responsavel.**
**NO-GO para ACTIVATE fisico** sem essa autorizacao: nada foi publicado, nada foi
escrito no Huawei, AUTO permanece desligado.
