# Mecanismo único de mitigação BGP — implementação na branch isolada

**Data:** 2026-11-01 · **Branch:** `feature/aglink-activate-safety` · worktree `c:\projetos\GMJ-NetVision-aglink-activate-safety`
**Commit desta missão:** `6acfd14` · anteriores: `3e9b539`, `a4f1d00`, `0c4bcb2`
**Nada foi publicado nem executado no Huawei** — sem `system-view`, `commit`, `save`, ACTIVATE ou REMOVE.

---

# 1. O que mudou

O gerador de comandos tinha um caminho exclusivo para a AGLINK (LP 1100 e RT 140 fixos no código). Agora existe **um único mecanismo**, igual para qualquer policy IN:

```
node 1 -> deny   + if-match ip-prefix BOGONS
node 2 -> permit + if-match ip-prefix <prefix-list autorizada do cliente>
                   <atributos NORMAIS do cliente, derivados do próprio equipamento>
                   apply extcommunity rt <RTs normais> rt <RT de mitigação> additive
```

Os atributos do cliente **não vêm de constantes** — são derivados do node `permit` que hoje casa a prefix-list autorizada, lido do equipamento.

## 1.1 Módulo novo

[`mitigation-policy-clauses.ts`](apps/api/src/infrastructure/bgp/mitigation/mitigation-policy-clauses.ts):

| Função | Papel |
|---|---|
| `policyNodeClauses` | cláusulas de um node, aceitando formato de **configuração** e de **display** |
| `policyNodes` | todos os nodes de uma policy em uma passada |
| `derivePreservedClauses` | deriva, do baseline físico, o que o node 2 precisa repor |
| `buildRouteTargetLine` | monta **uma** instrução `apply extcommunity` com todas as RTs + `additive` |

`derivePreservedClauses` separa o que encontra em:

- `localPreference` — `apply local-preference N` (último vence, como no VRP);
- `routeTargets` — todas as RTs normais do cliente;
- `otherApplies` — demais `apply` (`community`, `as-path`, `cost`…) copiados verbatim;
- `expectedClauses` — o conjunto **exato** esperado no node 2, usado no readback.

## 1.2 Sintaxe VRP8 (confirmada no equipamento)

| Evidência em `BHE-VTA-F1A` (1 047 linhas de route-policy) | Resultado |
|---|---|
| Nodes com **duas linhas** `apply extcommunity` | **0 (zero)** |
| Nodes com **múltiplas RTs numa única instrução** | **1** — `apply extcommunity rt A rt B additive` |

Por isso a RT de mitigação entra na **mesma** instrução das RTs normais, sempre com `additive`:
`additive` preserva as extended communities já recebidas do peer (ex.: RT330).

## 1.3 Defeito encontrado e corrigido

O cabeçalho **`Apply clauses:`** do formato `display route-policy` era capturado como se fosse uma cláusula em **três** parsers. Como o readback de produção usa exatamente esse formato, uma configuração correta seria **rejeitada** no equipamento real. Corrigido em `mitigation-policy-clauses.ts`, `mitigation-node-snapshot.ts` e `aglink-bgp-plan.ts` (regex `^(if-match|apply|goto)\s+(?!clauses\b)`).

---

# 2. Fluxo do ACTIVATE

| Etapa | O que acontece |
|---|---|
| Preflight (leitura) | lê a policy; classifica ocupação de 1/2; **deriva os atributos do cliente**; valida prefix-lists, baseline e RT |
| Resultado do preflight | devolve `nodeOccupancy` (com snapshots) e `preservedClauses` |
| Escrita | `buildMitigationActivateCommands(plan, preservedClauses)` — par de nodes, nada mais |
| Readback | `verifyActivation(..., preservedClauses)` exige o conjunto **exato** de cláusulas no node 2 |

`preserved_attributes` é **informativo** (nunca bloqueia sozinho): quando não existe node `permit` com a prefix-list alvo, não há atributo identificável a repor e o node 2 leva apenas a RT com `additive` — exatamente o comportamento anterior, mantendo os demais clientes funcionando.

---

# 3. Caso A × Caso B (nodes 1 e 2)

| Situação | Status | Comportamento |
|---|---|---|
| 1 e 2 livres | `FREE_PAIR` | cria os dois nodes |
| Um ocupado | `PARTIALLY_OCCUPIED` | identifica o conflito, captura snapshot do node existente, **bloqueia** |
| Ambos ocupados | `FULLY_OCCUPIED` | dois snapshots, **bloqueia** |

- snapshot guarda `action` + **cláusulas verbatim** + `capturedAt` + **sha256 do read-back integral**;
- snapshot inválido → `NODE_SNAPSHOT_INCOMPLETE` e `buildNodeRestoreCommands` lança `MITIGATION_NODE_SNAPSHOT_INVALID`;
- **nunca** sobrescreve node preexistente (nada é enviado ao equipamento);
- REMOVE: node criado → `undo`; node preexistente → `undo` + **recriação exata**; `nodeMatchesSnapshot` reprova divergência física.

---

# 4. Testes

| Suíte | Casos | Foco |
|---|---|---|
| [`aglink-activate-contract.test.ts`](apps/api/src/infrastructure/bgp/mitigation/aglink-activate-contract.test.ts) | **19** | par de nodes, 10/1000 intocados, LP e RTs preservadas, RT de mitigação com `additive`, **uma só instrução `apply`**, readback exato, **cliente com policy/LP/RT totalmente diferentes**, caso sem atributos deriváveis |
| [`mitigation-node-snapshot.test.ts`](apps/api/src/infrastructure/bgp/mitigation/mitigation-node-snapshot.test.ts) | **17** | caso A, B parcial, B total, snapshot sem integridade, REMOVE com/sem snapshot, round-trip byte a byte, divergência física |
| [`aglink-bgp-plan.test.ts`](apps/api/src/infrastructure/bgp/mitigation/aglink-bgp-plan.test.ts) | 15 | semântica antes/durante/depois, preview = SSH canônico, divergências rejeitadas |
| [`huawei-mitigation-executor.test.ts`](apps/api/src/infrastructure/bgp/mitigation/huawei-mitigation-executor.test.ts) | 41 | preflight, ocupação, fail-closed |
| [`ssh-client-impl.test.ts`](apps/api/src/infrastructure/ssh/ssh-client-impl.test.ts) | 15 | prompt interativo aborta sem responder (fail-safe mantido) |

**Resultados:** suíte da API **2742 testes / 0 falhas** · `tsc --noEmit` exit 0 · `eslint --max-warnings=0` exit 0.

---

# 5. O que NÃO foi feito (por decisão da missão)

| Item | Situação |
|---|---|
| Tratamento por fornecedor de trânsito | **não existe** — nenhuma menção a CIRION/TUDDO/SEABORN/VS-IX no mecanismo |
| Alteração de policies OUT | **nenhuma** |
| Mecanismo adicional de desvio de tráfego | **não implementado** |
| AUTO / REMOVE automático | permanecem **desligados** |
| Substituição de node ocupado | apenas **bloqueio + snapshot**; habilitar exige procedimento autorizado e validação física |
| Publicação / deploy | **não executados** |

---

# 6. Pontos para a revisão do Claude

1. Recalcular do equipamento a evidência de sintaxe (0 nodes com duas linhas `apply`, 1 com multi-RT).
2. Conferir que `derivePreservedClauses` escolhe o **primeiro** node `permit` que casa a prefix-list autorizada e que nada é hardcoded por cliente.
3. Conferir que `verifyActivation` só exige igualdade exata quando `preserved` é fornecido, e que a ausência de baseline não bloqueia.
4. Conferir que o preflight **bloqueia** com node ocupado e que `applied` fica vazio.
5. Conferir o round-trip de restauração contra o snapshot.
6. Confirmar o fix do `Apply clauses:` nos três parsers (era um falso-negativo no readback real).
7. Verificar que nenhum caminho toca nodes 10/1000, outras policies ou LP global.

---

## Confirmação de não-alteração

Nenhuma escrita no roteador (nem `commit`/`save`), nenhum ACTIVATE/REMOVE, nenhum deploy, nada alterado em produção, API, n8n, Telegram, flags AUTO ou catálogo físico. Nenhuma leitura de equipamento nesta missão (usei apenas evidência já coletada). API segue `active`, PID 3460475, `NRestarts=0`, `/health` 200.
