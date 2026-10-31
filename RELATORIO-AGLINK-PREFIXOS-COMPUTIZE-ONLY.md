# RELATÓRIO — AGLINK COMPUTIZE-only: contrato `prefixes` + diff SEMPRE-DDoS

**31/10/2026 · branch `feature/aglink-computize-prefixes` · base `2beafda`**
**Nenhuma escrita em produção. Nenhum deploy. Nenhum ACTIVATE/REMOVE. Nenhum n8n publicado. Nenhum Telegram real.**

---

## 1. O que foi entregue

| #   | Entrega                                                                    | Estado                       |
| --- | -------------------------------------------------------------------------- | ---------------------------- |
| 1   | `prefixes` integrado ao contrato REAL de notificação (não só em teste)     | pronto                       |
| 2   | Lista obtida do **escopo verificado** por leitura READ-ONLY                | pronto                       |
| 3   | Diff Huawei do `deny node 5` (SEMPRE-DDoS / RT660)                         | **proposto, não aplicado**   |
| 4   | n8n RC7.1.2 com apresentação dos três prefixos                             | **preparado, não publicado** |
| 5   | Testes integrados (sem prefixos, readback parcial, retries, evento antigo) | 2693 verdes                  |
| 6   | Commits em worktree/branch isolados                                        | pronto                       |

## 2. Causa raiz do que existia

O protótipo anterior vivia **apenas no teste**
(`aglink-prefix-contract-proposal.test.ts`), e ele mesmo documentava a lacuna:
`buildMitigationWebhookPayload` **não** emitia `prefixes`. Nada em runtime
transportava a lista, e o snapshot do discovery expõe só `prefixCount`/`existingNodes`
— ou seja, a contagem nunca poderia virar lista de prefixos.

## 3. Correção aplicada (API)

### 3.1 Novo módulo puro — `mitigation-scope-prefixes.ts`

`selectMitigationScopePrefixes({ evidence, expected, localAs })` decide a lista:

- exige `profileId`, `policy` e `peer` **iguais** aos da notificação e família IPv4;
- exige leitura **integral**: `reportedTotal > 0`, `routes.length === reportedTotal`,
  `warnings` vazio;
- exige `nextHop === peer` em **todas** as rotas (evidência de outro cliente é descartada);
- deduplica e ordena; qualquer dúvida → `prefixes: null` + `fieldsUnavailable: ['prefixes']`.

Não faz I/O, não altera `verified`, não é requisito de sucesso do comando.

### 3.2 Leitura READ-ONLY — `huawei-bgp-ssh.ts`

Novo `readReceivedRoutes(device, { peerAddress, addressFamily })` →
`display bgp routing-table peer <peer> received` (IPv6: `display bgp ipv6 …`).
O comando passa pela allowlist READ-ONLY (`assertReadOnlyCommand`) antes da sessão.
Espelha `readAdvertisedRoutes`; não entra em `system-view`, não persiste, não altera o executor de mitigação.

### 3.3 Contrato

| Arquivo                         | Mudança                                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notification-publisher.ts`     | `prefixes?: string[] \| null` (aditivo)                                                                                                               |
| `mitigation-webhook.ts`         | `prefixes: string[] \| null` no payload (aditivo)                                                                                                     |
| `mitigation-command-service.ts` | portas `scopePrefixes` / `scopePrefixesLocalAs`; leitura **somente** em `MITIGATION_VERIFIED` real verificado; falha/ausência nunca derruba o comando |
| `routes.ts`                     | adaptador que confere o vínculo **no banco** (perfil → device + policy) e no peer antes de ler                                                        |

Semântica preservada: `eventId` continua sendo o `requestId`, `verified` só é
promovido por prova física, `delivered` continua exigindo ACK do n8n, outbox e
retries inalterados, autorização de REMOVE inalterada.

## 4. Matriz antes/depois

| Situação                                         | Antes             | Depois                                               |
| ------------------------------------------------ | ----------------- | ---------------------------------------------------- |
| `MITIGATION_VERIFIED` real, escopo lido integral | campo inexistente | `prefixes: [3 prefixos]`                             |
| Mesmo evento, leitura falhou / SSH fora          | campo inexistente | `prefixes: null` + `fieldsUnavailable: ['prefixes']` |
| Leitura parcial (total reportado ≠ interpretado) | —                 | `null` (nunca lista parcial)                         |
| Rota com next-hop de outro peer                  | —                 | `null`                                               |
| Evidência de outro perfil/policy                 | —                 | `null`                                               |
| Notificação IPv6                                 | —                 | `null` (fase IPv4)                                   |
| Executor MOCK / simulação                        | —                 | campo **ausente** (nada a declarar)                  |
| `MITIGATION_FAILED` / REMOVE                     | —                 | campo **ausente**                                    |
| Evento antigo gravado sem o campo                | —                 | decodifica igual; payload `prefixes: null`           |
| Retry da outbox                                  | `eventId` estável | `eventId` **e** `prefixes` idênticos                 |

## 5. Testes

| Suíte                                                          | Casos                                                  | Resultado |
| -------------------------------------------------------------- | ------------------------------------------------------ | --------- |
| `mitigation-scope-prefixes.test.ts` (novo)                     | 13                                                     | ✅        |
| `mitigation-prefix-contract-integration.test.ts` (novo)        | 10                                                     | ✅        |
| `aglink-prefix-contract.test.ts` (novo, substitui o protótipo) | 7                                                      | ✅        |
| `mitigation-workflow-rc712.test.ts` (novo)                     | 14                                                     | ✅        |
| `mitigation-workflow-rc71.test.ts` (regressão do RC7.1)        | 25                                                     | ✅        |
| `aglink-bgp-export.test.ts` + `aglink-bgp-plan.test.ts`        | 30                                                     | ✅        |
| **Suíte API completa**                                         | **2693 passed / 39 skipped / 0 failed** (193 arquivos) | ✅        |

`tsc --noEmit` 0 erros · `eslint --max-warnings=0` 0 · `git diff --check` limpo · `tsup` build OK.

Cobertura exigida e atendida: sem prefixos disponíveis, readback parcial, retries
(outbox), eventos anteriores sem o campo, escopo divergente, IPv6, simulação,
REMOVE, ativação não verificada.

## 6. Diff Huawei proposto (não aplicado)

`docs/SEMPRE_DDOS_EXPORT_DENY_DIFF.md`

```diff
+route-policy PL-SEMPRE-DDoS-IPv4-OUT deny node 5
+ if-match extcommunity-filter MITIGACAO
```

Alcance: **todo prefixo com RT `268568:660`** nessa saída (não só os três da AGLINK).
Preserva nodes 50/100, o filtro compartilhado `MITIGACAO`, a saída normal do SEMPRE,
as três exclusões administrativas e os nodes AGLINK. Não remove no REMOVE manual.

## 7. Integração Telegram preparada (não publicada)

`docs/n8n/GMJ-NetVision-Telegram-RC7.1.2-PREFIXOS.json` — 56 nós, conexões
idênticas ao RC7.1; **só** o `Normalizar Evento OUT` mudou. Sem lista → `indisponível`.
Procedimento e rollback em `docs/n8n/RC7.1.2-PREFIXOS.md`.

## 8. Riscos residuais

1. **Custo de SSH por mitigação verificada**: uma leitura extra por ACTIVATE real
   verificado. Best effort; falha não afeta o comando. Não roda em simulação nem em REMOVE.
2. **Duas leituras por evento** (policy + rotas recebidas), ambas READ-ONLY.
3. **Lista reflete o momento da leitura**: se o cliente anunciar prefixo novo depois,
   a mensagem não o terá. É escopo observado, não garantia futura.
4. **n8n dinâmico não testado** — sem n8n neste ambiente; homologação pendente.
5. **SEMPRE-DDoS continua exportando RT660** até o `deny node 5` ser autorizado e aplicado.
6. `prefixes` **não** substitui a prova física de RT/LP por rota.

## 9. Pendências para a homologação física da COMPUTIZE

- Autorizar e aplicar o `deny node 5` + readback da policy.
- Confirmação do provedor COMPUTIZE: aceitação dos três prefixos, scrubbing,
  capacidade/limites, retorno do tráfego limpo, equipe disponível.
- Janela/exclusividade e preservação das seis saídas normais.
- Autorização específica de **um** ACTIVATE manual; REMOVE em decisão separada.
- Publicar API (com `prefixes`) e depois n8n RC7.1.2, com autorização própria.
- Verificar recibo real do Telegram e separar Adj-RIB-Out × recepção × encaminhamento.

## 10. O que NÃO foi tocado

Motor FAST/AUTO · executor Huawei de escrita · catálogo físico · migrations ·
flags · n8n publicado · VNT/Fibinet · Telegram · produção · equipamentos.

**Parado antes de qualquer alteração operacional.**
