# RC14-F — Kill switch global M8 e alerta FAST de deteccao bloqueada

Release **API-only** minima sobre a RC13 (`d6c07f2`), em producao no IMPLANTAR.

O objetivo e um so: **observar o ataque e alertar sem escrever no equipamento.**
Nada mais foi trazido da RC14 (ver "O que nao entrou").

---

## 1. Componentes

| Componente                        | Arquivo                                                                    |
| --------------------------------- | -------------------------------------------------------------------------- |
| Flag e fiacao                     | `apps/api/src/routes.ts`                                                   |
| Kill switch (barreira dupla)      | `apps/api/src/infrastructure/bgp/mitigation/mitigation-command-service.ts` |
| Motor AUTO (gate + episodio)      | `apps/api/src/worker/mitigation/mitigation-auto-engine.ts`                 |
| Politica do alerta (pisos de ENV) | `apps/api/src/worker/mitigation/mitigation-detection-alert-policy.ts`      |
| Payload + publisher               | `apps/api/src/application/mitigation-detection-alert.ts`                   |
| Evento e campos                   | `notification-publisher.ts`, `mitigation-webhook.ts`                       |
| Confirmacao de entrega            | `apps/api/src/infrastructure/media/n8n-media-transport.ts`                 |

---

## 2. Kill switch global (M8)

Flag `MITIGATION_AUTO_EXECUTION_ENABLED`, lida **uma vez no boot** (`/^(1|true|yes|on)$/i`).
Ausente/vazia/invalida = **DESLIGADO**. Mudar exige restart da API.

Com a execucao desligada **nenhuma ativacao automatica parte de perfil algum** — sweep, AUTO manual, isento legado ou allowlist. O gatilho continua registrado (`WOULD_ACTIVATE / AUTO_EXECUTION_DISABLED`) e o alerta continua sendo emitido. Mitigacao ativa nunca e tocada (o motor nunca emite `REMOVE`).

### 2.1 Cinco barreiras

| #   | Camada                   | Momento                                                                 |
| --- | ------------------------ | ----------------------------------------------------------------------- |
| 1   | Motor AUTO               | decisao, incondicional                                                  |
| 2   | Motor AUTO               | re-checagem apos runtime/escopo/cooldown, antes do comando              |
| 3   | Command service          | entrada do comando mutante, **antes** de preflight e SSH                |
| 4   | Command service          | imediatamente antes de `live.activate` / `executor.activate` / `remove` |
| 5   | Revalidacao de evidencia | `revalidateAutoEvidence` devolve `false`                                |

`isAutomaticCommand()` reconhece AUTO por **qualquer** sinal: `origin === 'AUTO'`, `requestId` com prefixo `auto-activate-`, ou `autoEvidence` presente. Um comando manual que imite o prefixo fica **mais** restrito, nunca menos.
Dependencia ausente **ou** que lanca = **bloqueado** (fail-closed).

### 2.2 O que o kill switch **nao** faz

- nao bloqueia comando **manual** (UI/n8n) — a retirada de mitigacao continua possivel;
- nao altera a contencao de familia IPv4/IPv6 da RC13;
- nao muda policy compartilhada, allowlist, ownership nem readback;
- nao remove nem cria nada no equipamento.

---

## 3. Deteccao separada da entrega (S5)

O alerta nao depende de `RECOVERY_PENDING`/`MITIGATED`. Deteccao e um fato de **telemetria**; entrega e um fato de **transporte**.

```
Amostra FAST (5 s)
        │
        ▼
┌───────────────────────────────┐
│ evaluateTraffic               │  gatilho / recuperacao / histerese
└───────────────┬───────────────┘
                ▼
      ┌─────────────────────┐
      │ ha DETECCAO?        │  samplesOver > 0 no limiar
      └─────┬─────────┬─────┘
        nao │         │ sim
            ▼         ▼
    episodio?   ┌──────────────────────────────┐
    recuperacao │ escrita AUTORIZADA?          │
    comprovada? └───┬──────────────────────┬───┘
     (12 amostras  │ sim                  │ nao
      normais)     ▼                      ▼
            encerra  ACTIVATE real   WOULD_ACTIVATE + motivo
            episodio (nao e FAST)    ┌────────────────────────┐
                                     │ ja existe episodio?    │
                                     └────┬───────────┬───────┘
                                        nao│           │sim
                                          ▼           ▼
                              abre episodio     aguarda (sem spam)
                              PENDING               │
                                          emissao devida? (REPEAT
                                          explicito ou 1a tentativa)
                                                  │
                                                  ▼
                                 ┌─────────────────────────────┐
                                 │ HTTP 2xx + delivered:true ? │
                                 └──────┬──────────────┬───────┘
                                     sim│              │nao
                                        ▼              ▼
                                   SENT (fim)   RETRY_SCHEDULED
                                                (backoff 30s→10min,
                                                 até 12 tentativas por padrão)
                                                       │
                                                       ▼
                                                  FAILED + WARN
```

### 3.1 Regras do episodio

- `episodeId = <profileId>:<startMs>` — estavel em todo retry.
- Amostra duplicada nao abre novo episodio.
- Ausencia de telemetria (`TELEMETRY_UNAVAILABLE`) e amostra stale **nao** encerram episodio.
- Encerra so com evidencia positiva: `samplesOver === 0 && samplesBelow >= recoverySamples (12) && trafficBps !== null`, ou `RECOVERY_PENDING`.
- Ataque prolongado nao gera spam: **uma** emissao por episodio.
- Novo ataque depois da normalizacao abre **novo** episodio, mesmo com AUTO desligado.
- Episodio sem prova de recuperacao expira em `episodeMaxMs` (default 6 h) com log.

### 3.2 Motivos que geram alerta

`AUTO_EXECUTION_DISABLED`, `AUTO_EXECUTION_NOT_AUTHORIZED`, `LIVE_WRITE_DISABLED`, `DEVICE_NOT_ALLOWED`, `GLOBAL_MODE_SIMULATION_ONLY`, `EXECUTOR_NOT_HUAWEI`.

---

## 4. Contrato do alerta

| Campo                                                | Valor                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `event`                                              | `MITIGATION_DETECTION_BLOCKED`                                       |
| `simulation`                                         | `true` (deteccao, nunca mitigacao aplicada)                          |
| `verified`                                           | `false`                                                              |
| `episodeId`                                          | identidade do episodio                                               |
| `blockedReason`                                      | motivo da recusa                                                     |
| `direction` / `directionSource`                      | direcao efetiva e sua origem                                         |
| `trafficMbps` / `thresholdMbps`                      | medida **real** em Mbps (Gbps arredonda para 0 abaixo de 1 Gbps)     |
| `fieldsUnavailable[]`                                | campos que nao puderam ser resolvidos (exibidos como "indisponivel") |
| `policy`, `interfaceName`, `peer`, `affectedPeers[]` | escopo do alvo                                                       |
| Header                                               | `X-NetVision-Token` (Header Auth nativo)                             |
| Confirmacao                                          | HTTP 2xx **e** `{"delivered":true}`                                  |
| Botoes de retirada                                   | **nenhum**                                                           |

Falha de transporte: HTTP 401/403, HTTP 200 sem `delivered:true`, timeout ou erro de rede → retry com backoff. Nunca conta como entregue.

### 4.1 Semantica

Entrega **at-least-once**. O timeout do sender e 10 s: se o destino entregar e o ACK se perder, a proxima tentativa pode duplicar a notificacao. **Nao existe deduplicacao persistente nem exactly-once**, e esta release nao afirma o contrario.

---

## 5. Configuracao

| ENV                                              | Default      | Piso                          |
| ------------------------------------------------ | ------------ | ----------------------------- |
| `MITIGATION_AUTO_EXECUTION_ENABLED`              | desligado    | `1/true/yes/on`; lido no boot |
| `MITIGATION_AUTO_DETECTION_EPISODE_IDLE_SECONDS` | 120          | >= 60                         |
| `MITIGATION_AUTO_DETECTION_REPEAT_SECONDS`       | sem lembrete | >= 300                        |
| `MITIGATION_AUTO_DETECTION_INTERVAL_SECONDS`     | 1800         | >= 60                         |
| `MITIGATION_AUTO_DETECTION_MAX_ATTEMPTS`         | 5            | >= 1                          |

Valor fora da faixa e **recusado com WARN explicito** e o default e aplicado. Um `REPEAT` valido nunca e anulado silenciosamente pelo intervalo minimo.

---

## 6. Compatibilidade com o n8n RC7.1.1

Workflow publicado: `docs/n8n/GMJ-NetVision-Telegram-RC7.1-WORKFLOW-COMPATIBILITY.json`.

- 4 webhooks com **Header Auth nativo** e 4 credenciais independentes;
- `netvision-mitigation` responde por no `Respond` alcancavel (`routed`/`delivered`/`event`/`profileId`/`episodeId`);
- `MITIGATION_VERIFIED` e `MITIGATION_STATUS_RESEND` validos seguem com botoes;
- `MITIGATION_DETECTION_BLOCKED` vai para o aviso de deteccao **sem** botoes;
- `MITIGATION_TEST` e evento desconhecido: `routed:false`;
- zero `$env`, zero token literal.

Verificacao automatica: `apps/api/src/infrastructure/bgp/mitigation/mitigation-workflow-rc71.test.ts` (25 casos).
**Homologacao dinamica permanece pendente** — o ambiente nao tem Docker/n8n.

---

## 7. Operacao manual preservada

Esta release **nao** carrega as mudancas N1–N4 da RC14: sem `local-preference 3000`, sem exigencia de LP3000 no readback, sem bloqueio de ACTIVATE manual IPv6, sem remocao de `FAMILY_CONTENTION`.

Prova: `apps/api/src/infrastructure/bgp/mitigation/mitigation-rc14f-parity.test.ts` (11 casos) + a suite da RC13 sem alteracao de assercao.

---

## 8. Limitacoes

1. Homologacao dinamica do n8n pendente (sem Docker/n8n no ambiente).
2. Deteccao operacional so se comprova com trafego real acima do gatilho.
3. Rate limit de alerta e **por processo**, em memoria (RC6-A4 aberto): N reinicios podem gerar N notificacoes. Nao ha rate limit global.
4. `MITIGATION_STATUS_RESEND` continua sem produtor na API.

---

## 9. Rollback

O roteiro original apenas com M8=0 foi rejeitado. Ver o
[plano Codex corrigido](RC14F_CODEX_DEPLOY_ROLLBACK.md): congelar MODE e LIVE_WRITE,
preservar HUAWEI/allowlist e verificar precedência de EnvironmentFile. Nenhuma
publicação nem rollback foi executado nesta auditoria.

## 10. Correção Codex de entrega

Um alerta pendente não é mais descartado quando a telemetria comprova recuperação.
A fila de entrega em memória é drenada em cada tick, mesmo sem nova amostra ou sem
perfil na lista. Mantém episodeId e payload do primeiro evento, backoff, limite de
tentativas e serialização por perfil. Expira com falha observável em até seis horas.
Não há persistência da fila entre processos; não prometer entrega at-least-once
durável. Rate limit continua local ao processo. A expiração de episódio e da fila
pode levar a uma nova emissão de um ataque longo após seis horas.
