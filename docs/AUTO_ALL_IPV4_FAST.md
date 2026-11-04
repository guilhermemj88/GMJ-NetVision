# Contrato BGP IPv4 definitivo, FAST para todos os IPv4 e preparação AUTO-ALL

**03/11/2026 — implementação em desenvolvimento (branch `feature/auto-all-ipv4-fast`).**
Nada foi publicado, nenhuma flag produtiva foi alterada e nenhum comando foi enviado ao
equipamento. Produção segue em `908e7b4` com `LIVE_WRITE=false` e AUTO de execução desligado.

---

## 1. Contrato aprovado pelo operador

```text
route-policy PL-CLIENTE_IPv4-IN deny node 1
 if-match ip-prefix BOGONS
#
route-policy PL-CLIENTE_IPv4-IN permit node 2
 apply extcommunity rt 268568:660
#
```

- Node 2 **não** tem `if-match`, prefix-list, `local-preference`, `additive`, `goto` nem
  qualquer cláusula derivada do node 10.
- O conjunto efetivo de RTs da rota mitigada é exatamente `{268568:660}`.
- Par fixo: nodes **1 e 2**. Não existe alocação dinâmica de par.
- Nodes permanentes (10, 1000, 50, ...) permanecem intocados; o baseline completo é
  preservado como evidência e usado no fingerprint de drift.
- Remoção é **exclusivamente humana** e retira apenas 1/2 com ownership comprovado.

### 1.1 Amplitude do `permit` sem `if-match` (autorizada, registrada)

Como a avaliação da route-policy termina no primeiro node que casa, o node 2 passa a
aceitar **qualquer NLRI** que não tenha casado com BOGONS no node 1 — inclusive prefixos
que o node 10 normalmente rejeitaria (ex.: `167.250.126.0/25`, `8.8.8.0/24`, `0.0.0.0/0`).
A auditoria independente confirmou que **não há proteção independente de prefixos** na
configuração BGP capturada (sem `peer ip-prefix`, `filter-policy`, `as-path-filter` nem
grupo com filtro herdado) e que a lista BOGONS não cobre default route.

O operador **aceitou explicitamente** esse alcance. Ele é documentado e testado
(`aglink-bgp-plan.test.ts` → "amplitude autorizada"), **não** é tratado como defeito e
**nenhum filtro adicional** foi acrescentado unilateralmente. A amplitude alcança todos os
peers que compartilham a policy, não apenas a interface que detectou o limiar.

### 1.2 Ocupação dos nodes 1/2

- Node 1 ou 2 ocupado por configuração que não seja exatamente o contrato ⇒ **NÃO APTO**
  (`RECONCILIATION_REQUIRED`), com cliente, equipamento, policy e nodes ocupados.
- Não há sobrescrita, renomeação, adoção ou deslocamento automático.
- Par já ativo e comprovadamente gerenciado pelo NetVision não autoriza segundo ACTIVATE;
  o estado é reconciliado.
- A verificação de ocupação é refeita **na segunda leitura física, imediatamente antes da
  escrita**, sob serialização — fecha a corrida entre preflight e escrita.

## 2. Correções de concorrência e idempotência

| Defeito                                           | Correção                                                                                                                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Corrida de ocupação 1/2 entre preflight e escrita | rechecagem em `activate()` sobre a leitura fresca, antes de qualquer comando, com erro `MITIGATION_NODE_OCCUPIED`                                                                                               |
| Colisão de `requestId` entre ações/perfis         | identidade `(profileId, action, origin, isAutomatic, autoOperationId)`; resposta `IDEMPOTENCY_CONFLICT` sem escrita; chamadas concorrentes com o mesmo `requestId` são serializadas e recebem o mesmo resultado |
| Readbacks que rejeitavam o contrato novo          | `verifyActivation`/`inspectPolicyMitigation` passaram a exigir exatamente o node 1/2 do contrato                                                                                                                |
| Reconciliação após restart/timeout/estado incerto | mantida via runtime `UNCERTAIN` + journal + baseline durável (`MITIGATION_BASELINE_RECORD_UNAVAILABLE`, `MITIGATION_BASELINE_DIVERGED`), agora comparando o registro com a leitura fresca                       |

## 3. Proteções preservadas

B3 (vínculos peer/policy/família, contenda de policy compartilhada), B4 (transporte,
prompt, erro de CLI, igualdade preview=escrita), B5 (fingerprint/drift dos nodes
permanentes), B6 (persistência durável obrigatória, releitura antes de escrever), M8,
locks por policy, journal, ownership e REMOVE exclusivamente humano.

## 4. FAST — observação RX/TX de todas as interfaces IPv4

- `MITIGATION_FAST_ALL_IPV4_OBSERVATION_ENABLED=1` habilita a observação de **todos** os
  perfis IPv4 cadastrados (23), sem exigir direção configurada e **exigindo modo OBSERVE**
  (`ALL_IPV4_REQUIRES_OBSERVE`); a flag é desligada por padrão.
- Direção continua obrigatória para **ACTIVATE**: perfil sem direção validada é observado,
  mas nunca autoriza escrita.
- Coleta nominal mantida em **10 s** (default `MITIGATION_FAST_NORMAL_SECONDS=10`, faixa
  10–30); `maxGap` 15 s; até 32 interfaces por device; concorrência 2.
- Instrumentação nova: `p50/p95/p99` dos intervalos reais, contador de gaps > 15 s,
  latência de coleta e de persistência, `monitoredInterfaces`.
- Counter64, reset/wrap/discontinuidade, amostra duplicada/atrasada e três amostras
  consecutivas acima do limiar continuam tratados como antes (sequência reinicia em
  qualquer perda de continuidade).

### 4.1 Como medir em ambiente controlado (não habilitado nesta missão)

1. Subir o observer com `MITIGATION_FAST_MODE=OBSERVE` e
   `MITIGATION_FAST_ALL_IPV4_OBSERVATION_ENABLED=1` em laboratório.
2. Coletar `stats` do poller por 30 min: `intervalStats` (p50/p95/p99/max),
   `gapsOver15Seconds`, `collectionLatencyMs`, `persistenceLatencyMs`.
3. Comparar com o baseline auditado (gaps > 15 s em parte das interfaces).
4. Medir custo de CPU/RSS/I-O do processo observer e a carga de escrita no Postgres.

## 5. Preparação AUTO-ALL IPv4

- `LifecycleConfig.expansionEnabled` (`MITIGATION_AUTO_EXPANSION_ENABLED`) separa
  **modo desejado AUTO** de **autorização de execução física**.
- Com expansão ligada, `assertSinglePilotAuthorization` exige IMPLANTAR, lista explícita de
  perfis e devices (sem duplicatas, ≤128), `maxActive` entre 1 e 10 — senão
  `AUTO_EXPANSION_EXPLICIT_AUTHORIZATION_REQUIRED`. Sem expansão continua o piloto único
  AGLINK.
- `AutoMitigationLifecycle` passou a manter estado **por perfil** (`sequences`, `acceptAfter`,
  `views`, `expansionStatus()`), com um único escritor global e limite `maxActive`.
- Elegibilidade individual exige: nodes 1/2 livres, RT 268568:660, telemetria FAST válida,
  `scopeMembers === 1`, policy não compartilhada, sem AUTO da outra família, direção
  validada, runtime NORMAL/ALERT_ONLY, sem ownership ativo e sem cooldown.
- Os 16 perfis IPv6 continuam fora da execução física automática.

## 6. Limites desta entrega

- Nenhuma homologação física; nenhum comando de configuração foi enviado ao Huawei.
- A semântica de substituição de RT sem `additive` e o LP efetivo durante a mitigação
  continuam **NOT_VERIFIED** até homologação autorizada.
- `MITIGATION_TEST` (botão TESTAR WEBHOOK) segue exigindo `delivered=true` — pendência
  separada, fora deste escopo.

## 7. Correções pós-auditoria (D1–D12)

Aplicadas na branch `feature/auto-all-ipv4-fast-fixes`. Nenhum mecanismo de segurança foi
afrouxado: as correções endurecem ou consertam gates.

### 7.1 D1 — node 0 (precedência sobre o par reservado)

- `parseHuaweiRoutePolicyNodes` e `parseHuaweiRoutePolicyDisplay` deixaram de descartar
  node 0 (`node <= 0` / `node > 0` → `node < 0` / `node >= 0`). O parser agora descreve o
  que existe no equipamento; quem decide é a camada de mitigação.
- `precedenceConflictNodes()` (em `mitigation-contract.ts`) é a fonte única.
- Bloqueiam a escrita e/ou a classificação:
  - preflight (`permanent_precedence`) — `MITIGATION_NODE_OCCUPIED`;
  - segunda leitura física antes do `commit`;
  - `verifyActivation` — node 0 ⇒ **nunca** `verified`;
  - `inspectPolicyMitigation` — `RECONCILIATION_REQUIRED` + `precedenceNodes`;
  - discovery (`POLICY_CHANGED`) e `autoExpansionPhysicalScopeMatches`.
- Não foi inventada regra de convivência com node 0: ele sempre bloqueia.

### 7.2 D9 — meio-par legado e RT de mitigação fora de 1/2

- `deny BOGONS` isolado em node permanente continua **legítimo** (política do cliente).
- Node **de mitigação** fora de 1/2 (RT 268568:660 exclusiva sem `if-match`, ou a forma
  legada `if-match PREFIX8to24 + RT`) ⇒ `RECONCILIATION_REQUIRED`, com motivo
  `mitigation pair outside nodes 1/2` (par completo) ou
  `mitigation node outside nodes 1/2 without the BOGONS pair (half-legacy mitigation)`.
- Nenhum node é adotado, renumerado ou removido por essa classificação.

### 7.3 D2 — `IDEMPOTENCY_CONFLICT` sem recibo alheio

- A resposta de conflito é montada do zero: `policy`, `interface`, `interfaceId`,
  `customer`, `verification`, `preflight`, `notification`, `commandPreview` e
  `executedAt` **nunca** vêm da operação anterior, e o conflito **não espera** a outra
  operação terminar.
- A repetição idempotente da **mesma** operação continua devolvendo o mesmo recibo.

### 7.4 D3 — ownership do baseline

- `MitigationBaselineStore` ganhou `release(scope)`: uma retirada **verificada** descarta o
  registro do escopo (o store durável grava um marcador `RELEASED` datado).
- Consequência: um par textualmente idêntico criado **depois** por terceiros já não é
  adotado — `resolveActivePair` e o preflight de REMOVE voltam a exigir um novo ACTIVATE,
  que recaptura o baseline antes da primeira escrita.
- Se o descarte falhar, a retirada continua reportada como verificada (fato físico) **com
  aviso** de reconciliação obrigatória.

### 7.5 D4 — janela de decisão derivada da cadência

- `infrastructure/snmp/fast-cadence.ts` é a fonte única:
  `fastContinuityWindowMs(cadência) = max(15 s; 1,5 × cadência)`.
- O poller **e** a decisão (`lifecycleConfig.maxAgeMs/maxGapMs`, `pilotEvidenceValid`)
  usam a mesma função. 10 s → 15 s (inalterado), 15 s → 22,5 s, 30 s → 45 s.
- Nenhum limite foi afrouxado: 5 s continua fora da faixa (exige homologação própria).

### 7.6 D5 — teto de interfaces por device

- Um device acima de `MITIGATION_FAST_MAX_INTERFACES_PER_DEVICE` é excluído **sozinho**;
  os demais continuam coletando (`overLimitDevices` no `status()`).
- Antes o `throw` no refresh provocava `schedules.clear()` global.

### 7.7 D6 — contagem de gaps

- O gap passa a ser o intervalo entre **chegadas consecutivas** da interface (wall clock),
  inclusive quando a amostra seguinte é `BASELINE`/`STALE_INTERVAL` por causa de falha.
- `gapsOver15Seconds` permanece fixo em 15 s (comparável entre cadências) e há o novo
  `gapsOverContinuityLimit`, que usa a janela configurada.

### 7.8 D8 / D12 — higiene

- `MockMitigationExecutor.remove` usa `buildMitigationRemovalCommands`: par fora de 1/2 é
  recusado com `MITIGATION_CONTRACT_MISMATCH`, igual ao executor real.
- Mensagem do preflight de REMOVE corrigida (não cita mais `if-match PREFIX8to24`).
- `selectTemporaryNode` **removido** após comprovar que só era referenciado pelo próprio
  teste (nenhum fluxo de produção dependia da API).

### 7.9 Correções diferenciais F1–F4

- REMOVE humano exige intenção durável `REMOVING` antes da escrita. O snapshot
  original fica retido; a intenção v2 não é ownership reutilizável. Falha de banco
  mantém quarentena por device/policy, inclusive para outro requestId/perfil.
- A reconciliação explícita interna exige par ausente, permanentes sem drift,
  operação/ator/motivo e o lock comum. Grava recibo sem escrita e sem fabricar
  VERIFIED. Não há retirada por timer nem endpoint novo para liberar quarentena.
- Deny BOGONS permanente isolado não é par legado. RT660 isolada não é ownership.
- O simulador usa poller, Counter64, fonte e lifecycle reais, com controles sem
  ataque. Relógio e transporte fake continuam sem valor de homologação física.
- As visões individuais são preenchidas durante reconcile; pilotView pertence
  exclusivamente à AGLINK.

Resultados, riscos e matriz D1–D12 no
[relatório F1–F4](../RELATORIO-CORRECAO-FINAL-F1-F4-AUTO-ALL-IPV4-FAST.md).
Aprovação operacional continua pendente de auditoria diferencial independente.
