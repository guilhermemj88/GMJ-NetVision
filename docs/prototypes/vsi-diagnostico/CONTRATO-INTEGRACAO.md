# Diagnóstico VSI/VPLS por serviço — contrato de integração (final, DEV)

Status: **implementado em DEV** na branch `feature/vsi-mcp-diagnostics`. A aba operacional não consome nada daqui.
Fonte de verdade dos tipos: `packages/shared/src/vsi-service-diagnosis.ts`.

## 1. Fluxo

```
PE 1 ─ diagnose_vsi ─┐
PE 2 ─ diagnose_vsi ─┼─► aggregator ─► composeVsiServiceDiagnosis ─► VsiServiceDiagnosis ─► tela
PE n (não lido) ─────┘        ▲
inventário SNMP ──────────────┘
job do legado ─► adaptLegacyVsiDiagnostic ───────────────────────► VsiServiceDiagnosis ─► tela
```

| Camada | Arquivo | Responsabilidade |
|---|---|---|
| Motor | `apps/api/.../vsi-mcp/tools.ts` | Lê um PE, classifica. **Não mudou de critério.** |
| Agregador | `apps/api/.../vsi-service/aggregator.ts` | Posiciona fatos com origem; não reclassifica |
| Serviço | `apps/api/.../vsi-service/service.ts` | Descobre participantes, chama o motor por PE, guarda a execução |
| Composição | `packages/shared/src/vsi-service-compose.ts` | Idade, estado por ponta, eixos, veredito |
| Legado | `packages/shared/src/vsi-service-legacy.ts` | Converte `VsiDiagnosticResult` |
| Tela | `apps/web/.../diagnostics/service/` | Só traduz o contrato em rótulos |

## 2. Acréscimos no motor (aditivos)

Em `tools.ts` / `contracts.ts`. `status`, achados, severidades, comandos e allowlists são os mesmos; os exemplos golden de `docs/vsi-mcp-examples` só ganharam chaves.

- `data.facts` em `diagnose_vsi`: `vsi`, `interfaces`, `carriers`, `vlan`, `redundancy`, `persistedAcs`, `persistedPws`, `evidenceIds`. São os fatos já analisados que sustentam `diagnosis`. Sem as entradas da tabela MAC (resumidas em `macSummary`).
- `collectionIssues[]` em todo envelope: `OUTPUT_INCOMPLETE` (de `evidence[].complete=false`), `OPERATION_SKIPPED` (de `skipped`), `COLLECTION_ERROR` (de `errors`). Mesma informação, estruturada.

## 3. Rotas DEV

Desligadas por padrão. Exigem `VSI_SERVICE_DIAGNOSTIC_ENABLED=true`; a execução exige também `VSI_MCP_ENABLED=true`.

| Rota | Papel | Função |
|---|---|---|
| `GET /api/vsi-service-diagnostics/status` | sessão | estado das flags |
| `POST /api/vsi-service-diagnostics` | ADMIN/OPERATOR | executa e devolve `VsiServiceDiagnosis` |
| `GET /api/vsi-service-diagnostics/:runId` | sessão | resultado guardado (memória, 50 execuções) |
| `GET /api/vsi-service-diagnostics/legacy/:hostId/:vsiId/:diagnosticId` | sessão | job do legado convertido |

Corpo do `POST` (schema estrito; campo desconhecido é erro, nenhum texto vira comando):

```json
{
  "vsiName": "3072-QinQ-CDB-MANTIQUEIRA",
  "includeMac": true,
  "homologation": false,
  "endpoints": [
    { "hostId": "…", "approvalId": "uuid", "carrierInterfaces": ["Eth-Trunk17"], "eTrunkIds": [4] },
    { "hostId": "…" }
  ]
}
```

- Uma aprovação one-shot **por PE** (`POST /api/vsi-mcp/approvals`, escopo `vsi-name:<VSI>`), como hoje.
- PE sem `approvalId` não é lido e entra como participante não lido.
- Até 6 PEs pedidos e 8 participantes.
- `homologation: true` continua exigindo ADMIN (regra do motor).

## 4. Regras do contrato

1. **Origem em todo valor.** `VsiObserved.basis`: `LIVE_SSH`, `PERSISTED_SNMP`, `NOT_READ`, `COLLECTION_FAILED`. `value: null` nunca vira up nem down. O inventário só aparece como `inventoryHint`.
2. **Acesso ≠ serviço.** `accessRole` (E-Trunk/LACP) e `serviceState` (VSI/AC/PW) são campos distintos. Master não torna o serviço `PROVEN_OK`.
3. **Idade.** `VSI_EVIDENCE_AGE_LIMITS`: até 15 min `CURRENT`, até 24 h `AGED`, depois `STALE` (configurável). Captura sem horário usa o início do dia. Leitura `STALE` nunca sustenta `PROVEN_OK`.
4. **Leituras separadas.** Cada sessão SSH e cada ciclo de inventário é um `Reading`; `inThisRun` distingue a execução atual.
5. **Participantes.** PEs pedidos + peers dos PWs do inventário (`remoteHostId`, em cadeia). Peer sem host entra identificado pelo IP. Ninguém é omitido.
6. **Categoria do achado.** `VSI_FINDING_CLASS`. Achado operacional segue a severidade do motor (`CRITICAL→FAILURE`, `WARNING→RISK`). Código sem categoria é erro; um teste lê `correlator.ts` e falha se surgir código novo sem categoria.
7. **Coleta ≠ falha.** `collectionIssues` e aprovação recusada viram achados `COLLECTION` (`INFO`), com a evidência.
8. **Standby.** `VSI_DOWN_STANDBY_EXPECTED`, `STANDBY_PATH_IDLE`, `PW_DOWN_ON_INACTIVE_PATH`, `PW_STATE_ASYMMETRIC_INACTIVE_PATH` são `STANDBY_EXPECTED`: fora de falhas e de pendências.
9. **Redundância não atenua.** `DOWN_UNEXPECTED` gera `PATH_DOWN_UNEXPECTED` crítico se o motor não tiver emitido um; o veredito fica `FAILED` mesmo com outro caminho ativo (cláusula `FAILED_OTHER_PATH_ACTIVE`).
10. **Veredito.** Precedência: falha confirmada → `FAILED`; sem leitura nesta execução e tudo antigo → `NO_CURRENT_READING`; serviço não comprovado ou PE não lido → `INCONCLUSIVE`; risco → `WARNING`; tudo comprovado → `OK`. Saída: cláusulas `{code, params}`; a tela tem o dicionário e cláusula sem frase é erro.
11. **Rastreabilidade.** `engine`, `engineVersion`, `runId`, `origin`, `operator`, horários. Toda referência a evidência, leitura ou passo é validada (`assertReferences`).
12. **Legado.** Veredito do próprio legado. Só `observedVsi` (VSI e PWs) vira estado lido. AC, Eth-Trunk e interface ficam em `engineChecks` (verificação em texto) e o serviço fica `ENGINE_APPROVED`, não `PROVEN_OK`. Redundância e MAC: `NOT_APPLICABLE`. Ping, perda, RTT, saltos e motivo de traceroute não executado vão para `connectivity`.

## 5. Comportamento do motor que a tela precisa refletir

- Sem a saída de `display vsi`, o motor devolve só `VSI_EVIDENCE_MISSING` e **não atribui papel** ativo/standby, mesmo com E-Trunk e LACP lidos. A tela mostra Master/Backup como fato lido e o eixo de redundância como "não confirmada: papel não atribuído".
- `evidence[].excerpt` traz só o início da saída (1200 caracteres). O contrato marca `outputTruncated`; `sha256` e `bytes` são da saída inteira.

## 6. Pendências para homologação com dados reais

| # | Pendência | Depende de |
|---|---|---|
| 1 | Ler a VSI 3072 no BHE-LIKEE e no BHE-VTA-01 pelo fluxo MCP | fingerprint SSH do LIKEE, credencial de leitura nas instâncias DEV, duas aprovações ADMIN |
| 2 | Conferir a tela com esse resultado real (papéis ACTIVE/STANDBY_EXPECTED atribuídos pelo motor) | 1 |
| 3 | Saída bruta completa por evidência (`outputUrl`) | decisão: guardar o stdout por execução |
| 4 | `usedLines` vindos do parser (hoje só nas fixtures) | acréscimo nos parsers, fora desta etapa |
| 5 | Execução assíncrona com progresso por PE (hoje o `POST` é síncrono) | necessário antes de uso operacional |
| 6 | Persistência das execuções (hoje em memória) | decisão de retenção |
| 7 | `compare_vsi_endpoints` entre pares de PEs lidos | consome uma segunda aprovação por PE |
| 8 | Famílias NE8000/NE40E | homologação própria |

## 7. Testes

| Onde | O que cobre |
|---|---|
| `packages/shared/src/vsi-service-diagnosis.test.ts` | idade, categorias, composição, adaptador do legado, conectividade |
| `apps/api/.../vsi-service/service.test.ts` | replay das capturas reais da 3072 (golden), aprovação por PE, coleta ≠ falha, standby sem crítico, VSI down sem redundância continua crítica, leitura antiga |
| `apps/api/src/vsi-service-diagnostic-routes.test.ts` | flags, sessão, papel, schema estrito, runId, legado |
| `apps/web/.../service/service-view.test.tsx` | 14 cenários de aceitação, legado, agrupamento, tela consumindo a resposta do motor |
| `apps/web/src/lib/vsi-diagnostic-preview.test.ts` | rota de preview só em `next dev` |

Regenerar o golden: `UPDATE_VSI_SERVICE_REPLAY=1 npx vitest run src/infrastructure/mpls/vsi-service` em `apps/api`.

## Adendo (16/11/2026): coleta, evidência e estado do serviço por ponta

Três respostas separadas por PE, nunca fundidas:

| Pergunta | Campo | Valores |
|---|---|---|
| Os comandos voltaram inteiros? | `endpoints[].collection` | `READ`, `PARTIAL`, `FAILED`, `NOT_AUTHORIZED`, `NOT_READ` |
| O que foi lido basta para classificar a ponta? | `vsiEndpointEvidenceState(endpoint)` | `SUFFICIENT`, `INSUFFICIENT`, `NONE` |
| O que a leitura diz de VSI/AC/PW? | `endpoints[].serviceState` | inalterado |

- `collection` só é `PARTIAL` quando há `collectionIssues` ou a VSI não foi lida. O `status` `INCONCLUSIVE` do motor fala do diagnóstico e não rebaixa a coleta.
- `missingEvidence` lista somente o que ainda precisa ser lido. O que o motor não avalia sem faltar leitura (ponta em standby comprovado, MAC não solicitado) vai em `notAssessed` (opcional, aditivo).
- Backup lido por inteiro = `READ` + `SUFFICIENT` + `EXPECTED_DOWN`, sem próximo passo para esse PE. O veredito do serviço continua dependendo do PE Master.
