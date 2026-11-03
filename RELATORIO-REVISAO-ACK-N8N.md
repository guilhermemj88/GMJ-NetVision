# RELATORIO — REVISAO PONTUAL DO ACK N8N

Ambiente: IMPLANTAR · API ativa `2ad62b8` · executado em **2026-11-03** (UTC-3)
Escopo: **somente leitura**. Nenhuma alteracao em n8n, API, banco, flags ou equipamento.

---

## 1. Causa exata

O evento `MITIGATION_SIMULATION_TRIGGERED` **nao e um evento entregavel** pelo workflow
n8n. Ele e rejeitado pelo contrato do normalizador e o webhook responde, corretamente,
`routed:false` / `delivered:false`.

A API, porem, exige `delivered === true` para **qualquer** evento desde que
`requireAcknowledgement` esta ligado — e ele esta ligado porque
`MITIGATION_AUTO_PERSISTENCE_ENABLED=1`:

```
apps/api/src/routes.ts:818
  requireAcknowledgement: process.env.MITIGATION_AUTO_PERSISTENCE_ENABLED === '1',

apps/api/src/infrastructure/media/n8n-media-transport.ts:251-255
  if (input.event === 'MITIGATION_DETECTION_BLOCKED' || this.deps.requireAcknowledgement) {
    const delivered = (...body).delivered === true;
    if (!delivered || ...) safeError = 'Webhook nao confirmou a entrega do alerta (delivered != true)';
```

Resultado: HTTP 200 (sucesso de transporte) tratado como falha de entrega → nova tentativa
→ mesmo resultado → `FAILED` apos 12 tentativas.

**Nao e falha de rede, nao e falha do n8n e nao e regressao do B6.** E uma lacuna de
contrato entre produtor e consumidor para a classe "simulacao".

### Prova de que nao e regressao do B6

| Fato | Evidencia |
| --- | --- |
| A exigencia de ACK nasceu em `bdc3514` (2026-10-29) | `git log -S` em `routes.ts` e `n8n-media-transport.ts` |
| `bdc3514` ja esta na release anterior `bf7bc52` | `git merge-base --is-ancestor bdc3514 bf7bc52` = verdadeiro |
| `bf7bc52` e `2ad62b8` tem o mesmo codigo de ACK | 2 ocorrencias de `requireAcknowledgement` e 1 de `transport did not acknowledge delivery` em **ambos** os bundles |
| Persistencia ja estava ligada antes da publicacao B6 | `/etc/netvision/single-pilot-4637696-auto0.env` (`=1`, criado 2026-10-30 19:25Z) declarado por drop-in **presente no snapshot pre-B6** (`api-unit-before.txt`, 20:09Z) |
| Antes de 2026-10-29 o mesmo evento era aceito | `MediaDeliveryLog`: `MITIGATION_SIMULATION_TRIGGERED` `SUCCESS` em **2026-09-30 17:34:40Z** |

O caminho nunca havia sido exercitado depois de 2026-10-29: este preflight de 2026-11-02 foi
o **primeiro** `SIMULATE_ACTIVATE` desde entao.

---

## 2. Node responsavel pela resposta HTTP

O webhook `Webhook NetVision OUT` (`n8n-nodes-base.webhook`) usa
`responseMode: "responseNode"`, portanto a resposta HTTP e produzida pelo node:

**`Responder OUT 200`** — `n8n-nodes-base.respondToWebhook`, `typeVersion 1.4`,
`respondWith: json`, `responseCode: 200`.

A decisao vem de duas partes:

1. `Normalizar Evento OUT` (`n8n-nodes-base.set`, modo `raw`) — calcula
   `RC712_VALID` / `RC712_ROUTE`.
2. `Responder OUT 200` — funcao `deliveryAck(normalized, receipt)`:
   `routed = RC712_VALID === true && ['ACTIVATED','DETECTION','STATUS'].includes(RC712_ROUTE)`
   e `delivered = routed && receipt ... message_id > 0`.

Caminho para uma simulacao (todos os gates falsos):

```
Webhook NetVision OUT
  -> Normalizar Evento OUT        (MITIGATION_SIMULATION_TRIGGERED nao e aceito -> reject('UNKNOWN_EVENT'))
  -> Somente Mitigacao Real Verificada   (REAL_ACTIVATED = false)
  -> Somente Deteccao Bloqueada?         (DETECTION_BLOCKED = false)
  -> Somente Status Mitigacao RC712?     (MITIGATION_STATUS = false)
  -> Responder OUT 200                   (routed=false, delivered=false)
```

Nenhum node Telegram e executado — comportamento correto e intencional para simulacao.

### Identidade da versao publicada (limitacao registrada)

Nao foi possivel ler a versao **ativa** do workflow: o host do n8n nao aceita SSH a partir
do IMPLANTAR (22/5678 filtrados, apenas 443 aberto) e nao existe chave de API disponivel
(o n8n guarda apenas o hash; a chave ampla `h7LjVLsx9tnzXsYJ` segue sem revogacao).
O que foi verificado, com evidencias versionadas:

| Constatacao | Fonte |
| --- | --- |
| `Responder OUT 200` e **identico** nas duas geracoes comparadas | diff de `docs/n8n/PRE-EDIT-draft-de-producao.json` (RC7.1.1) x `docs/evidence/n8n-current-draft-20261101.json` (RC7.1.2) → unica diferenca e `Normalizar Evento OUT` |
| O normalizador **pre**-RC7.1.2 ja emitia `RC712_VALID`/`RC712_ROUTE` e ja rejeitava simulacao com `UNKNOWN_EVENT` | `docs/n8n/PRE-EDIT-draft-de-producao.json`, linhas 23-24, 77, 102, 115, 157 |
| A versao ativa difere do rascunho pre-edicao apenas em 2 posicoes de node | `RELATORIO-ENCERRAMENTO-INCIDENTE-N8N-READONLY.md` |
| Em 2026-11-01 00:55Z o `activeVersionId` ainda era `6a97fe4a` | `docs/evidence/n8n-current-draft-20261101.json` |

Conclusao: **qualquer** das duas versoes candidatas produz `routed:false` para simulacao.
O resultado observado nao depende de qual delas esta publicada.

---

## 3. Reproducao deterministica (payload real, codigo real)

O payload persistido no outbox (`sim-b6-1793652153`) foi submetido ao codigo do node
`Normalizar Evento OUT` e a funcao `deliveryAck`, executados no proprio IMPLANTAR com o
Node da release, **sem nenhuma chamada ao n8n**:

```
== payload enviado pela API ==
   event = "MITIGATION_SIMULATION_TRIGGERED"   simulation = true   verified = null
   eventId = "sim-b6-1793652153"   profileId = "cmuoavm4e00bysslhqd0h3q7u"
   policy = "PL-AGLINK_IPv4-IN"    rt = "268568:660"    bogonNode = 1   mitigationNode = 2
   addressFamily = "IPV4"

== saida do Normalizar Evento OUT ==
   RC712_VALID = false      RC712_ROUTE = null      MOTIVO = "UNKNOWN_EVENT"
   REAL_ACTIVATED = false   DETECTION_BLOCKED = false   MITIGATION_STATUS = false

== corpo HTTP devolvido pelo webhook ==
   {"ok":true,"received":true,"routed":false,"delivered":false,
    "event":"MITIGATION_SIMULATION_TRIGGERED","eventId":"sim-b6-1793652153",
    "profileId":"cmuoavm4e00bysslhqd0h3q7u","episodeId":null}

== decisao da API ==
   requireAcknowledgement = true
   aceito como entregue   = false
   safeError              = Webhook nao confirmou a entrega do alerta (delivered != true)
```

O `safeError` reproduzido e **byte a byte** o registrado nas 12 tentativas reais.

---

## 4. Resposta atual e resposta necessaria

| | Corpo |
| --- | --- |
| **Atual** | `{"ok":true,"received":true,"routed":false,"delivered":false,...}` |
| **Exigida pela API hoje** | `{"delivered":true}` — **impossivel sem mentir** |
| **Semanticamente correta** | a atual: o evento foi recebido e **nao** foi entregue (nao havia o que entregar) |

`delivered:true` significaria "alerta entregue no Telegram com `message_id` valido". Para
simulacao isso e falso: nenhum Telegram e enviado por desenho. Fazer o n8n devolver `true`
seria fabricar ACK, mascararia falhas reais de entrega e violaria o contrato de fail-closed
que o proprio workflow implementa. **O n8n esta correto e nao deve ser alterado nesse ponto.**

---

## 5. Impacto sobre eventos pendentes

| Item | Situacao |
| --- | --- |
| Linha no outbox | `outbox:MITIGATION_SIMULATION_TRIGGERED:sim-b6-1793652153` |
| Estado final | **`FAILED`** com `attempts = 12` (criada 2026-11-02 20:42:40.724Z, encerrada 21:59:03.116Z) |
| Tentativas | 12 chamadas HTTP 200, latencia 207–1224 ms, mesmo `safeError` |
| Repeticoes futuras | nenhuma: `dueOutbox()` filtra `status in ('PENDING','SENDING')` |
| Bloqueio de outras operacoes | nenhum: `kind='outbox'` nao e baseline (`kind<>'outbox'` = 0) e o lifecycle nao depende de linhas `FAILED` |
| Baseline B6 | intacto — nenhum registro de baseline criado ou perdido |
| Custo operacional | por simulacao futura: 12 chamadas ao webhook e 12 linhas em `MediaDeliveryLog` ate virar `FAILED` |

Nada precisa (nem deve) ser apagado ou marcado manualmente. A linha e inerte.

**A ausencia de `delivered` e o unico motivo das novas tentativas**: todas as 12 tentativas
tiveram HTTP 200, sem timeout (latencia maxima 1224 ms), sem erro de rede e com o mesmo
`safeError`. Nao ha segunda causa.

---

## 6. Correcao minima proposta (nao implementada)

Ponto unico, no **produtor** (API), sem tocar no workflow:

`apps/api/src/infrastructure/media/n8n-media-transport.ts`, linhas 248-254 — separar
"evento entregavel" de "evento de simulacao":

```ts
// Simulacao nao e roteada para Telegram: nao existe entrega a confirmar.
const NOT_DELIVERABLE = new Set([
  'MITIGATION_SIMULATION_TRIGGERED',
  'MITIGATION_REMOVE_SIMULATED',
]);

const result = await this.deps.send(channel.url, input.payload, headers);
const ack = (result.body ?? null) as
  | { delivered?: unknown; received?: unknown; routed?: unknown }
  | null;

if (NOT_DELIVERABLE.has(input.event)) {
  // Fail-closed: o destino precisa confirmar que PROCESSOU o evento e que
  // deliberadamente nao o roteou. Corpo ausente/invalido continua falhando.
  const processed = ack?.received === true && ack?.routed !== true;
  if (!processed) { /* registra falha e agenda retry (inalterado) */ }
} else if (input.event === 'MITIGATION_DETECTION_BLOCKED' || this.deps.requireAcknowledgement) {
  const delivered = ack?.delivered === true;   // regra atual, inalterada
  if (!delivered || ...) { /* registra falha e agenda retry (inalterado) */ }
}
```

Propriedades:

- Nenhum evento real deixa de exigir `delivered:true` (VERIFIED, DETECTION_BLOCKED,
  STATUS_RESEND, REMOVED_VERIFIED, FAILED).
- Nao existe caminho em que a API aceite "sem resposta": `received:true` explicito e
  obrigatorio; corpo nulo, nao-JSON ou `received:false` continuam gerando retry.
- Restaura o comportamento anterior a 2026-10-29 (quando a simulacao era registrada como
  `SUCCESS`), agora com confirmacao explicita de processamento.

### Alternativas descartadas

| Alternativa | Motivo do descarte |
| --- | --- |
| n8n devolver `delivered:true` para simulacao | Fabrica ACK; mascara falha real; viola o contrato que o workflow implementa |
| n8n devolver `delivered:true` so quando `routed:false` | Mesmo problema: muda o significado de `delivered` para o consumidor |
| Nao publicar simulacao no outbox | Altera o motor de mitigacao (`MitigationCommandService.publish`) — proibido nesta missao; remove rastreabilidade |
| Baixar `MITIGATION_AUTO_PERSISTENCE_ENABLED` para 0 | Desabilita a persistencia duravel do baseline B6 — inaceitavel |

---

## 7. Plano de validacao (para quando houver autorizacao)

1. Testes unitarios em `n8n-media-transport` / `auto-outbox-http`:
   - simulacao + `{received:true,routed:false,delivered:false}` -> `ok:true`, sem retry,
     outbox `SENT` na 1a tentativa;
   - simulacao + corpo nulo/nao-JSON -> `ok:false` (retry preservado);
   - simulacao + `{received:false}` -> `ok:false`;
   - `MITIGATION_VERIFIED` com `{received:true,routed:false}` -> `ok:false` (inalterado);
   - `MITIGATION_DETECTION_BLOCKED` HTTP 200 sem `delivered` -> `ok:false` (inalterado);
   - `MITIGATION_VERIFIED` com `{delivered:true}` -> `ok:true` (inalterado).
2. Suite completa da API + `tsc --noEmit` + `eslint --max-warnings=0`.
3. Validacao funcional em producao somente com autorizacao: um `SIMULATE_ACTIVATE` no perfil
   `cmuoavm4e00bysslhqd0h3q7u` deve produzir **1** linha `SUCCESS` em `MediaDeliveryLog`,
   outbox `SENT` com `attempts=1` e nenhum Telegram.
4. Confirmar `MitigationAutomationRecord` com `kind<>'outbox'` = 0 ao final.

## 8. Rollback

Reverter o commit: a API volta ao comportamento atual (retry/`FAILED`). Sem migration, sem
DDL, sem alteracao de flag, sem alteracao de n8n, sem reinicio de WEB/MCP.

---

## 9. Evidencias coletadas (somente leitura)

| Verificacao | Resultado |
| --- | --- |
| `MediaDeliveryLog` do evento | 12 linhas `FAILED`, HTTP 200, `safeError` unico |
| Linha historica equivalente | `MITIGATION_SIMULATION_TRIGGERED` `SUCCESS` em 2026-09-30 |
| Outbox | 1 linha `FAILED`, `attempts=12`, `nextAt` 22:09:03Z |
| `MediaIntegration` BGP_MITIGATION | `inboundEnabled=t`, `lastInboundAction=SIMULATE_ACTIVATE`, `lastInboundStatus=SUCCESS` (o n8n **recebeu** e processou) |
| Webhook sem token | `403 Authorization data is wrong!` (headerAuth ativo) |
| Alcance do n8n a partir do IMPLANTAR | 443 aberto (200/401); 22 e 5678 filtrados |
| `kind<>'outbox'` (baseline) | 0 registros |
| Nucleo BGP/route-policies | intocado; nenhuma conexao ao Huawei nesta missao |

## 10. Nao-alteracao

Nenhuma alteracao de workflow, node, credencial, trigger ou Telegram · nenhuma publicacao
no n8n · nenhum evento apagado ou marcado · nenhum restart de servico · nenhuma alteracao
de flag · `LIVE_WRITE=false` e AUTO=0 preservados · nenhum `ACTIVATE`/`REMOVE` fisico ·
nenhuma escrita no Huawei · nenhuma migration · nenhum deploy · nenhum push.
