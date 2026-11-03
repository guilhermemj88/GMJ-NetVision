# Relatório — contrato IPv4 exato, FAST para todos os IPv4 e preparo AUTO-ALL

Branch isolada: `feature/auto-all-ipv4-fast` (base `5fdc9dd`, que inclui o `908e7b4` publicado).
**Commit: `ff48a98`** · 51 arquivos · +1230/−1193.
Nenhum deploy, nenhuma flag produtiva alterada, nenhum comando enviado ao Huawei, nenhum push.

Validação: **2820 testes verdes / 41 skipped**, `tsc --noEmit` limpo, `eslint --max-warnings=0` limpo,
`npm run build -w @gmj/api` com sucesso.

---

## 1. Escopo entregue

| Item | Situação |
| --- | --- |
| Contrato BGP definitivo (nodes 1/2, RT660 exclusiva) | implementado e testado |
| Correção da corrida preflight → escrita | implementada (rechecagem sob o registro durável) |
| Colisão de `requestId` entre ações/perfis | corrigida (`IDEMPOTENCY_CONFLICT`, serialização de chamadas) |
| Readbacks reconhecendo o contrato novo | corrigidos (`exactMitigationNodes`) |
| FAST RX/TX em todas as interfaces IPv4 | implementado (flag nova, off por padrão) |
| Preparo AUTO-ALL IPv4 (23 perfis) | implementado (expansão explícita + estado por perfil) |
| IPv6 | fora da execução física, sem contrato inventado |
| AUTO físico | **continua desligado**; nenhuma autorização de execução |

## 2. Arquivos de produção alterados

| Arquivo | Mudança |
| --- | --- |
| `mitigation-contract.ts` (novo) | contrato congelado (nodes 1/2, BOGONS, RT 268568:660); verificação por texto e por nodes parseados |
| `mitigation-write-guard.ts` | builder gera exatamente 6 comandos; `assertDerivedBaseline` removido; contrato validado antes do SSH |
| `mitigation-executor.ts` | `verifyActivation` exige o par exato; `Mock.remove` delega ao builder |
| `huawei-mitigation-executor.ts` | preflight/simulação/escrita usam o contrato; ocupação rechecada na leitura final; `preflightBaseline` obrigatório (motivo explícito quando ausente) |
| `mitigation-policy-physical.ts` | reconhece só 1/2 canônicos; par legado completo fora de 1/2 ⇒ `RECONCILIATION_REQUIRED` |
| `mitigation-planner.ts` | `selectNodePair` só libera 1/2 (sem realocação dinâmica) |
| `mitigation-command-service.ts` | identidade de `requestId`, `pending` + `IDEMPOTENCY_CONFLICT`, `preflightBaseline` |
| `mitigation-discovery-service.ts` | reconhece o node 2 canônico (e a forma legada, para operador reconciliar) |
| `aglink-bgp-plan.ts` | `activationApplyClauses` = somente RT660 |
| `fast-traffic-poller.ts` / `-targets.ts` / `-types.ts` / `fast-traffic-rate.ts` | observação de todos IPv4, cadência 10 s, gap derivado (≥15 s), p50/p95/p99, gaps>15 s, latências, direção opcional só para observar |
| `mitigation-fast-observer-main.ts` | injeta `observeAllIpv4` |
| `auto-lifecycle.ts` | `expansionEnabled`, sequências/aceite/views por perfil, `expansionStatus()` |
| `single-pilot-trigger.ts` | limiar por perfil (`bigint`), autorização de expansão explícita |
| `auto-expansion-scope.ts` (novo) | escopo físico por policy/peers na expansão |
| `routes.ts` | fia FAST (`observeAllIpv4`) e expansão (escopo + limiar por perfil) |
| `docs/AUTO_ALL_IPV4_FAST.md` | documentação do contrato, amplitude autorizada, FAST e AUTO-ALL |

Testes: 30 arquivos alinhados ao contrato novo; 3 reescritos por completo
(`aglink-bgp-plan`, `ne8000-observed-readback`, `mitigation-policy-physical`).

## 3. Matriz dos 39 perfis (fonte: auditoria `5fdc9dd`, leitura de 03/11 19:56Z)

| Família | Perfis | Modo | Em policy compartilhada | Nodes 1/2 | Bloqueio antigo de baseline |
| --- | --- | --- | --- | --- | --- |
| IPv4 | 23 | 12 AUTO / 11 ALERT_ONLY | 27 no total (ambas as famílias) | **0 ocupados** | 22 → obsoleto pelo contrato |
| IPv6 | 16 | 0 AUTO | — | 0 ocupados | 16 → obsoleto, mas fora do contrato IPv4 |
| **Total** | **39** (24 policies) | 12 AUTO / 27 ALERT_ONLY | — | — | **38** reclassificados |

Nenhum perfil é liberado para AUTO por esta entrega: a matriz completa com cliente,
policy, família, ocupação e restrições individuais está em
`docs/audits/auto-all-20261103/MATRIZ-CONTRATO-FINAL.md` (worktree de auditoria).

## 4. FAST — cobertura e diagnóstico

| Item | Antes | Depois |
| --- | --- | --- |
| Interfaces monitoradas | 12 | até 23 (todas as IPv4 cadastradas), com `MITIGATION_FAST_ALL_IPV4_OBSERVATION_ENABLED=1` |
| Cadência nominal | 20 s (default antigo) | **10 s** |
| Gap máximo | 45 s | **15 s** (derivado da cadência, nunca abaixo de 15 s) |
| Interfaces por device | 8 | 32 |
| Métricas | p50/p95 | **p50/p95/p99**, gaps>15 s, latência de coleta e de persistência |

- Direção: observação RX/TX acontece mesmo sem direção configurada; **ACTIVATE continua
  exigindo direção validada individualmente** (perfil sem direção = observado e bloqueado).
- Flag nova exige `MITIGATION_FAST_MODE=OBSERVE` (`ALL_IPV4_REQUIRES_OBSERVE`) e fica
  **desligada por padrão** — produção não muda.
- Diagnóstico por interface/direção: a auditoria registrou **gaps acima de 15 s em parte
  das interfaces** com a cadência antiga; a instrumentação nova permite medir isso por
  interface sem alterar produção.

## 5. Tempos de detecção e confirmação

| Etapa | Valor | Como foi obtido |
| --- | --- | --- |
| Primeira anormalidade | amostra FAST com taxa > limiar | teste de integração (3 amostras 9,2/9,3/9,4 Gbps em janelas de 10 s) |
| Confirmação | **3 amostras consecutivas válidas** ≈ 20 s após a primeira | teste |
| Reset por gap/amostra velha | sequência reiniciada; nenhum uso de dado antigo | testes `single-pilot.integration` (missing/stale/reset) |
| Comando + readback | ~1–3 s (fake SSH) | teste de integração |

**Limitação registrada:** os tempos acima são de laboratório/transporte fake. Não houve
medição em produção nesta missão, porque isso exigiria alterar flags produtivas. O plano
de medição está na seção 4.1 de `docs/AUTO_ALL_IPV4_FAST.md`.

## 6. Bloqueios remanescentes para AUTO

1. **Homologação física** do contrato (semântica de substituição de RT sem `additive`,
   LP efetivo, exportação/retorno pela COMPUTIZE) — `NOT_VERIFIED`.
2. **Flags de produção**: `MITIGATION_AUTO_EXECUTION_ENABLED=0`, `AUTO_LIFECYCLE=0`,
   `MITIGATION_LIVE_WRITE_ENABLED=false` e o pin do piloto AGLINK.
3. **Amplitude do permit**: aceitação de NLRIs fora da lista do cliente é autorizada, mas
   depende de decisão operacional registrada e monitoração.
4. **Telemetria**: gaps > 15 s em parte das interfaces precisam cair com a nova cadência
   antes de expandir.
5. **Policies compartilhadas** (27 perfis): exigem confirmação de escopo e tratamento de
   irmãos ativos antes de qualquer expansão.
6. **IPv6**: sem contrato; permanece fora.
7. **Pendências de código** listadas na seção 8.

## 7. Planos

### 7.1 Homologação física manual — AGLINK (quando autorizado)

1. Janela com `LIVE_WRITE=false` → `true` **somente** no piloto AGLINK, `AUTO_EXECUTION=0`
   (ACTIVATE manual pelo operador).
2. Confirmar `display route-policy PL-AGLINK_IPv4-IN`: node 10/11/1000 intactos.
3. `SIMULATE_ACTIVATE` → preflight ok, `baseline_record_store` ok, 6 comandos previstos.
4. ACTIVATE manual → conferir **exatamente** node 1 deny+BOGONS e node 2 só RT660; ler a
   RIB dos 3 prefixos (RT set `{268568:660}`, LP efetivo, best-path, exportação COMPUTIZE).
5. Gerar tráfego controlado e medir detecção/confirmação reais (p50/p95/p99).
6. REMOVE manual → nodes 1/2 ausentes, baseline idêntico ao inicial, runtime NORMAL.
7. Rollback: desabilitar `LIVE_WRITE`, restaurar snapshot do baseline pela configuração
   manual do operador (nunca automática).

### 7.2 Expansão gradual

1. Piloto AGLINK homologado e estável por N dias.
2. Habilitar `MITIGATION_AUTO_EXPANSION_ENABLED=1` com **1** perfil adicional, `maxActive=1`,
   mantendo `AUTO_EXECUTION=1` apenas nele.
3. Aumentar `maxActive` (1 → 2 → 3, teto atual 10) somente após janela sem falha.
4. Cada perfil novo exige: nodes 1/2 livres, direção validada, telemetria sem gaps,
   policy não compartilhada (ou escopo confirmado), sem ownership ativo.
5. IPv6 nunca entra até contrato próprio homologado.

## 8. Riscos e pendências conhecidas

| Item | Situação |
| --- | --- |
| `selectTemporaryNode` (alocação dinâmica) segue exportado | API morta no novo contrato; candidato a remoção em limpeza futura |
| Mensagem do preflight de REMOVE ainda cita `if-match PREFIX8to24` | apenas texto; não afeta decisão |
| `Mock.remove` monta a lista manualmente | `preview === escrita` garantido no ACTIVATE; paridade do REMOVE no mock é desejável |
| `inspectPolicyMitigation.rts` só usa o primeiro valor | contrato tem RT única; documentado |
| Node 0 | não usado pelo contrato; um node 0 preexistente não é tocado |
| Mudança de configuração observada entre capturas (HORIZONTES node 11: RT140→RT660) | não atribuída a esta missão; seguir investigando antes de qualquer homologação |

## 9. Próximo passo

Entrega para **auditoria independente** (Codex). Nenhuma homologação física deve começar
antes dessa auditoria e de autorização explícita.
