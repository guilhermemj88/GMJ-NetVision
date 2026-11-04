# Relatório — correções pós-auditoria (D1–D12)

**Data:** 03/11/2026 · **Branch:** `feature/auto-all-ipv4-fast-fixes` (base `0f2af32`) ·
**Worktree:** `C:\projetos\GMJ-NetVision-auto-all-ipv4-fast-fixes`
**Produção:** intacta (`908e7b4`, `LIVE_WRITE=false`, AUTO desligado). Nenhum deploy, nenhum
comando Huawei, nenhuma flag alterada, nenhum restart de serviço produtivo.

Este relatório **não declara GO**. Ele entrega as correções para nova auditoria independente.

---

## 1. Matriz de defeitos

| ID | Status | O que foi feito | Evidência |
| --- | --- | --- | --- |
| **D1** | **Corrigido** | Parsers (`parseHuaweiRoutePolicyNodes`, `parseHuaweiRoutePolicyDisplay`) passaram a **não descartar node 0**. `precedenceConflictNodes()` é a fonte única. Bloqueio em: preflight (`permanent_precedence` → `MITIGATION_NODE_OCCUPIED`), segunda leitura física antes do `commit`, `verifyActivation` (nunca `verified`), `inspectPolicyMitigation` (`RECONCILIATION_REQUIRED` + `precedenceNodes`), discovery (`POLICY_CHANGED`) e `autoExpansionPhysicalScopeMatches`. Nenhuma regra de convivência foi inventada — node 0 sempre bloqueia. | `mitigation-audit-contract-fixes.test.ts` (parser config + display, `precedenceConflictNodes`, `verifyActivation`, planner); `mitigation-policy-physical.test.ts` (node 0) |
| **D2** | **Corrigido** | Resposta `IDEMPOTENCY_CONFLICT` montada do zero: sem `policy`, `interface`, `interfaceId`, `customer`, `verification`, `preflight`, `notification`, `commandPreview`, `executedAt` da outra operação, e **sem esperar** a outra operação terminar. Repetição idempotente da mesma operação preservada. | `mitigation-audit-contract-fixes.test.ts` → "conflito sem policy/interface/verificacao alheias" (verifica também que nenhuma escrita nova ocorre) |
| **D3** | **Corrigido** | `MitigationBaselineStore.release(scope)` novo, implementado nos três stores (memória, durável sobre `MitigationAutomationRecord` → marcador `RELEASED` datado, fake). Retirada **verificada** descarta o registro; falha no descarte vira aviso de reconciliação sem desmentir o estado físico. | idem → bloco D3 (memória + durável com marcador) |
| **D4** | **Corrigido** | `fast-cadence.ts` como fonte única: `max(15 s; 1,5 × cadência)`. Poller, `lifecycleConfig.maxAgeMs/maxGapMs` e `pilotEvidenceValid` usam a **mesma** função. 10 s → 15 s (inalterado), 15 s → 22,5 s, 30 s → 45 s. 5 s continua rejeitado. | `fast-cadence.test.ts` (default/faixa, janela por cadência, igualdade poller×decisão, `pilotEvidenceValid` com 30 s) |
| **D5** | **Corrigido** | Device acima do teto é excluído **sozinho** (sem `throw`, sem `schedules.clear()`); `overLimitDevices` exposto no `status()`. | `fast-telemetry-alert-only.test.ts` → "um device acima do teto NAO derruba a coleta dos demais" |
| **D6** | **Corrigido** | Gap medido entre **chegadas consecutivas**, inclusive quando a amostra seguinte é `BASELINE`/`STALE_INTERVAL` por falha. `gapsOver15Seconds` continua fixo em 15 s; novo `gapsOverContinuityLimit` usa a janela configurada. | `fast-cadence.test.ts` → gap por falha de SNMP conta; cadência normal não gera gap falso |
| **D7** | **Parcial** | `fast-bridge-postgres.test.ts` atualizado para cadência de 10 s (o intervalo de 20 s violava a janela de 15 s). **As suítes PostgreSQL não foram executadas nesta sessão** (sem instância descartável iniciada). | ver §5 (pendência explícita) |
| **D8** | **Corrigido** | `MockMitigationExecutor.remove` usa `buildMitigationRemovalCommands`; par fora de 1/2 ⇒ `MITIGATION_CONTRACT_MISMATCH`, sem comandos. | `mitigation-audit-contract-fixes.test.ts` → bloco D8 (comandos exatos + recusa) |
| **D9** | **Corrigido** | `deny BOGONS` isolado em node permanente continua NORMAL; node **de mitigação** fora de 1/2 (RT660 exclusiva sem `if-match`, ou `PREFIX8to24 + RT`) ⇒ `RECONCILIATION_REQUIRED` com motivo explícito (`mitigation pair outside nodes 1/2` / `half-legacy mitigation`). Sem adoção de nodes. | `mitigation-policy-physical.test.ts`, `mitigation-plan-physical-divergence.test.ts` (expectativas endurecidas) |
| **D10** | **Parcial** | Gates com teste dedicado agora: `MITIGATION_NODE_OCCUPIED` equivalente (`precedence`), `IDEMPOTENCY_CONFLICT`, `FAST_DEVICE_INTERFACE_LIMIT`/`overLimitDevices`, janela de decisão, `gapsOver15Seconds`/`gapsOverContinuityLimit`, paridade do `Mock.remove`. **Sem teste dedicado ainda**: `ALL_IPV4_REQUIRES_OBSERVE`, `observeAllIpv4`, `expansionEnabled`, `autoExpansionPhysicalScopeMatches`, p99. | ver §5 |
| **D11** | **Não aplicável ao código** | A allowlist AUTO de produção já contém CLICKING/PLAY CONNECT/SUPERNET. É ação de **implantação**: com `EXPANSION=1` essa lista armaria 3 perfis não homologados. Registrado como pré-condição da homologação (não alterar a lista em produção por código). | §4 |
| **D12** | **Parcial** | Corrigidos: mensagem do preflight de REMOVE, `selectTemporaryNode` **removido** (comprovadamente morto: só o próprio teste o referenciava), Mock.remove contraditório (agora é o builder). **Pendentes**: devices duplicados aceitos, `MAX_ACTIVE` inválido caindo para 1 sem aviso, `pilotView` compartilhado em `expansionStatus()`. | ver §5 |

---

## 2. Arquivos alterados

Produção (API):

- `apps/api/src/infrastructure/bgp/mitigation/huawei-bgp-policy-parser.ts` — node 0 aceito (config e display).
- `apps/api/src/infrastructure/bgp/mitigation/mitigation-contract.ts` — `precedenceConflictNodes()`.
- `apps/api/src/infrastructure/bgp/mitigation/mitigation-policy-physical.ts` — node 0 + meio-par legado (D1/D9), campo `precedenceNodes`.
- `apps/api/src/infrastructure/bgp/mitigation/mitigation-executor.ts` — `verifyActivation` com precedência; `Mock.remove` pelo builder (D1/D8).
- `apps/api/src/infrastructure/bgp/mitigation/huawei-mitigation-executor.ts` — `permanent_precedence`, checagem na 2ª leitura, mensagem do REMOVE, `releaseBaseline` (D1/D12/D3).
- `apps/api/src/infrastructure/bgp/mitigation/mitigation-baseline-record.ts` — `release()` + marcador (D3).
- `apps/api/src/worker/mitigation/baseline-store.ts` — `release()` durável (D3).
- `apps/api/src/infrastructure/bgp/mitigation/mitigation-test-support.ts` — `release()` no fake.
- `apps/api/src/infrastructure/bgp/mitigation/mitigation-command-service.ts` — conflito sem recibo alheio; descarte do baseline após REMOVE verificado + `BASELINE_RELEASE_FAILED_WARNING` (D2/D3).
- `apps/api/src/infrastructure/bgp/mitigation/mitigation-discovery-service.ts` — node 0 ⇒ `POLICY_CHANGED` + aviso (D1).
- `apps/api/src/infrastructure/bgp/mitigation/mitigation-planner.ts` — `selectTemporaryNode` removido (D12).
- `apps/api/src/infrastructure/snmp/fast-cadence.ts` (**novo**) — cadência/janela, fonte única (D4).
- `apps/api/src/infrastructure/snmp/fast-traffic-poller.ts` — janela derivada, teto por device sem derrubar os demais, gaps entre chegadas (D4/D5/D6).
- `apps/api/src/worker/mitigation/auto-lifecycle.ts` — janela derivada da cadência (D4).
- `apps/api/src/worker/mitigation/single-pilot-trigger.ts` — `pilotEvidenceValid` com janela; `FAST_DEFAULT_WINDOW` (D4).
- `apps/api/src/worker/mitigation/auto-expansion-scope.ts` — node 0 explícito no escopo físico (D1).
- `apps/api/src/routes.ts` — janela efetiva passada ao `pilotEvidenceValid` (D4).

Testes:

- `infrastructure/bgp/mitigation/mitigation-audit-contract-fixes.test.ts` (**novo**) — D1, D2, D3, D8.
- `infrastructure/snmp/fast-cadence.test.ts` (**novo**) — D4, D6.
- `infrastructure/snmp/fast-telemetry-alert-only.test.ts` — D5 (teto por device + isolamento entre devices).
- `infrastructure/bgp/mitigation/mitigation-policy-physical.test.ts` — D1/D9.
- `infrastructure/bgp/mitigation/mitigation-plan-physical-divergence.test.ts` — D9.
- `infrastructure/bgp/mitigation/mitigation-domain.test.ts` — remoção do teste da API morta.
- `infrastructure/bgp/mitigation/mitigation-b6-durability.test.ts`, `mitigation-final-defects.test.ts` — stores inline com `release()`.
- `worker/mitigation/fast-bridge-postgres.test.ts` — cadência de 10 s (D7).

Documentação:

- `docs/AUTO_ALL_IPV4_FAST.md` — nova §7 (correções D1–D12).
- `RELATORIO-CORRECOES-POS-AUDITORIA-AUTO-ALL-IPV4-FAST.md` (este arquivo).

---

## 3. Resultados de validação (executados nesta sessão)

| Verificação | Comando | Resultado |
| --- | --- | --- |
| Typecheck (todos os workspaces) | `npm run typecheck` | **0 erros** |
| ESLint (raiz e `apps/api`, `--max-warnings=0`) | `npm run lint` · `npx eslint .` | **0 erros / 0 warnings** |
| Build API | `npm run build -w @gmj/api` | **sucesso** |
| Suíte API completa | `vitest run` | **2833 aprovados · 41 ignorados · 0 falhas** (após o build; o único teste dependente de `dist/` passa) |
| Suítes PostgreSQL (descartável) | — | **NÃO EXECUTADAS nesta sessão** |
| Simulador FAST 5/10/15/30 s | — | **NÃO RE-EXECUTADO nesta sessão** |

Os 41 ignorados continuam sendo as suítes habilitadas por variável de ambiente
(`MITIGATION_BASELINE_TEST_DATABASE_URL`, `SINGLE_PILOT_*_DATABASE_URL`,
`FAST_TEST_DATABASE_URL`, `TELEMETRY_TEST_DATABASE_URL`, `NETVISION_PHASE01_TEST_DB`),
o bloco `skipIf(RC13)` e o teste de tempo real `FAST_REALTIME_TEST=1`.

### 3.1 Sobre os tempos de detecção (14 s / 18 s / 34,5 s / 38 s / 70 s)

Esses números **são medições do laboratório sintético da auditoria**, não desta sessão, e
não são reapresentados aqui como medição nova. O que esta entrega acrescenta é a
**explicação estrutural** e a correção que a endereça:

- Cadência nominal de 10 s + fase aleatória do degrau ⇒ a primeira amostra anormal cai
  entre 10 s e 20 s depois do início do ataque (p50 ≈ 14 s, p95 ≈ 18 s). O piso é a
  cadência; o teto é cadência + um intervalo perdido.
- Confirmação exige **três amostras novas consecutivas** acima do limiar: ≈ 2 × cadência
  depois da primeira anormal ⇒ p50 ≈ 34,5 s, coerente com 14 s + 20 s.
- Com 3 % de timeouts, a sequência reinicia e o baseline é refeito: uma perda isolada
  adiciona uma janela inteira ⇒ p95 ≈ 70 s. Isso é **propriedade do contrato de três
  amostras**, não um bug: nenhuma amostra antiga é reaproveitada.
- Antes da correção D4, a decisão usava 15 s fixos: com cadência de 15 s a confirmação
  ocorria em 6/40 execuções e com 30 s **nunca**. Agora a janela acompanha a cadência
  (22,5 s e 45 s), mantendo o piso de 15 s para 10 s.

Tempo real de SSH (comando + readback) no NE8000 continua **NOT_VERIFIED** — só a
homologação física mede isso.

---

## 4. Regressão B3–B6 / M8

- **B3–B6 preservados**: baseline durável gravado **antes** da primeira escrita, prova de
  existência no store, `durable !== true` recusado, drift de node permanente bloqueando o
  REMOVE, journal e outbox transacionais, lock por escopo, `UNCERTAIN` sem replay.
  Nenhuma dessas verificações foi removida; a única mudança é o **descarte** do registro
  após retirada verificada (D3), que **endurece** o ownership.
- **M8 preservado**: `MITIGATION_AUTO_REMOVE_ENABLED ≠ 0` continua abortando o boot e o
  REMOVE automático continua impossível (nenhum caminho novo foi criado).
- Suítes `mitigation-b6-durability`, `mitigation-m8-write-matrix`, `baseline-store`,
  `single-pilot` e `readiness` permanecem verdes na suíte completa.

---

## 5. Pendências efetivas antes da homologação AGLINK

1. **D7** — executar as suítes PostgreSQL em instância descartável (as 43, incluindo
   `fast-bridge-postgres` corrigida, `telemetry`, `single-pilot` e `baseline`).
2. **D10** — testes dedicados para `ALL_IPV4_REQUIRES_OBSERVE`, `observeAllIpv4`,
   `expansionEnabled`, `autoExpansionPhysicalScopeMatches` e p99 de intervalos.
3. **D12** — devices duplicados na expansão, aviso explícito para `MAX_ACTIVE` inválido e
   `pilotView` por perfil em `expansionStatus()`.
4. **D11 (operador)** — antes de qualquer `EXPANSION=1`: revisar
   `MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS` em produção (hoje com CLICKING, PLAY
   CONNECT e SUPERNET), pois ligar a expansão muda o significado dessa lista.
5. **D9 na prática** — policies com resquício de mitigação passam a exigir reconciliação
   manual. Afetados no snapshot: **CLICKING** (node 50 com RT660) e **HORIZONTE_IP** (node
   11). Esses perfis deixam de ser "candidatos com ressalva" e passam a **NÃO APTO** até o
   operador decidir sobre o node.
6. **Simulador FAST** nas quatro cadências, com o código corrigido, para registrar
   p50/p95/p99 de 1ª amostra anormal e confirmação — e a carga de escrita no Postgres.
7. **R1** — janela TOCTOU entre a 2ª leitura e o `commit` continua inerente sem lock de
   configuração no equipamento; mitigação é operacional (janela de mudança congelada).

---

## 6. Matriz de prontidão — efeito das correções

- 23/23 perfis IPv4 continuam observáveis com a flag de observação.
- 12/23 com telemetria FAST e direção `tx`.
- **Mudança de classificação por D9**: perfis cuja policy tem node de mitigação fora de 1/2
  deixam de ser NORMAL. No snapshot auditado isso atinge **CLICKING (3528, node 50)** e
  **HORIZONTE_IP (3011, node 11)**. Os demais 21 permanecem como estavam.
- **Nenhum perfil está autorizado fisicamente.** A lista de candidatos técnicos continua
  sendo 5 (73S, AGLINK, PLAY CONNECT, SUPERNET e CLICKING **somente após** reconciliação do
  node 50).
- IPv6 (16 perfis) segue fora da execução física automática.
