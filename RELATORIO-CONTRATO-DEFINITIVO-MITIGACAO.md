# Contrato definitivo de mitigação BGP — implementação na branch isolada

**Data:** 2026-11-01 · **Branch:** `feature/aglink-activate-safety` · worktree `c:\projetos\GMJ-NetVision-aglink-activate-safety`
**Commits:** `3e9b539` (contrato + ocupação de nodes) · `a4f1d00` (fail-safe do transporte) · `0c4bcb2` (relatório anterior)
**Nada foi executado no Huawei** — sem `system-view`, `commit`, `save`, ACTIVATE ou REMOVE. Sem deploy.

> Este relatório **substitui** a seção C.3 de [`RELATORIO-PREPARACAO-ACTIVATE-AGLINK.md`](RELATORIO-PREPARACAO-ACTIVATE-AGLINK.md): a decisão definitiva do responsável técnico é preservar LP1100, RT140 e RT330, e a implementação foi ajustada para isso.

---

# 1. O que mudou no contrato

| Item | Antes | **Agora (definitivo)** |
|---|---|---|
| Node 2 — extended communities | `apply extcommunity rt 268568:660` (substituía tudo) | **`apply extcommunity rt 268568:140 rt 268568:660 additive`** |
| LP 1100 | reposto no node 2 | reposto no node 2 (inalterado) |
| RT 268568:140 | descartada durante a mitigação | **reaplicada** no node 2 |
| RT 268568:330 (recebida do peer) | descartada | **preservada** (`additive` não substitui) |
| Nodes existentes | bloqueio simples | **snapshot integral + conflito explícito** (caso B) |
| REMOVE | `undo` dos dois nodes | `undo` + **restauração exata** quando o node já existia |
| Transporte SSH | detectava prompt só no modo diagnostic | **fail-closed em toda escrita** (`a4f1d00`) |

## 1.1 Sintaxe VRP8 validada no próprio equipamento

O contrato pede duas RTs no mesmo node. A forma correta **não** é repetir a instrução:

| Evidência coletada em `BHE-VTA-F1A` (1.047 linhas de route-policy) | Resultado |
|---|---|
| Nodes com **duas linhas** `apply extcommunity` consecutivas | **0 (zero)** |
| Nodes com **múltiplas RTs numa única instrução** | **1** — `apply extcommunity rt 268568:140 rt 268568:28329 additive` |

Portanto a forma emitida é uma única instrução com `additive` ao final:

```
apply extcommunity rt 268568:140 rt 268568:660 additive
```

Efeito semântico: **acrescenta** RT140 (que viria do node 10) e RT660 (mitigação) sem remover as communities já presentes na rota (RT330 do peer).

## 1.2 Correção necessária no parser

O extrator de RTs casava apenas a **primeira** RT da linha. Com a forma multi-RT ele leria `268568:140` e ignoraria `268568:660` — o readback passaria a rejeitar uma configuração correta. Corrigido em [`huawei-bgp-policy-parser.ts`](apps/api/src/infrastructure/bgp/mitigation/huawei-bgp-policy-parser.ts) com `appliedRouteTargets()`, que varre todas as RTs da instrução (ignorando o `additive`).

---

# 2. CASO A × CASO B — nodes livres e nodes ocupados

## 2.1 Classificação

Novo módulo [`mitigation-node-snapshot.ts`](apps/api/src/infrastructure/bgp/mitigation/mitigation-node-snapshot.ts):

| Situação | `status` | Comportamento |
|---|---|---|
| Nodes 1 e 2 inexistentes | `FREE_PAIR` | cria os dois nodes (caso A) |
| Um dos dois já existe | `PARTIALLY_OCCUPIED` | identifica o conflito, captura snapshot do node existente e **bloqueia** |
| Os dois já existem | `FULLY_OCCUPIED` | captura os dois snapshots e **bloqueia** |

O snapshot guarda, por node: `policyName`, `node`, `action`, **cláusulas verbatim** (`if-match` / `apply` / `goto`), `capturedAt` e o **sha256 do read-back integral** de onde foi extraído.

## 2.2 Bloqueio (fail-closed)

O preflight do executor ganhou o check `node_occupancy` e expõe `nodeOccupancy` no resultado:

- **caso A** → `ok: true`, `snapshots: []`;
- **caso B** → `ok: false` com `reason: NODE_OCCUPIED_REPLACEMENT_NOT_AUTHORIZED`, listando os nodes em conflito e confirmando quantos snapshots foram capturados. **Nenhum comando é enviado ao equipamento.**
- snapshot malformado ou incompleto → `reason: NODE_SNAPSHOT_INCOMPLETE` (também bloqueia). `buildNodeRestoreCommands` lança `MITIGATION_NODE_SNAPSHOT_INVALID` — nunca restaura a partir de snapshot inválido.

Não existe hoje procedimento de substituição autorizado, então o bloqueio é o comportamento correto conforme o contrato ("se não for possível garantir a segurança, bloquear e informar o conflito").

## 2.3 REMOVE com restauração exata

[`buildSnapshotAwareRemovalCommands`](apps/api/src/infrastructure/bgp/mitigation/mitigation-node-snapshot.ts):

```
system-view
undo route-policy <P> node 1
route-policy <P> deny node 1          <- só se o node já existia
 if-match ip-prefix CLIENTE-BLOQUEADO
undo route-policy <P> node 2
route-policy <P> permit node 2        <- só se o node já existia
 if-match ip-prefix OPERADOR
 apply local-preference 900
 apply extcommunity rt 268568:999 additive
commit
```

- node **criado** pela mitigação (sem snapshot) → apenas `undo`;
- node **preexistente** (com snapshot) → `undo` + recriação **exata**;
- nenhum outro node é tocado (`nodeMatchesSnapshot` + teste que garante ausência de `node 10`);
- `nodeMatchesSnapshot` reprova quando o estado físico divergir → a mitigação **não** é declarada removida com divergência física.

## 2.4 Idempotência, concorrência e falha

| Requisito | Como está coberto |
|---|---|
| Idempotência | `execute` já tem caminho idempotente por `requestId`; o par é resolvido do runtime/dispositivo antes de escrever |
| Commits concorrentes | `mitigation-policy-lock.ts` + `policyBusyResult` no serviço de comandos |
| Falha após início da escrita | `writeAttempted` → runtime do escopo vai para `RECONCILIATION_REQUIRED`; verificação pós-commit é obrigatória |
| Nunca responder `Y` | `abortOnInteractivePrompt` no transporte (commit `a4f1d00`) |
| Divergência física | `inspectPolicyMitigation` → `RECONCILIATION_REQUIRED` bloqueia escrita destrutiva |

---

# 3. Testes

| Suíte | Casos | Cobre |
|---|---|---|
| [`aglink-activate-contract.test.ts`](apps/api/src/infrastructure/bgp/mitigation/aglink-activate-contract.test.ts) | **17** | nodes 1/2 criados, 10/1000 intocados, LP1100, RT140+RT330 preservadas, RT660 acrescentada, **uma única instrução `apply`**, readback físico e rejeição de cada divergência (incluindo RT660 sem `additive` e RT140 ausente), REMOVE restaurando, isolamento de outros clientes |
| [`mitigation-node-snapshot.test.ts`](apps/api/src/infrastructure/bgp/mitigation/mitigation-node-snapshot.test.ts) | **17** | extração integral do node, **caso A**, **caso B parcial**, **caso B total**, snapshot sem integridade rejeitado, REMOVE com e sem snapshot, **round-trip byte a byte**, divergência física detectada, nodes não envolvidos preservados |
| [`huawei-mitigation-executor.test.ts`](apps/api/src/infrastructure/bgp/mitigation/huawei-mitigation-executor.test.ts) | +3 (41 no total) | preflight `node_occupancy` nos três cenários, com prova de que nada foi escrito |
| [`ssh-client-impl.test.ts`](apps/api/src/infrastructure/ssh/ssh-client-impl.test.ts) | +3 (15 no total) | prompt `[Y/N]`/`--More--` aborta sem responder; leitura não é afetada |
| [`aglink-bgp-plan.test.ts`](apps/api/src/infrastructure/bgp/mitigation/aglink-bgp-plan.test.ts) | 15 | semântica antes/durante/depois pelo modelo de referência |

**Resultados**

| Verificação | Resultado |
|---|---|
| Suíte completa da API | **2740 testes, 0 falhas** (188 arquivos ok, 7 skipped) |
| `tsc --noEmit` | exit 0 |
| `eslint --max-warnings=0` nos arquivos alterados | exit 0 |

---

# 4. Configuração física esperada

## ACTIVATE (caso A)

```
system-view
route-policy PL-AGLINK_IPv4-IN deny node 1
 if-match ip-prefix BOGONS
route-policy PL-AGLINK_IPv4-IN permit node 2
 if-match ip-prefix AGLINK-BLOCO-TODO-23
 apply local-preference 1100
 apply extcommunity rt 268568:140 rt 268568:660 additive
commit
```

Estado resultante (ordem de avaliação 1 → 2 → 10 → 1000):

| Prefixo AGLINK | Node que casa | LP | Extended communities |
|---|---|---|---|
| 167.250.126.0/23 · .126.0/24 · .127.0/24 | **2** | **1100** | **330 (peer) + 140 + 660** |
| demais prefixos | 10 (inalterado) ou 1000 | — | — |

## REMOVE

```
system-view
undo route-policy PL-AGLINK_IPv4-IN node 1
undo route-policy PL-AGLINK_IPv4-IN node 2
commit
```
Depois: node 10 volta a casar e as três rotas retornam a **LP 1100 + RT 140 + RT 330** (sem RT660).

---

# 5. Revisão independente (Claude) — pontos a conferir

1. Recalcular a partir do equipamento a evidência de sintaxe multi-RT (0 nós com duas linhas `apply`, 1 com multi-RT) — é o fundamento da forma escolhida.
2. Conferir que `aglinkActivationIntact` exige exatamente `if-match + LP1100 + apply rt 140 rt 660 additive` e que qualquer variação reprova.
3. Conferir que o parser agora devolve **todas** as RTs de uma linha e que o teste de regressão do parser segue verde.
4. Conferir que o preflight **bloqueia** com node ocupado e que `applied` fica vazio (nada enviado).
5. Conferir o round-trip de restauração: `undo` + recriação reproduz o node original byte a byte.
6. Confirmar que nenhuma alteração toca nodes 10/1000, outras policies, LP global ou policies de outros provedores.
7. Avaliar o ponto operacional: com RT140 preservada, as três rotas continuam sendo anunciadas aos provedores normais cujas policies **não** negam RT660 sozinha (CIRION, TUDDO, VS-IX; SEMPRE/SEABORN exigem `MITIGACAO` **AND** `NO-EXPORT`). Se a intenção for desviar o tráfego, será necessário tratar isso nas policies de saída — decisão de escopo, não de código.

---

# 6. Pendências e limites

| # | Pendência |
|---|---|
| P1 | **Substituição de node ocupado não está habilitada** — só o bloqueio + snapshot. Habilitar exige procedimento autorizado e validação em equipamento. |
| P2 | O snapshot é devolvido no preflight/resultado; a **persistência durável** entre ACTIVATE e REMOVE ainda precisa ser ligada a `MitigationAutomationRecord` (kind/status/payload) quando a substituição for autorizada. |
| P3 | A correção não está publicada: a API em produção (`bf7bc52`) roda o cliente SSH antigo, sem fail-safe de prompt. |
| P4 | Homologação física continua dependendo das confirmações da COMPUTIZE e de autorização one-shot. |

---

## Confirmação de não-alteração

Nenhuma escrita no roteador (nem `commit`, nem `save`), nenhum ACTIVATE/REMOVE, nenhum deploy, nenhuma alteração em produção, API, n8n, Telegram, flags AUTO ou catálogo físico. Leituras do equipamento foram feitas por `display` em sessão read-only e os helpers efêmeros foram removidos do servidor. API segue `active`, PID 3460475, `NRestarts=0`, `/health` 200.
