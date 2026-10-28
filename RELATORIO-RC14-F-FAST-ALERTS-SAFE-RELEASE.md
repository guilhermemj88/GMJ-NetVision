# RC14-F — FAST ALERTS SAFE RELEASE (release minima de alerta de deteccao)

**Base:** RC13 `d6c07f2` (release em producao no IMPLANTAR)
**Branch:** `feature/fast-alerts-rc14f`
**Worktree:** `/home/guilherme/fast-auto-ipv4-rc14f`
**Natureza:** release API-only, sem deploy. Nada foi publicado, reiniciado, migrado ou escrito em equipamento.

---

## 1. Objetivo e resultado

Entregar **o menor delta seguro** sobre a RC13 capaz de:

1. fechar o buraco do kill switch (M8) em **todos** os caminhos de escrita automatica Huawei;
2. produzir o alerta FAST real de **deteccao bloqueada** (`MITIGATION_DETECTION_BLOCKED`) quando o ataque e observado mas a escrita nao e autorizada;
3. **preservar integralmente** a operacao manual da RC13 (ACTIVATE/REMOVE por UI e n8n, IPv4 e IPv6).

**Resultado: GO condicionado** para publicacao API-only (§9), apos autorizacao explicita. Ver §10.

---

## 2. Delta RC13 → RC14-F

`31 arquivos, 4517 insercoes(+), 67 remocoes(-)` — sendo 2130 linhas o JSON do workflow n8n (documentacao/verificacao) e ~1600 linhas de teste.

### 2.1 Codigo de runtime (8 arquivos — este e o risco real)

| Arquivo                                                                    | Δ           | Papel                                                                                            |
| -------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------ |
| `apps/api/src/application/mitigation-detection-alert.ts`                   | +135 (novo) | payload + publisher do alerta de deteccao (testavel isolado)                                     |
| `apps/api/src/worker/mitigation/mitigation-detection-alert-policy.ts`      | +116 (novo) | pisos/defaults validados de ENV da politica de alerta                                            |
| `apps/api/src/worker/mitigation/mitigation-auto-engine.ts`                 | +338 / -18  | M8 incondicional + maquina de episodio de deteccao                                               |
| `apps/api/src/infrastructure/bgp/mitigation/mitigation-command-service.ts` | +85 / -0    | kill switch com barreira dupla (entrada + antes da escrita) — **puramente aditivo**              |
| `apps/api/src/routes.ts`                                                   | +59 / -10   | leitura da flag, politica, publisher, `origin: 'AUTO'`                                           |
| `apps/api/src/infrastructure/media/n8n-media-transport.ts`                 | +40 / -1    | corpo da resposta + `delivered === true` **so** para deteccao                                    |
| `apps/api/src/infrastructure/bgp/mitigation/mitigation-webhook.ts`         | +24 / -0    | campos `trafficMbps`/`thresholdMbps`/`episodeId`/`blockedReason`/`direction`/`fieldsUnavailable` |
| `apps/api/src/infrastructure/bgp/mitigation/notification-publisher.ts`     | +19 / -0    | evento `MITIGATION_DETECTION_BLOCKED` + campos opcionais                                         |

Comparativo: a RC14 (`4ff951a`) tem **80 arquivos / 14154 insercoes / 389 remocoes**. A RC14-F e ~1/3 do tamanho e **zero remocao em arquivo de dominio de mitigacao** (as 67 remocoes sao o bloco `autoExecutionEnabled` realocado em `routes.ts` e linhas de teste substituidas).

### 2.2 Testes e documentacao

| Arquivo                                                             | Δ            | Cobertura                                                      |
| ------------------------------------------------------------------- | ------------ | -------------------------------------------------------------- |
| `mitigation-m8-write-matrix.test.ts`                                | +284 (novo)  | 16 casos: matriz exaustiva de escrita automatica               |
| `mitigation-detection-alert.test.ts`                                | +381 (novo)  | 9 casos: episodio/entrega com 24 amostras de telemetria REAL   |
| `mitigation-rc14f-parity.test.ts`                                   | +250 (novo)  | 11 casos: prova de que N1–N4 nao entraram e manual segue igual |
| `mitigation-workflow-rc71.test.ts`                                  | +404 (novo)  | 25 casos: compatibilidade com o n8n RC7.1.1 publicado          |
| `__fixtures__/flash-3066-tx-real-samples.json`                      | +111 (novo)  | 24 amostras txBps reais (391–673 Mbps vs gatilho 8.58 Gbps)    |
| `docs/n8n/GMJ-NetVision-Telegram-RC7.1-WORKFLOW-COMPATIBILITY.json` | +2130 (novo) | workflow RC7.1.1 publicado pelo operador (documentacao)        |
| 13 arquivos de teste existentes                                     | +137 / -39   | declaracao explicita do kill switch nos harnesses              |

**Nenhuma assercao de negocio foi enfraquecida.** Nos testes que exercitam escrita real, o kill switch passou a ser declarado `{ enabled: true }` — antes a dependencia era simplesmente ausente e o teste "funcionava por acidente", que era exatamente o defeito do M8.

---

## 3. M8 — kill switch global

### 3.1 Flag

`MITIGATION_AUTO_EXECUTION_ENABLED` — lida **uma vez no boot** em `routes.ts` com `/^(1|true|yes|on)$/i`.
Ausente, vazia ou qualquer outro valor = **DESLIGADO** (fail-closed). Mudar a flag exige restart da API.

### 3.2 Semantica

Com a execucao desligada, **nenhuma ativacao automatica parte de perfil algum**:

- perfil AUTO definido manualmente (sem sweep);
- perfil promovido pelo sweep (`autoPromotedBySweep`);
- perfil isento legado (`MITIGATION_AUTO_EXECUTION_LEGACY_PROFILE_IDS`);
- perfil presente na allowlist (`MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS`);
- comando que apenas _parece_ manual (`requestId` com prefixo `auto-activate-` ou com `autoEvidence`).

O gatilho continua sendo **observado e registrado** (`WOULD_ACTIVATE` + motivo `AUTO_EXECUTION_DISABLED`) e o alerta de deteccao continua sendo emitido. Mitigacao ja ativa **nunca** e tocada: o motor nunca emite `REMOVE`.

### 3.3 Barreiras (defesa em profundidade)

| #   | Camada                      | Onde                            | Comportamento                                                                                              |
| --- | --------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Motor AUTO (decisao)        | `mitigation-auto-engine.ts`     | `if (!this.autoExecutionEnabled())` → `WOULD_ACTIVATE/AUTO_EXECUTION_DISABLED`, incondicional              |
| 2   | Motor AUTO (re-checagem)    | `mitigation-auto-engine.ts`     | reavaliado **apos** runtime/escopo/cooldown, imediatamente antes do comando                                |
| 3   | Command service (entrada)   | `mitigation-command-service.ts` | comando mutante (`ACTIVATE`/`REMOVE`) de origem AUTO para **antes** de preflight e SSH                     |
| 4   | Command service (pre-write) | idem                            | reconsultado imediatamente antes de `live.activate`, `executor.activate` e `live.remove`/`executor.remove` |
| 5   | Revalidacao de evidencia    | `routes.ts`                     | `revalidateAutoEvidence` devolve `false` com a flag desligada                                              |

`isAutomaticCommand()` e fail-closed por **qualquer** sinal: `origin === 'AUTO'` **ou** prefixo `auto-activate-` **ou** `autoEvidence` presente. `autoExecutionBlocked()` trata dependencia ausente **e** dependencia que lanca como **bloqueado**.

### 3.4 Matriz de regressao de escrita Huawei

Fonte: `apps/api/src/infrastructure/bgp/mitigation/mitigation-m8-write-matrix.test.ts` (16 casos, todos verdes).

| Caminho                                    | Flag | Resultado                                                | Escritas         |
| ------------------------------------------ | ---- | -------------------------------------------------------- | ---------------- |
| Motor: AUTO manual (sem sweep)             | 0    | `WOULD_ACTIVATE / AUTO_EXECUTION_DISABLED`               | 0                |
| Motor: promovido pelo sweep                | 0    | `WOULD_ACTIVATE / AUTO_EXECUTION_DISABLED`               | 0                |
| Motor: isento legado                       | 0    | `WOULD_ACTIVATE / AUTO_EXECUTION_DISABLED`               | 0                |
| Motor: presente na allowlist               | 0    | `WOULD_ACTIVATE / AUTO_EXECUTION_DISABLED`               | 0                |
| Motor: allowlist + sweep + isento          | 0    | `WOULD_ACTIVATE / AUTO_EXECUTION_DISABLED`               | 0                |
| Motor: mesmo cenario (controle)            | 1    | comando emitido                                          | >0               |
| Motor: runtime `MITIGATED`                 | 1    | **nunca** emite ACTIVATE/REMOVE                          | 0                |
| Command service: ACTIVATE `origin=AUTO`    | 0    | `AUTO_EXECUTION_DISABLED`                                | 0                |
| Command service: REMOVE `origin=AUTO`      | 0    | `AUTO_EXECUTION_DISABLED`                                | 0                |
| Command service: `requestId` prefixo AUTO  | 0    | `AUTO_EXECUTION_DISABLED`                                | 0                |
| Command service: `autoEvidence` presente   | 0    | `AUTO_EXECUTION_DISABLED`                                | 0                |
| Command service: dependencia **ausente**   | —    | bloqueado (fail-closed)                                  | 0                |
| Command service: dependencia que **lanca** | —    | bloqueado (fail-closed)                                  | 0                |
| Command service: comando **MANUAL**        | 0    | **nao** bloqueado                                        | conforme negocio |
| Worker de mitigacao                        | —    | bundle sem `activate`/`remove`/`commit`                  | 0                |
| Producao                                   | —    | apenas `routes.ts` constroi o `MitigationCommandService` | —                |

### 3.5 FAST observer sem acesso a escrita

`apps/api/src/infrastructure/snmp/fast-observer.test.ts` → `built artifact contains no engine, command service or SSH transport`: o bundle `dist/mitigation-fast-observer-main.cjs` **nao** contem o motor AUTO, o command service nem o transporte `ssh2`. O observer e estruturalmente incapaz de escrever.

---

## 4. Deteccao independente da mitigacao (S5 / RC6-A1)

O produtor de `MITIGATION_DETECTION_BLOCKED` **nao** depende de `RECOVERY_PENDING`/`MITIGATED` e nao usa transicao de mitigacao fisica para encerrar episodio.

### 4.1 Motivos que geram alerta (deteccao real + escrita recusada)

`AUTO_EXECUTION_DISABLED`, `AUTO_EXECUTION_NOT_AUTHORIZED`, `LIVE_WRITE_DISABLED`, `DEVICE_NOT_ALLOWED`, `GLOBAL_MODE_SIMULATION_ONLY`, `EXECUTOR_NOT_HUAWEI`.

### 4.2 Episodio

- Identidade: `episodeId = <profileId>:<startMs>` — estavel durante todo o retry.
- Abre na primeira transicao `WOULD_ACTIVATE` com motivo da lista.
- **Amostras duplicadas nao abrem novo episodio** (troca de tick sem amostra nova nao e deteccao nova).
- **Ausencia de telemetria nao encerra** episodio (`TELEMETRY_UNAVAILABLE` mantem aberto).
- **Amostra stale nao comprova normalizacao.**
- Encerra **somente** com evidencia positiva: `samplesOver === 0 && samplesBelow >= recoverySamples && trafficBps !== null` (12 amostras normais consecutivas) ou `RECOVERY_PENDING`.
- Ataque prolongado **nao gera spam**: uma emissao por episodio (a RC6 media ~59 alertas/10 min por transicao).
- Rede de seguranca: episodio sem prova de recuperacao expira em `episodeMaxMs` (default 6 h) com log.
- Novo ataque depois da normalizacao abre **novo** episodio, mesmo com AUTO desligado.

### 4.3 Entrega (separada da deteccao)

Estados: `PENDING → RETRY_SCHEDULED → SENT` / `FAILED`.

- Uma unica tentativa em voo por episodio (`delivering`) — sem corrida entre ticks.
- Sucesso **somente** com HTTP 2xx **e** `body.delivered === true` do n8n.
- Falha agenda retry com backoff `30 s → 60 s → 120 s → 300 s → 600 s`, ate `maxDeliveryAttempts` (default 5); depois `FAILED` com WARN.
- `explicitRepeat` (lembrete do mesmo episodio) **nao** e anulado pelo intervalo minimo entre episodios (RC6-A6).
- Intervalo mínimo por profile entre emissões (`minAlertIntervalMs`, default 30 min) é somente em memória: NÃO contém restart/crash-loop entre processos.

---

## 5. Preservacao da operacao manual da RC13 (N1–N4 fora)

Fonte: `mitigation-rc14f-parity.test.ts` (11 casos, verdes) + a suite RC13 **sem alteracao de assercao**.

### 5.1 O que a RC14-F NAO tem (e a RC14 tem)

| Item RC14                                                           | Efeito                                                     | RC14-F  |
| ------------------------------------------------------------------- | ---------------------------------------------------------- | ------- |
| **N1** `local-preference 3000` no comando canonico                  | mudaria **todo** ACTIVATE, inclusive manual                | ausente |
| **N2** readback exigindo LP3000                                     | policies legadas passariam a falhar no preflight de REMOVE | ausente |
| **N3** `FAMILY_OUT_OF_PHASE` para ACTIVATE manual IPv6              | bloquearia retirada/ativacao manual IPv6                   | ausente |
| **N4** remocao de `FAMILY_CONTENTION`/`acknowledgeFamilyContention` | mudaria a semantica de familia nas rotas                   | ausente |
| `DIRECTION_NOT_VALIDATED` + `FAMILY_DEFAULT`                        | direcao implicita TX para IPv4                             | ausente |
| `mitigation-scope-recovery` / ownership / `deleteProfile`           | mudaria a prova de recuperacao no REMOVE manual            | ausente |
| `allowFamilyDefaultDirection`                                       | liberacao de escrita por direcao de familia                | ausente |

`mitigation-rc14f-parity.test.ts` verifica, por marcador de fonte, que nenhum destes simbolos existe nos arquivos tocados, e que `FAMILY_CONTENTION_UNRESOLVED`, `detectFamilyContention`, `SEM_VINCULO_IPV4`, `sharedPolicyGuard` e `approvedFamilyPairs` **continuam presentes**.

### 5.2 Evidencia comportamental

| Cenario                                                    | Esperado (RC13)                                                      | Resultado                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| ACTIVATE manual **IPv4** com execucao automatica DESLIGADA | nao bloqueado pelo kill switch; chega ao preflight READ-ONLY real    | ✅ `REVALIDATION_FAILED` ("Sem par de nodes planejado"), 0 escritas |
| ACTIVATE manual **IPv6** nas mesmas condicoes              | idem (nenhum gate de familia)                                        | ✅ idem                                                             |
| ACTIVATE de origem **AUTO** (IPv4 e IPv6)                  | `AUTO_EXECUTION_DISABLED`, zero escrita                              | ✅                                                                  |
| AUTO **IPv6** sem irmao IPv4 aprovado                      | `BLOCKED / FAMILY_CONTENTION_UNRESOLVED` (nao `FAMILY_OUT_OF_PHASE`) | ✅                                                                  |
| AUTO **IPv4** do mesmo par                                 | segue o fluxo normal, sem gate de familia                            | ✅                                                                  |

Alem disso, **todos** os testes de caminho manual da RC13 passam sem alteracao de assercao: `mitigation-live-write`, `mitigation-scope-confirmation`, `mitigation-shared-remove-confirmation`, `mitigation-manual-concurrency`, `mitigation-exclusion`, `mitigation-peer-exclusion`, `mitigation-shared-policy`, `mitigation-node-pair`, `ne8000-observed-readback`, `mitigation-telemetry*`.

---

## 6. Integracao FAST com telemetria real

`mitigation-detection-alert.test.ts` usa `__fixtures__/flash-3066-tx-real-samples.json` — 24 amostras **reais** de `txBps` do equipamento (391–673 Mbps) contra um gatilho de 8.58 Gbps:

- 24 amostras abaixo do gatilho **nao** produzem alerta (nenhum episodio aberto);
- quando as amostras estao acima do gatilho e a escrita esta bloqueada, o episodio abre, o payload e montado com `trafficMbps`/`thresholdMbps` **medidos** e a entrega so confirma com `delivered === true`;
- falha de transporte agenda retry com o **mesmo** `episodeId`.

Nenhum contador, threshold ou estado `MITIGATED`/`verified` foi fabricado.

---

## 7. Contrato API → n8n (RC7.1.1)

| Item                          | Valor                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evento                        | `MITIGATION_DETECTION_BLOCKED`                                                                                                                                            |
| `simulation`                  | `true` (obrigatorio: e deteccao, nao mitigacao aplicada)                                                                                                                  |
| `verified`                    | `false`                                                                                                                                                                   |
| Campos                        | `episodeId`, `blockedReason`, `direction`, `directionSource`, `fieldsUnavailable[]`, `trafficMbps`, `thresholdMbps`, `policy`, `interfaceName`, `peer`, `affectedPeers[]` |
| Header                        | `X-NetVision-Token` (Header Auth nativo)                                                                                                                                  |
| Confirmacao de entrega        | HTTP 2xx **e** `{"routed":true,"delivered":true,...}`                                                                                                                     |
| Botoes de retirada            | **nenhum** (o aviso de deteccao nao tem `replyMarkup`)                                                                                                                    |
| HTTP 401/403                  | falha de transporte → retry (nunca "entregue")                                                                                                                            |
| HTTP 200 sem `delivered:true` | falha de transporte → retry                                                                                                                                               |

`mitigation-workflow-rc71.test.ts` valida o workflow publicado: 4 credenciais Header Auth independentes, zero `$env`, zero token literal, `MITIGATION_VERIFIED` preservado com botoes, `MITIGATION_DETECTION_BLOCKED` roteado para o no de aviso sem escrita, `MITIGATION_TEST`/desconhecido com `routed:false`, `RESPOND` alcancavel no webhook de mitigacao e `lastNode` nos tres alarmes.

### 7.1 Semantica de entrega (nao prometer o que nao existe)

A entrega e **at-least-once**. O timeout do sender e 10 s: se o n8n entregar ao Telegram mas o ACK se perder, a proxima tentativa pode duplicar a notificacao. **Nao existe deduplicacao persistente nem `exactly-once`.** A RC14-F nao declara exactly-once em nenhum ponto.

---

## 8. Configuracao (ENV) e pisos

| ENV                                              | Default      | Piso / validacao                                                |
| ------------------------------------------------ | ------------ | --------------------------------------------------------------- |
| `MITIGATION_AUTO_EXECUTION_ENABLED`              | desligado    | `1/true/yes/on`; lido no boot                                   |
| `MITIGATION_AUTO_DETECTION_EPISODE_IDLE_SECONDS` | 120 s        | >= 60 s                                                         |
| `MITIGATION_AUTO_DETECTION_REPEAT_SECONDS`       | sem lembrete | >= 300 s (valor valido **nao** e anulado pelo intervalo minimo) |
| `MITIGATION_AUTO_DETECTION_INTERVAL_SECONDS`     | 1800 s       | >= 60 s                                                         |
| `MITIGATION_AUTO_DETECTION_MAX_ATTEMPTS`         | 5            | >= 1                                                            |

Valores fora da faixa sao **rejeitados com WARN explicito** (`app.log.warn`) e o default e usado — nunca aceitos silenciosamente.

---

## 9. Plano de publicacao API-only (NAO EXECUTADO)

Pre-condicoes: autorizacao explicita, janela combinada, RC13 atual confirmada (`rc13-d6c07f2`), backup do drop-in atual.

```bash
# 1) build reprodutivel (no host, a partir do worktree/branch entregue)
cd /home/guilherme/fast-auto-ipv4-rc14f
npm ci --workspaces --include=dev
npm run db:generate -w @gmj/api      # prisma generate (sem migrate)
npm run build -w @gmj/api            # tsup -> dist/server.cjs

# 2) publicar release ao lado (nada e sobrescrito)
REL=rc14f-<sha-curto>
sudo mkdir -p /opt/netvision-fast-bridge/releases/$REL
sudo cp -a apps/api/dist /opt/netvision-fast-bridge/releases/$REL/dist
sudo cp -a apps/api/package.json /opt/netvision-fast-bridge/releases/$REL/package.json

# 3) espelhar EXATAMENTE o drop-in da RC13, trocando apenas o caminho
sudo cp /etc/systemd/system/netvision-api.service.d/zzzzzzzzzzzzzzzzzzzz-rc13-d6c07f2.conf \
        /etc/systemd/system/netvision-api.service.d/zzzzzzzzzzzzzzzzzzzz-rc14f-<sha>.conf
sudo sed -i 's#rc13-d6c07f2#'"$REL"'#g' \
        /etc/systemd/system/netvision-api.service.d/zzzzzzzzzzzzzzzzzzzz-rc14f-<sha>.conf
sudo systemctl daemon-reload

# 4) restart controlado (unico passo com impacto)
sudo systemctl restart netvision-api
sleep 5
systemctl is-active netvision-api
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3333/health
journalctl -u netvision-api -n 50 --no-pager | grep -Ei 'kill switch|execution|erro|error' || true
```

**Sem migration.** A RC14-F nao altera schema Prisma: as colunas usadas pelo motor ja existem desde a RC13 (`recoveryCounter`, `lastSampleAt`, `currentTrafficBps`).

Observabilidade pos-publicacao (READ-ONLY):

```bash
# a flag continua desligada?
systemctl show netvision-api -p Environment | tr ' ' '\n' | grep MITIGATION_AUTO_EXECUTION_ENABLED
# decisoes do motor com o motivo do kill switch aparecem como WOULD_ACTIVATE
sudo journalctl -u netvision-api -n 200 --no-pager | grep -i AUTO_EXECUTION_DISABLED || true
# zero ACTIVATE/REMOVE automatico
sudo journalctl -u netvision-api --since '15 min ago' --no-pager | grep -Ei 'auto-activate|REMOVE' || true
```

---

## 10. GO / NO-GO

**GO — condicionado**, para publicacao **API-only** da RC14-F, mediante autorizacao explicita:

- suíte completa da API verde (§11), typecheck/lint/diff-check/build limpos;
- kill switch fechado nos 5 pontos de barreira com matriz de 16 casos;
- operacao manual da RC13 preservada e provada (IPv4 **e** IPv6);
- N1–N4 comprovadamente ausentes;
- produtor de deteccao independente de mitigacao, com dedupe por episodio e entrega confirmada.

**Condicoes que permanecem:**

1. `MITIGATION_AUTO_EXECUTION_ENABLED` deve continuar **desligado** na publicacao (o alerta nao exige AUTO ligado).
2. A homologacao **dinamica** do n8n continua pendente: este ambiente **nao tem Docker nem n8n**. A validacao e estatica (JSON + contrato), conforme exigido.
3. **RC6-A4 permanece ABERTO**: o rate limit de alertas e por processo em memoria. Dez reinicios geram ate dez notificacoes. Nao existe rate limit global entre reinicializacoes — e a RC14-F **nao** afirma o contrario.
4. Entrega e at-least-once (sem deduplicacao persistente).
5. O evento `MITIGATION_STATUS_RESEND` continua **sem produtor** na API (nao foi criado nesta missao).

**NO-GO** para: habilitar AUTO, habilitar escrita automatica, considerar o fluxo FAST homologado em producao sem trafego real, ou usar esta release como substituta da RC14 para os itens N1–N4.

---

## 11. Testes executados (todos no worktree isolado)

| Comando                           | Resultado                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `npx tsc --noEmit`                | **0 erros**                                                                     |
| `npx eslint . --max-warnings=0`   | **0 erros, 0 warnings**                                                         |
| `git diff --check`                | **limpo**                                                                       |
| `npx tsup` (build)                | **sucesso** (`server.cjs` 1.96 MB, observer 669.98 KB)                          |
| `npx vitest run` (suite completa) | **175 arquivos passed / 4 skipped; 2452 testes passed / 23 skipped / 0 failed** |

Suites novas: M8 write matrix (16), detection alert (9), parity RC13 (11), workflow RC7.1 (25).

Referencia: a RC14 tinha 2604 testes. A diferenca de ~150 testes corresponde exatamente as suites das mudancas N1–N4 que **nao** pertencem a esta release.

---

## 12. Rollback para RC13 — ROTEIRO ORIGINAL REJEITADO PELA AUDITORIA

A auditoria Codex comprovou comportamentalmente que `MITIGATION_AUTO_EXECUTION_ENABLED=0`
**não** bloqueia todos os perfis AUTO manuais na RC13 efetiva. O procedimento
anterior que dependia apenas dessa flag foi removido por ser inseguro.

Usar exclusivamente o [plano corrigido de deploy/rollback](docs/RC14F_CODEX_DEPLOY_ROLLBACK.md),
com `MITIGATION_MODE=SIMULATION_ONLY` e `MITIGATION_LIVE_WRITE_ENABLED=false`,
HUAWEI/allowlist preservados e EnvironmentFile de guardas com precedência final.
Isso bloqueia temporariamente ACTIVATE e REMOVE manuais reais e nunca retira uma
mitigação física automaticamente. Nenhum rollback foi executado.

---

## 13. Limitacoes e pendencias

1. **Homologacao dinamica do n8n**: pendente (sem Docker/n8n no ambiente). Validacao estatica + contrato apenas.
2. **Trafego real**: a deteccao operacional so se comprova com ataque real (ou telemetria real acima do gatilho). A fixture usada e real, mas abaixo do gatilho.
3. **RC6-A4**: rate limit por processo, sem persistencia entre reinicios.
4. **At-least-once**: sem `exactly-once`; perda de ACK pode duplicar a notificacao.
5. **`MITIGATION_STATUS_RESEND`**: continua sem produtor.
6. **AAA/VSI**: nao tocados nesta missao.

---

## 14. Roteiro para auditoria independente

1. `git log --oneline d6c07f2..HEAD` no worktree/branch entregue — confirmar que a base e a RC13.
2. `git diff d6c07f2..HEAD -- apps/api/src` — ler apenas os 8 arquivos de §2.1.
3. `npx vitest run src/infrastructure/bgp/mitigation/mitigation-m8-write-matrix.test.ts` — 16/16.
4. `npx vitest run src/infrastructure/bgp/mitigation/mitigation-rc14f-parity.test.ts` — 11/11 (prova de ausencia de N1–N4).
5. `npx vitest run src/application/mitigation-detection-alert.test.ts` — 9/9 (24 amostras reais).
6. `npx vitest run src/infrastructure/bgp/mitigation/mitigation-workflow-rc71.test.ts` — 25/25.
7. Comparar com a RC14: `git diff --stat 4ff951a..HEAD` deve mostrar que todos os arquivos de N1–N4 **nao** existem aqui.
8. Confirmar no host: `systemctl show netvision-api -p Environment | grep AUTO_EXECUTION` e `select count(*) from mitigation_events where action in ('ACTIVATE','REMOVE')` inalterados.

---

**Nada foi publicado, reiniciado, migrado, escrito em Huawei, alterado em VNT/Fibinet/Zabbix, nem enviado a producao. AUTO permanece desligado.**
