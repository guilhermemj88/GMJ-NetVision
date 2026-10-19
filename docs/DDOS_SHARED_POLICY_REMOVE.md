# Retirada manual em policy compartilhada — Telegram + n8n + API + Huawei

Correção do fluxo de retirada de mitigação DDoS quando dois ou mais clientes
compartilham a mesma route-policy. **Nada foi publicado e nenhum REMOVE real foi
executado**: a implementação e a homologação rodaram em worktree isolado
(`fix/ddos-shared-policy-remove-confirmation`, base `v2026.10.18-ddos-fast-bridge-rc3`),
com Huawei simulado.

## 1. Causa raiz comprovada

O gate de escopo já existia e funcionava. O defeito está no **canal inbound**:
o schema do endpoint que o n8n usa (`n8nCommandSchema`, `apps/api/src/n8n-routes.ts`)
é `.strict()` e aceitava **somente** `requestId`, `action` e `profileId`.

Consequências, comprovadas no ambiente real:

| Fato | Evidência |
| --- | --- |
| O clique do operador chegou à API | `MediaIntegration.lastInboundAt = 2026-10-19 12:28:26.809`, `lastInboundAction = REMOVE`, `lastInboundRequestId = telegram-1434618946480210113` |
| A API recusou por falta de confirmação | `lastInboundStatus = SCOPE_CONFIRMATION_REQUIRED`; erro `Remocao bloqueada: a policy PL-BHNET_IPv4-IN e compartilhada por 1 vinculo(s) ainda ativo(s); confirme a remocao do escopo inteiro` |
| O n8n não tinha como confirmar | o booleano `acknowledgeScopeRemoval` **não** existe no schema inbound: enviá-lo resultaria em `400 INVALID_REQUEST`; não havia token nem segundo passo |
| O gate compara com o escopo real | `activeScopeSiblings()` retorna os irmãos ativos da MESMA `device + policy` |

Ou seja: o botão e o IF do n8n estavam corretos; a API reconheceu o clique e
bloqueou — corretamente — porque o contrato inbound não oferecia uma confirmação
válida. **A correção não podia ser um booleano novo** (`force=true` & cia.):
sem vínculo com o escopo, o booleano autorizaria retirar outro cliente, seria
reutilizável e nunca expiraria.

### Estado real do escopo (leitura, 19/10/2026)

| Perfil | Interface | Peer | Policy / RT | Nodes | Runtime | triggerCounter | recoveryCounter |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `cmuoavm4x00c3sslhworjdb9i` | Eth-Trunk1.3043 | 10.200.200.222 | PL-BHNET_IPv4-IN / 268568:660 | 3 (BOGONS) / 4 (RT) | MITIGATED | 0 | 2119 |
| `cmuoavm5i00c8sslhed09lt8p` | Eth-Trunk1.3044 | 10.200.200.226 | PL-BHNET_IPv4-IN / 268568:660 | 3 / 4 | MITIGATED | 0 | 106 |

## 2. Contrato real da API (canal n8n)

`POST /api/integrations/n8n/mitigation-command`
`Authorization: Bearer <NETVISION_N8N_COMMAND_TOKEN>`
`Content-Type: application/json` — schema **estrito**.

```json
{
  "requestId": "telegram-1434618946480210113",
  "action": "REMOVE",
  "profileId": "cmuoavm4x00c3sslhworjdb9i",
  "scopeConfirmationToken": "<token opaco, opcional>",
  "confirmedBy": "telegram:1434618946480210113"
}
```

| Campo | Regra |
| --- | --- |
| `requestId` | idempotência: repetir o MESMO requestId devolve o primeiro resultado |
| `action` | `STATUS`, `SIMULATE_ACTIVATE`, `ACTIVATE`, `SIMULATE_REMOVE`, `REMOVE` |
| `profileId` | perfil de origem; **opcional quando há token** (o callback do Telegram carrega só o token e o NetVision resolve o perfil) |
| `scopeConfirmationToken` | opcional; **obrigatório** quando existe vínculo irmão ativo |
| `confirmedBy` | auditoria do operador no Telegram; nunca autoriza sozinho |
| `acknowledgeScopeRemoval` | **proibido** neste canal (400). Existe apenas na UI, com sessão autenticada |

Resposta do gate (sem confirmação válida):

```json
{
  "ok": false,
  "status": "SCOPE_CONFIRMATION_REQUIRED",
  "removalScope": {
    "deviceId": "host-377c554a-…",
    "policy": "PL-BHNET_IPv4-IN",
    "affected": [
      { "profileId": "…", "interfaceName": "Eth-Trunk1.3044", "customer": "BHNET-RBN",
        "peerAddress": "10.200.200.226", "addressFamily": "IPV4", "runtimeState": "MITIGATED" }
    ]
  },
  "scopeConfirmation": { "required": true, "token": "…", "expiresAt": "2026-10-19T13:05:00.000Z", "scopeHash": "…" },
  "safeError": "Remocao bloqueada: a policy PL-BHNET_IPv4-IN e compartilhada por 1 vinculo(s) ainda ativo(s); confirme a remocao do escopo inteiro"
}
```

Status possíveis do gate: `SCOPE_CONFIRMATION_REQUIRED`, `SCOPE_CONFIRMATION_USED`,
`SCOPE_CONFIRMATION_EXPIRED`, `SCOPE_CONFIRMATION_TOKEN_UNKNOWN`,
`SCOPE_CONFIRMATION_SCOPE_MISMATCH`, `SCOPE_CHANGED`. Todos vêm acompanhados de
uma confirmação **nova** já com a lista atualizada.

## 3. Código corrigido

| Arquivo | Mudança |
| --- | --- |
| `mitigation-scope-confirmation.ts` (novo) | store de confirmações: token opaco, TTL (10 min), uso único, hash canônico do escopo |
| `mitigation-command-service.ts` | gate por token; revalidação dentro do lock; consumo/release; reset de sequência; hook para o motor |
| `n8n-routes.ts` | aceita `scopeConfirmationToken`/`confirmedBy`; continua estrito (sem booleano) |
| `routes.ts` | fiação do store e do hook `onScopeRemoved` → motor AUTO |
| `mitigation-auto-engine.ts` | `forgetProfiles()` + guardas de identidade (`SAMPLE_SEQUENCE_RESET`) |

### Garantias implementadas

1. **Escopo resolvido no servidor** — `deviceId + policyName`; o cliente nunca
   envia lista de perfis, policy, node ou RT.
2. **Lista completa de afetados** — `removalScope.affected` traz interface,
   cliente, peer e estado de runtime de cada vínculo.
3. **Token vinculado** — hash SHA-256 de
   `deviceId | policyName | profileId de origem | (profileId + runtimeState) ordenados`.
   Um token emitido para a 3043 não retira a 3044 (`SCOPE_CONFIRMATION_SCOPE_MISMATCH`).
4. **Prazo e uso único** — expira em 10 min (`SCOPE_CONFIRMATION_EXPIRED` /
   `TOKEN_UNKNOWN`); após uso, replay devolve `SCOPE_CONFIRMATION_USED`.
5. **Revalidação imediatamente antes da execução** — o gate roda **dentro** do
   lock de escopo; se um cliente entrou/saiu ou mudou de estado, a confirmação
   é recusada (`SCOPE_CHANGED`) e uma nova é emitida com a lista atual.
6. **Consumo só com escrita tentada** — bloqueio anterior (preflight, policy
   ocupada) devolve o token para o operador tentar de novo dentro do prazo.
7. **Uma única retirada física** — o executor canônico remove apenas o par
   (`undo route-policy <policy> node <bogon>` + `node <mitigacao>` + `commit`);
   nodes e RTs alheios são preservados por construção (`mitigation-write-guard.ts`).
8. **Readback obrigatório** — sem confirmação do `display route-policy` o
   resultado é `REVALIDATION_FAILED` e o escopo inteiro vai para
   `RECONCILIATION_REQUIRED` (nunca "sucesso").
9. **Reconciliação do escopo** — `syncPolicyRuntime` grava `NORMAL` em todos os
   vínculos da policy após o readback.
10. **Sem ressurgimento automático** — a sequência de amostras é zerada (DB) e o
    motor esquece o cache em memória (`forgetProfiles`), com guardas de
    identidade para avaliações já em andamento.
11. **Auditoria** — evento `REMOVE` no perfil de origem (`verified`, `safeError`),
    `confirmedBy` na resposta e linha de log do inbound (sem token).

### Interação com FAST ENFORCE (BHNET-3043)

* A retirada manual usa o **mesmo** `MitigationCommandService` e o **mesmo** lock
  de escopo do motor: um `ACTIVATE` automático e um `REMOVE` manual nunca se
  intercalam (o segundo recebe `POLICY_BUSY`).
* A sequência de gatilho pertence à evidência **anterior** à retirada: com
  `triggerSamples = 3` e fonte FAST (10 s), o motor precisa de 3 amostras novas
  (≈30 s) antes de qualquer nova ativação. Nada é reaplicado por amostras
  antigas, decisões duplicadas ou estado inconsistente.
* `FAST ENFORCE` não é desabilitado, nem globalmente nem para a 3043; nenhuma
  flag operacional muda.

## 4. Ajustes no workflow n8n

Duas partes, ambas em `docs/n8n/` (importáveis):

1. `shared-policy-remove-request.json` — chamada de retirada que, ao receber os
   status de escopo, envia a mensagem com **a lista completa** e os botões
   `CANCELAR` / `CONFIRMAR RETIRADA DE TODOS`.
2. `shared-policy-remove-confirm.json` — trata o callback do Telegram
   (`rmc:` cancela, `rmx:` confirma), valida operador/grupo, chama a API com o
   token e edita a mensagem com o resultado.

### Ligação no fluxo existente

| Onde | Ajuste |
| --- | --- |
| Nó que chama a API de REMOVE | manter; passar a resposta adiante (não descartar o corpo) |
| IF "Confirmou Retirada?" | **sem mudança** (continua correto para `remove_execute`) |
| Após o nó HTTP de REMOVE | IF novo: `status` ∈ {SCOPE_CONFIRMATION_REQUIRED, SCOPE_CONFIRMATION_USED, SCOPE_CONFIRMATION_EXPIRED, SCOPE_CONFIRMATION_TOKEN_UNKNOWN, SCOPE_CONFIRMATION_SCOPE_MISMATCH, SCOPE_CHANGED} → executar `shared-policy-remove-request` |
| Telegram Trigger (callback_query) | se `data` começar com `rmc:` ou `rmx:` → executar `shared-policy-remove-confirm` (antes dos handlers atuais) |

### Regras de segurança no n8n

* `callback_data` = `rmx:<token>` / `rmc:<token>` (≈28 caracteres, dentro do
  limite de 64 do Telegram). O perfil é resolvido pela API a partir do token —
  o botão nunca carrega `profileId`.
* O token **não** é o id do perfil: quem clica confirma o escopo aprovado, não
  um cliente.
* Validar `callback_query.from.id` contra a lista de operadores e o `chat.id`
  contra o grupo autorizado **antes** de chamar a API; responder com
  `answerCallbackQuery` em caso de recusa.
* A mensagem deve mostrar o prazo (`expiresAt`) e que a retirada afeta **todos**
  os clientes listados.
* Um token confirmado não pode ser reaproveitado: a API responde `USED` e a
  mensagem de erro pede nova solicitação.
* Nunca montar payload com `policy`, `node`, `rt` ou lista de perfis.

### Exemplo de mensagem

```
⚠️ RETIRADA DE MITIGAÇÃO — POLICY COMPARTILHADA
Equipamento: BHE-VTA-F1A-BGP-01
Policy: PL-BHNET_IPv4-IN  •  RT 268568:660  •  nodes 3/4

Esta policy é usada por 2 clientes. A retirada atinge TODOS:

• Eth-Trunk1.3043 — BHNET-CEASA — peer 10.200.200.222 (MITIGATED)
• Eth-Trunk1.3044 — BHNET-RBN   — peer 10.200.200.226 (MITIGATED)

Solicitado por: 3043. Confirmação válida até 13:05 UTC.

[ CANCELAR ]   [ CONFIRMAR RETIRADA DE TODOS ]
```

## 5. Testes e evidências

`apps/api` — **1970 testes aprovados / 20 ignorados** (suíte completa), lint e
typecheck limpos.

Novos testes (28):

* `mitigation-scope-confirmation.test.ts` (9): hash canônico e estável; TTL;
  uso único/replay; expiração; escopo/perfil divergente; composição alterada;
  `release` em bloqueio; token desconhecido.
* `mitigation-shared-remove-confirmation.test.ts` (11): solicitação de qualquer
  um dos perfis; listagem completa; cancelar sem efeito; confirmação válida com
  **uma** retirada física (2 `undo` + 1 `commit`) e preservação do node 11;
  reconciliação dos dois runtimes; contadores zerados; hook do motor; replay;
  expiração; token de um perfil não retira o outro; mudança de membros →
  `SCOPE_CHANGED` com lista e token novos; readback sem efeito →
  `RECONCILIATION_REQUIRED`; bloqueio de preflight não consome o token; REMOVE
  simples segue sem token.
* `mitigation-auto-forget-sequence.test.ts` (2): após `forgetProfiles`, a
  reativação exige 3 amostras novas (não reaproveita o gatilho anterior) e o
  esquecimento vale para os dois perfis do escopo.
* `n8n-routes.test.ts` (+6): gate devolve lista + token; booleano recusado com
  400; confirmação com token executa e o token não aparece no log; callback
  confirma apenas com o token (perfil resolvido pela API); token desconhecido
  sem `profileId` → `TOKEN_UNKNOWN` sem tocar o executor; sem `profileId` e sem
  token → 400.

Testes existentes preservados: 20 decisões douradas do motor LEGACY continuam
idênticas; `mitigation-auto-shared-policy`, `mitigation-auto-shared-scope-multi-asn`,
`mitigation-manual-concurrency`, `mitigation-shared-policy-runtime` sem alteração
de comportamento.

## 6. Commits

Branch `fix/ddos-shared-policy-remove-confirmation` (base `0e7099c`, tag RC3).

## 7. Plano de publicação e rollback

**Não publicar sem autorização**: a API RC3 está em produção com FAST ENFORCE na
BHNET-3043 e a publicação exige restart da API.

1. Congelar janela (25 min), confirmar BHNET-3043/3044 `MITIGATED` e ausência de
   operação em andamento (`POLICY_BUSY`/`IN_FLIGHT`).
2. Build do commit em release separada (`/opt/netvision-fast-bridge/releases/rc4-<sha>`),
   sem tocar na `rc3-0e7099c`.
3. `systemctl restart netvision-api` (encerra o PID anterior antes de iniciar o novo).
4. Validar: `/health`, migrations inalteradas (41), 36 perfis, SHADOW/ENFORCE
   iguais, BHNET ainda `MITIGATED`, readback Huawei inalterado.
5. `grep` no journal: nenhuma reativação automática inesperada em 15 min.
6. Publicar os dois sub-workflows n8n e testar em um perfil de laboratório
   (policy própria) antes de habilitar no grupo de operação.

Rollback: remover o drop-in da nova release, `daemon-reload`, `systemctl restart
netvision-api` (volta ao binário RC3). Banco, histórico, observador e mitigação
permanecem intactos — não há migration nova.

## 8. Riscos

| Risco | Severidade | Mitigação |
| --- | --- | --- |
| Confirmação usada em escopo que mudou | alta | hash de composição + revalidação sob lock (`SCOPE_CHANGED`) |
| Replay de confirmação | alta | uso único + expiração + `requestId` idempotente |
| Retirada de outro cliente por engano | alta | token vinculado ao perfil de origem e ao escopo |
| Reativação imediata pelo FAST | alta | reset de contadores + `forgetProfiles` + guarda de identidade |
| Mensagem do Telegram sem a lista completa | média | texto gerado a partir de `removalScope.affected` |
| Token em log ou histórico do Telegram | média | token nunca é logado; mensagem final não repete o token |
| Dependência do processo único da API | baixa | restart invalida tokens pendentes (fail-closed: pedir de novo) |
