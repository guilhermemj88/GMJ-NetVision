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
  "confirmedBy": "telegram:1434618946480210113",
  "chatId": "-1002000000000"
}
```

| Campo | Regra |
| --- | --- |
| `requestId` | idempotência: repetir o MESMO requestId devolve o primeiro resultado |
| `action` | `STATUS`, `SIMULATE_ACTIVATE`, `ACTIVATE`, `SIMULATE_REMOVE`, `REMOVE` |
| `profileId` | perfil de origem; **opcional quando há token** (o callback do Telegram carrega só o token e o NetVision resolve o perfil) |
| `scopeConfirmationToken` | opcional; **obrigatório** quando existe vínculo irmão ativo |
| `confirmedBy` | auditoria do operador no Telegram; nunca autoriza sozinho |
| `chatId` | chat/grupo do Telegram; o token emitido fica preso a ele |
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
`SCOPE_CONFIRMATION_SCOPE_MISMATCH`, `SCOPE_CONFIRMATION_CHAT_MISMATCH`,
`SCOPE_CHANGED`. Todos vêm acompanhados de uma confirmação **nova** já com a
lista atualizada.

### Cancelamento explícito (revogação do token)

`POST /api/integrations/n8n/mitigation-scope-cancel` — mesmo bearer, schema
**estrito**, **não executa comando e não toca no equipamento**: apenas remove a
confirmação pendente do store.

```json
{
  "requestId": "telegram-1434618946480210113-cancel",
  "scopeConfirmationToken": "<token opaco>",
  "confirmedBy": "telegram:1434618946480210113",
  "chatId": "-1002000000000"
}
```

| Resposta | Significado |
| --- | --- |
| `200 { ok: true, status: "SCOPE_CONFIRMATION_REVOKED" }` | token revogado; `rmx:` antigo passa a receber `TOKEN_UNKNOWN` |
| `200 { ok: false, status: "SCOPE_CONFIRMATION_TOKEN_UNKNOWN" }` | já expirou, já foi usado ou já foi revogado |
| `200 { ok: false, status: "SCOPE_CONFIRMATION_USED" }` | a confirmação já executou a retirada; não há o que revogar |
| `200 { ok: false, status: "SCOPE_CONFIRMATION_CHAT_MISMATCH" }` | pedido veio de outro chat/grupo |
| `401` / `400` | bearer inválido / payload fora do contrato (campo extra é recusado) |

### Orçamento do `callback_data`

O Telegram limita `callback_data` a **64 bytes**. O token é
`randomBytes(18).toString('base64url')` = **24 caracteres ASCII**, então
`rmx:<token>` / `rmc:<token>` ocupam **28 bytes**. O workflow ainda valida o
tamanho em bytes na entrada (UTF-8) e aceita apenas `[A-Za-z0-9_-]{16,60}` —
qualquer coisa maior é descartada como callback inválido.

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
12. **Vínculo com o chat de origem** — o token guarda `chatId` e, opcionalmente,
    o operador solicitante. O mesmo `callback_data` encaminhado para outro grupo
    é recusado com `SCOPE_CONFIRMATION_CHAT_MISMATCH` (sem tocar no equipamento).
    Um pedido feito sem `chatId` continua compatível (sem vínculo de grupo).
13. **Restart da API é fail-closed** — o store de confirmações é **em memória**:
    um restart perde os tokens pendentes e a próxima confirmação recebe
    `SCOPE_CONFIRMATION_TOKEN_UNKNOWN` com uma confirmação nova. Nada é aceito
    "por engano" e nenhum estado parcial fica em disco.
14. **Falha do executor também reconcilia** — o caminho simulado (MOCK) passou a
    marcar `writeAttempted` como o caminho real: exceção do executor deixa o
    escopo em `RECONCILIATION_REQUIRED`, nunca em `MITIGATED` otimista.

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

O arquivo único **`docs/n8n/GMJ-NetVision-Telegram-RC4-CORRIGIDO.json`** substitui
os dois sub-workflows anteriores: ele parte do export real
(`GMJ NetVision - Mitigacao DDoS - Bidirecional -v2`) e mantém os **45 nós
originais** (4 webhooks, alarmes, gráficos, downloads, VNT, FIBINET, credenciais)
intactos, acrescentando 17 nós para o callback de escopo.

### Ligação no fluxo existente

| Onde | Antes | Depois |
| --- | --- | --- |
| `Autorizar Telegram` [0] | `Pedido de Retirada?` | `IF - Callback de Escopo?` → (ramo `false`) `Pedido de Retirada?` |
| `Confirmou Retirada?` [0] | `HTTP - NetVision Command` | `Montar Corpo do Comando` → `HTTP - NetVision Command` |
| `HTTP - NetVision Command` | `Formatar Resposta NetVision` | `IF - Escopo pendente?` → (sim) confirmação compartilhada / (não) formatação original |
| `Telegram Trigger - Callback` | — | **inalterado** (um único trigger) |
| IF "Confirmou Retirada?" | — | **inalterado** (continua `remove_execute`) |

### Estrutura do workflow único

| Trecho | Nós |
| --- | --- |
| Entrada de callback | `Interpretar Callback` (aceita `rmc:`/`rmx:` **e** os 3 comandos legados) → `Autorizar Telegram` |
| Escopo | `IF - Callback de Escopo?` → `Telegram - ACK Escopo` → `IF - Confirmar Escopo (rmx)?` |
| Confirmar | `HTTP - NetVision Scope Confirm` → `Formatar Resposta do Escopo` → `IF - Reemitir confirmacao?` → `Telegram - Resposta Escopo (novos botoes)` / `(final)` |
| Cancelar | `HTTP - NetVision Scope Cancel` → `Formatar Cancelamento` → `Telegram - Escopo Cancelado` |
| REMOVE legado | `Montar Corpo do Comando` → `HTTP - NetVision Command` → `IF - Escopo pendente?` |
| Proposta de escopo | `Montar Confirmacao Compartilhada` → `IF - Tem token?` → `Telegram - Confirmar Retirada Compartilhada` / `Telegram - Escopo sem Confirmacao` |

**Quebras de linha reais.** As mensagens longas são montadas em nós **Code** que
devolvem uma string com `\n` de verdade; o nó do Telegram usa
`{{ $json.text }}`. Nada de `\n` literal dentro de expressão `=` (que o Telegram
exibiria como texto) — inclusive o texto original de `Telegram - Confirmar
Retirada`, que estava com `\\n` duplo.

**Reemissão do token.** Se a API recusar por `USED`/`EXPIRED`/`SCOPE_CHANGED`,
ela devolve **outra** confirmação com a lista atualizada; o workflow edita a
própria mensagem e reapresenta `CANCELAR` / `CONFIRMAR RETIRADA DE TODOS` com o
token novo — sem obrigar o operador a clicar em RETIRAR de novo.

**Sem token, sem botões.** Se a API responder um status de escopo sem
`scopeConfirmation.token`, a mensagem é editada com a lista e o aviso, **sem**
inline keyboard (`IF - Tem token?` → `Telegram - Escopo sem Confirmacao`).

**Falha de transporte.** Todos os nós HTTP usam `neverError` +
`onError: continueRegularOutput`: se a API estiver inacessível, o operador recebe
o status `API_INDISPONIVEL` e nenhuma alteração é registrada. No cancelamento, a
mensagem diz explicitamente que **não foi possível confirmar a revogação** — o
workflow nunca afirma revogação sem resposta da API.

### Credencial, variáveis e autorização

| Item | Como |
| --- | --- |
| Bearer do canal n8n | **credencial Header Auth** `NetVision n8n Command` (`Authorization: Bearer <token>`), referenciada pelos 2 nós HTTP — nenhum segredo no JSON |
| `NETVISION_API_BASE` | usada apenas nos sub-workflows antigos; o arquivo único usa a URL fixa `http://45.163.144.8:3333` (mesma do nó legado) |
| `NETVISION_TELEGRAM_OPERATORS` | opcional; ids (`from.id`) separados por vírgula. **Também** aceita a constante `OPERADORES_RETIRADA_COMPARTILHADA` no nó `Interpretar Callback` |
| Autorização da retirada compartilhada | **operador nominal obrigatório**: `rmx:`/`rmc:` exigem `userId` na lista; lista vazia = ninguém (fail-closed). O grupo autorizado sozinho **não** basta |
| Comandos legados | seguem a regra antiga (grupo `-5522540056` + usuário identificado) — nenhuma permissão existente foi alterada |

A resposta da API nunca é logada com o token: o log do inbound
(`N8nInboundLog`) carrega apenas `requestId`, `action`, `profileId`, `status`,
`safeError`.

> **Retenção no n8n:** o `callback_data` e o corpo do POST aparecem no histórico
> de execuções do n8n. Restrinja quem acessa *Executions* e reduza a retenção
> (`EXECUTIONS_DATA_PRUNE`), pois o token de escopo é um segredo de curta duração.

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
Policy: PL-BHNET_IPv4-IN • RT 268568:660 • nodes 1/2

A retirada atinge TODOS os vínculos desta policy:

• Eth-Trunk1.3043 — BHNET-CEASA — peer 10.200.200.222 (origem da solicitação)
• Eth-Trunk1.3044 — BHNET-RBN — peer 10.200.200.226 (MITIGATED)

Solicitado por: 3043.
Confirmação válida até 2026-10-19T14:10:00.000Z.

Status: SCOPE_CONFIRMATION_REQUIRED

[ CANCELAR ]   [ CONFIRMAR RETIRADA DE TODOS ]
```

Os `nodes` exibidos são os do **equipamento** (`resolveActivePair`, read-only),
não o plano gravado no runtime: na BHNET o plano histórico é `3/4` e o par ativo
é `1/2` — o REMOVE reconcilia antes de escrever.

## 5. Testes e evidências

`apps/api` — **1985 testes aprovados / 20 ignorados** (suíte completa), lint,
typecheck e build limpos.

Novos testes (43):

* `mitigation-scope-confirmation.test.ts` (18): hash canônico e estável; TTL;
  uso único/replay; expiração; escopo/perfil divergente; composição alterada;
  `release` em bloqueio; token desconhecido; vínculo com o chat de origem;
  não reaproveitamento entre chats; pedido sem chat continua compatível;
  **revogação** (token deixa de existir, idempotência, já usado, expirado,
  outro chat); **token ≤ 64 bytes com o prefixo do Telegram**.
* `mitigation-shared-remove-confirmation.test.ts` (14): solicitação de qualquer
  um dos perfis; listagem completa; cancelar sem efeito; confirmação válida com
  **uma** retirada física (2 `undo` + 1 `commit`) e preservação do node 11;
  reconciliação dos dois runtimes; contadores zerados; hook do motor; replay;
  expiração; token de um perfil não retira o outro; mudança de membros →
  `SCOPE_CHANGED` com lista e token novos; readback sem efeito →
  `RECONCILIATION_REQUIRED`; bloqueio de preflight não consome o token; REMOVE
  simples segue sem token; falha de commit do executor → `REVALIDATION_FAILED`
  com escopo em reconciliação e token consumido; restart (store novo) →
  `TOKEN_UNKNOWN` sem tocar o equipamento; **cancelamento revoga e o `rmx:`
  posterior não executa nada**.
* `mitigation-auto-forget-sequence.test.ts` (2): após `forgetProfiles`, a
  reativação exige 3 amostras novas (não reaproveita o gatilho anterior) e o
  esquecimento vale para os dois perfis do escopo.
* `n8n-routes.test.ts` (+9): gate devolve lista + token; booleano recusado com
  400; confirmação com token executa e o token não aparece no log; callback
  confirma apenas com o token (perfil resolvido pela API); token desconhecido
  sem `profileId` → `TOKEN_UNKNOWN` sem tocar o executor; token de outro chat →
  `CHAT_MISMATCH` sem escrita; sem `profileId` e sem token → 400;
  **revogação** (200 `SCOPE_CONFIRMATION_REVOKED`, replay depois dela →
  `TOKEN_UNKNOWN` sem escrita); **revogação exige bearer e recusa campo extra**.

Testes existentes preservados: 20 decisões douradas do motor LEGACY continuam
idênticas; `mitigation-auto-shared-policy`, `mitigation-auto-shared-scope-multi-asn`,
`mitigation-manual-concurrency` (ACTIVATE+REMOVE, AUTO+REMOVE, POLICY_BUSY,
falha após escrita), `mitigation-shared-policy-runtime` sem alteração de
comportamento.

### Workflow n8n — validação exercitada

* Estrutura: 62 nós, ids/nomes únicos, 45 originais intactos, 4 webhooks com
  `path` e `webhookId` iguais, 1 `telegramTrigger`, nenhum nó sem entrada,
  todos os `jsCode` compilam, 65 expressões balanceadas, **nenhum Bearer no JSON**.
* Operações Telegram conferidas **contra o código-fonte do nó**
  (`Telegram.node.ts`): `sendMessage`, `editMessageText` (com `chatId` +
  `messageId` + `replyMarkup` top-level) e `answerQuery` (`callback/answerQuery`,
  `queryId` + `additionalFields.text`) — 17/17 nós válidos.
* Simulação de execução (grafo real, Code nodes rodando, IFs avaliados, HTTP
  mockado): **16/16** — legado (pedido, execução sem escopo, cancelamento),
  escopo com e **sem** token, `rmx` sucesso/escopo alterado/API fora,
  `rmc` com revogação e com falha de rede, operador não autorizado, lista vazia
  (fail-closed), chat não autorizado, token > 60 chars, callback desconhecido,
  corpo legado compatível com a RC3, mensagem com quebras reais.

## 6. Commits

Branch `fix/ddos-shared-policy-remove-confirmation` (base `0e7099c`, tag RC3).

| Commit | Conteúdo |
| --- | --- |
| `ef0fa50` | token de escopo de uso único, gate no `MitigationCommandService`, contrato inbound, `forgetProfiles`, testes e sub-workflows n8n |
| `8e70d5a` | vínculo com o chat de origem, `chatId` no inbound, `writeAttempted` no caminho MOCK, mensagens reais (nós Code) e ramo de falha de API, 6 testes novos |
| `69a0d7e` | workflow único `GMJ-NetVision-Telegram-RC4-CORRIGIDO.json` com o callback de escopo integrado ao export real |
| `2d332a7` | bearer do canal n8n por credencial Header Auth (sem segredo no JSON) |
| *RC4 final* | `POST /api/integrations/n8n/mitigation-scope-cancel` (revogação), orçamento de `callback_data`, operador nominal obrigatório, correção de `answerQuery`/`queryId` no workflow |

## 7. Plano de publicação e rollback

**Não publicar sem autorização**: a API RC3 está em produção com FAST ENFORCE na
BHNET-3043 e a publicação exige restart da API.

### Ordem obrigatória: API primeiro, workflows depois

| Ordem | Por que |
| --- | --- |
| 1. API RC4 | O canal antigo continua funcionando (envia só `profileId`) e passa a receber `SCOPE_CONFIRMATION_REQUIRED` **com token**: nada é retirado sem confirmação |
| 2. Workflow único | Se fosse importado antes, o schema estrito da RC3 recusaria `scopeConfirmationToken` com `400` — inofensivo, mas inútil |
| 3. `chatId`/`confirmedBy` no corpo legado | `Montar Corpo do Comando` tem a constante `INCLUIR_DADOS_DE_ESCOPO = false`; troque para `true` **depois** da RC4 no ar para o token passar a ficar preso ao chat |

Nenhum estado intermediário executa retirada inesperada: o pior caso é o
operador ver "solicite novamente" e clicar de novo em RETIRAR MITIGAÇÃO.

1. Congelar janela (25 min), confirmar BHNET-3043/3044 `MITIGATED` e ausência de
   operação em andamento (`POLICY_BUSY`/`IN_FLIGHT`).
2. Build do commit em release separada (`/opt/netvision-fast-bridge/releases/rc4-<sha>`),
   preservando integralmente `rc3-0e7099c` (binário + BUILD.json + sha256).
3. `systemctl restart netvision-api netvision-mcp` (o MCP tem `Requires=` na API
   e **não** volta sozinho).
4. Validar: `/health`, migrations inalteradas (41), 36 perfis, estado dos
   runtimes, `MITIGATION_FAST_BRIDGE_MODE`/`ENFORCE_PROFILE_IDS` vindos do
   `api-gate3.env`, BHNET ainda `MITIGATED`, readback Huawei inalterado
   (`/api/bgp/mitigation/policies/reconcile/preview`, somente leitura).
5. Banco/MCP/Fast Observer: contagens inalteradas; observador sem restart.
6. n8n: criar a credencial `NetVision n8n Command`, importar o workflow único,
   preencher `OPERADORES_RETIRADA_COMPARTILHADA` (ou
   `NETVISION_TELEGRAM_OPERATORS`), salvar e homologar com **policy de
   laboratório** antes de valer no grupo de operação.
7. Depois da RC4 validada: `INCLUIR_DADOS_DE_ESCOPO = true` e novo teste de
   `remove_execute` + `rmx:` (o token passa a recusar outro chat).
8. `grep` no journal: nenhuma reativação automática inesperada em 15 min.

### Efeito do restart nas confirmações

O store é em memória: tokens emitidos antes do restart deixam de existir e a
tentativa seguinte devolve `SCOPE_CONFIRMATION_TOKEN_UNKNOWN` **com um token
novo**. Nada fica "meio confirmado" e nenhum runtime muda.

### Rollback coordenado

| Camada | Ação |
| --- | --- |
| API | remover o drop-in da release RC4, `daemon-reload`, `systemctl restart netvision-api` (volta ao binário `rc3-0e7099c`) |
| n8n | desativar a ligação nova e reativar o workflow anterior (backup exportado antes da importação) |

Antes de declarar o rollback concluído, conferir o **estado externo**: readback
Huawei da policy, runtimes dos 36 perfis e eventos de mitigação. Um rollback da
API não desfaz uma retirada já aplicada no equipamento.

### Ações que exigem autorização explícita

1. Reiniciar `netvision-api` na IMPLANTAR.
2. Publicar a release RC4.
3. Importar/ativar workflows no n8n.
4. Executar qualquer REMOVE real.
5. Alterar policy, BGP, MPLS, VSI ou interface no Huawei.
6. Alterar thresholds, perfis, permissões AUTO ou FAST ENFORCE.

## 8. Riscos

| Risco | Severidade | Mitigação |
| --- | --- | --- |
| Confirmação usada em escopo que mudou | alta | hash de composição + revalidação sob lock (`SCOPE_CHANGED`) |
| Replay de confirmação | alta | uso único + expiração + `requestId` idempotente |
| Retirada de outro cliente por engano | alta | token vinculado ao perfil de origem e ao escopo |
| Botão encaminhado para outro grupo | média | `chatId` gravado no token (`CHAT_MISMATCH`) |
| Reativação imediata pelo FAST | alta | reset de contadores + `forgetProfiles` + guarda de identidade |
| Mensagem do Telegram sem a lista completa | média | texto gerado a partir de `removalScope.affected` |
| Token em log ou histórico do Telegram | média | API nunca loga o token; retenção do n8n restrita |
| Dependência do processo único da API | baixa | restart invalida tokens pendentes (fail-closed: pedir de novo) |
| Janela entre API e n8n | baixa | ordem API→n8n; o canal antigo continua fail-closed |

## 9. Etapa que depende de acesso ao n8n

A instância `automacao.gmjtelecom.com.br` responde HTTP 200, mas **não há acesso
autenticado** (nem API key, nem SSH) a partir da IMPLANTAR ou da estação de
trabalho. Por isso a importação não foi executada e nenhum workflow ativo foi
alterado.

O que o operador precisa fazer, nesta ordem:

1. **Exportar** o workflow atual do Telegram (backup antes de qualquer mudança).
2. Abrir o **mesmo** workflow e usar ⋯ → *Import from File…* →
   `docs/n8n/GMJ-NetVision-Telegram-RC4-CORRIGIDO.json` (substitui o conteúdo
   preservando id, webhookIds e o único Telegram Trigger). **Não** importar como
   workflow novo, para não duplicar trigger/webhook.
3. Criar a credencial **Header Auth** `NetVision n8n Command`
   (`Authorization` = `Bearer <token atual>`) e selecioná-la nos 2 nós HTTP.
4. Preencher `OPERADORES_RETIRADA_COMPARTILHADA` (ids do Telegram) no nó
   `Interpretar Callback` — sem isso, `rmx:`/`rmc:` são recusados (fail-closed).
5. Salvar. Homologar em um perfil de laboratório antes de habilitar no grupo.
6. Depois da RC4 no ar: `INCLUIR_DADOS_DE_ESCOPO = true` no nó
   `Montar Corpo do Comando`.

Nada disso foi publicado: o texto acima é procedimento, não estado atual.

## 10. Evidência do estado real (auditoria desta missão)

| Item | Valor observado em 2026-10-19 |
| --- | --- |
| API RC3 | PID `2295352`, release `rc3-0e7099c`, ativa desde 01:27:27Z, `/health` 200 |
| Bundle RC3 | `apiBundleSha256 = 7d907bfe…` (BUILD.json), commit `0e7099c` |
| Fast Observer | PID `2243027`, `mode=OBSERVE`, `executionAvailable=false`, `healthy=true` |
| Flags efetivas | `BRIDGE_MODE=ENFORCE`, `ENFORCE_PROFILE_IDS=cmuoavm4x00c3sslhworjdb9i`, `WRITES_ENABLED=true`, `POLL_MODE=OFF`, `AUTO_EXECUTION_ENABLED=0` |
| Perfis | 36 (33 `NORMAL`, 2 `MITIGATED`, 1 `DISABLED`) |
| BHNET-CEASA | `cmuoavm4x00c3sslhworjdb9i` · Eth-Trunk1.3043 · peer 10.200.200.222 · **MITIGATED** |
| BHNET-RBN | `cmuoavm5i00c8sslhed09lt8p` · Eth-Trunk1.3044 · peer 10.200.200.226 · **MITIGATED** |
| Policy Huawei | `PL-BHNET_IPv4-IN` · MITIGATED · par físico `1`/`2` (readback 13:57:43Z) |
| Migrations | 41 (`20261024000000_mitigation_fast_bridge`) |
| Último clique real do operador | 13:42:51Z · `REMOVE` · `SCOPE_CONFIRMATION_REQUIRED` · `telegram-1434618944713210533` |
| Disco / swap | raiz 92 % (5,9 GB livres) · swap 3,7 GB de 4 GB em uso |
