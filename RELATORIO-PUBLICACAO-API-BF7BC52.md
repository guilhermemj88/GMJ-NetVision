# PUBLICAÇÃO — API `bf7bc52` (contrato `prefixes`) no IMPLANTAR

**31/10/2026 23:11:58–23:17:29 UTC · branch `feature/aglink-computize-prefixes`**
**Executado com autorização explícita do operador (Etapas A + B + observação de 5 min).**

> Resultado: **API publicada e estável**. AUTO EXECUTION/LIFECYCLE/REMOVE = 0, persistência = 1,
> allowlist vazia, `LIVE_WRITE` preservado. Nenhuma alteração em Huawei, n8n, Telegram, migrations,
> WEB, Observer ou catálogo físico.

---

## 1. Resultado

| Item                                    | Valor final                                                                               |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Release ativa                           | `/opt/netvision-auto-activate/releases/bf7bc527a94681b2f40e5d0d9f4b6daa329b4f59/apps/api` |
| `SOURCE_SHA`                            | `bf7bc527a94681b2f40e5d0d9f4b6daa329b4f59`                                                |
| `dist/server.cjs`                       | `09b12192d7ff1ba5ad625b823b2d4d8d1d4caacf8d906d4ca6819ddfaa0df634`                        |
| `dist/server.cjs.map`                   | `110ced01414c1a5d7ffdcf2467716502a2009da1ad9fd0cd40a0237a970f3bcd`                        |
| `dist/catalog/physical-catalog-v1.yaml` | `2a255fc270755c3511637b5763b859335ad1f574929625f461e01f674b143d64` (**inalterado**)       |
| `netvision-api`                         | `active` · PID **3460475** · `NRestarts=0` · desde 23:12:00 UTC                           |
| `netvision-mcp`                         | `active` · PID **3460477** · `NRestarts=0` · release inalterada (`mcp-5874fe0`)           |
| `netvision-web`                         | `active` · PID **2976909** · **inalterado** desde 26/10 21:10                             |
| `netvision-fast-observer`               | `active` · PID **2594846** · **inalterado**                                               |
| Drop-ins da unit                        | **25** (24 + `zzzzzzzzzzzzzzzzzzzzzzz-prefixes-bf7bc52.conf`)                             |
| Health                                  | api **200** · web **200** · mcp **200**                                                   |
| Migrations                              | **43** aplicadas · **0** pendentes · última `20261029090000_auto_lifecycle_durable`       |
| Perfis / registros duráveis             | **39** / **0**                                                                            |
| Disco livre                             | 5,1 GB                                                                                    |

### Flags (idênticas antes e depois — exigência do operador)

| Flag                                            | Antes             | Depois                                        |
| ----------------------------------------------- | ----------------- | --------------------------------------------- |
| `MITIGATION_AUTO_PERSISTENCE_ENABLED`           | `1`               | **`1`** ✅                                    |
| `MITIGATION_AUTO_EXECUTION_ENABLED`             | `0`               | **`0`** ✅                                    |
| `MITIGATION_AUTO_LIFECYCLE_ENABLED`             | `0`               | **`0`** ✅                                    |
| `MITIGATION_AUTO_REMOVE_ENABLED`                | `0`               | **`0`** ✅                                    |
| `MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS` | _(vazia)_         | **vazia** ✅                                  |
| `MITIGATION_LIVE_WRITE_ENABLED`                 | `true`            | **`true`** ✅ (preservado p/ operação manual) |
| `MITIGATION_AUTO_MAX_ACTIVE`                    | `1`               | `1` ✅                                        |
| `MITIGATION_MODE` / `MITIGATION_EXECUTOR`       | `AUTO` / `HUAWEI` | iguais ✅                                     |

## 2. Etapas executadas

### Gate pré-A (leitura)

Pacote e manifesto revalidados por SHA256 no host; `DEST` inexistente; bundle de produção
`5937a568…` confirmado.

### Etapa A — `install-release.sh` (sem restart)

```
…tar.gz: OK
artifact-manifest.json: OK
manifesto OK: 10070 arquivos
migrations identicas a 4637696
INSTALADA (inativa): /opt/netvision-auto-activate/releases/bf7bc527a9…
```

### Gate pré-restart (exigência explícita: hashes e rollback antes do restart)

| Checagem                                  | Resultado                                          |
| ----------------------------------------- | -------------------------------------------------- |
| Flags efetivas conforme autorizado        | ✅ (`1/0/0/0`, allowlist vazia, `LIVE_WRITE=true`) |
| `SOURCE_SHA` da release nova              | `bf7bc527…4f59` ✅                                 |
| `server.cjs` da release nova              | `09b12192…f634` ✅                                 |
| `server.cjs` da release antiga (rollback) | `5937a568…d08d` ✅                                 |
| API ainda na release antiga               | ✅ (nada havia mudado)                             |
| Migrations na release nova                | 44 entradas (43 + lock) ✅                         |
| Drop-in novo ausente                      | ✅                                                 |

Nenhuma divergência → restart autorizado.

### Etapa B — `activate-api.sh`

```
{"status":"ok","demoMode":false,"snmpPolling":true}
active
active
```

Um único drop-in novo, `daemon-reload`, `restart netvision-api`; `netvision-mcp` reiniciou
junto por `Requires=`.

### Etapa C — pós-checagem

**19/19 invariantes PASS:**

```
PASS API release                      PASS netvision-web PID/cwd inalterados
PASS API bundle sha256                PASS netvision-fast-observer PID/cwd inalterados
PASS API flags identicas              PASS MCP release inalterada
PASS AUTO execution/lifecycle/remove = 0   PASS health api 200
PASS persistencia = 1                 PASS health web 200
PASS allowlist AUTO vazia             PASS health mcp 200
PASS EnvironmentFiles identicas       PASS API demoMode=false
PASS netvision-api active/NRestarts=0 PASS migrations inalteradas
PASS netvision-mcp active/NRestarts=0 PASS migrations pendentes = 0
                                      PASS perfis = 39 e AGLINK igual
```

Journal desde 23:11:58Z:

| Métrica                        | Valor                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| Linhas de erro da API          | 1                                                                                      |
| Linhas de erro **inesperadas** | **0**                                                                                  |
| Erro conhecido                 | `CATALOG_BOOTSTRAP` (o mesmo da `4637696`; catálogo será corrigido depois)             |
| Fatais / unhandled             | **0**                                                                                  |
| Linhas de comando de mitigação | **0**                                                                                  |
| Erros do MCP                   | **0**                                                                                  |
| Contrato no bundle ativo       | `receivedRoutesCommand` ✔ `scopeSelector` ✔ `scopeLocalAsPort` ✔ `fieldsUnavailable` ✔ |

### Observação — 5 minutos (23:12:30 → 23:17:29 UTC)

| Verificação                | Resultado                                                      |
| -------------------------- | -------------------------------------------------------------- |
| `netvision-api`            | `active`, **PID 3460475 estável**, `NRestarts=0`, uptime 07:35 |
| `netvision-mcp`            | `active`, PID 3460477 estável, `NRestarts=0`                   |
| `netvision-web` / Observer | PIDs **inalterados**                                           |
| Health api/web/mcp         | 200 / 200 / 200                                                |
| Flags do processo novo     | `1/0/0/0`, allowlist vazia, `LIVE_WRITE=true`                  |
| Banco                      | 43 migrations, 0 pendentes, 39 perfis, 0 duráveis              |
| Memória do processo        | 16 threads, ~948 MB RSS                                        |

## 3. Rollback (preparado, NÃO executado)

```bash
sudo bash /home/guilherme/aglink-prefixes-deploy/rollback-api.sh
python3 -I postcheck-compare.py before.json after.json api=4637696
```

Remove **apenas** o drop-in novo, confere `5937a568…d08d`, reinicia e valida health.
A release `bf7bc52` permanece no disco, inativa. Como `prefixes` é aditivo, o n8n candidato
mostraria `indisponível` se a API voltar à `4637696`.

## 4. n8n — bloqueado por falta de credencial

O operador autorizou a leitura READ-ONLY no host `179.189.80.25`, mas:

| Verificação                               | Resultado                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Porta 22 alcançável daqui                 | sim                                                                                                          |
| Autenticação SSH com credencial conhecida | **rejeitada** (`Access denied`)                                                                              |
| Config/chaves para o host no IMPLANTAR    | **nenhuma** (`grep` sem referências; sem `~/.ssh/config`; porta 22 **não** alcançável a partir do IMPLANTAR) |

**Não houve tentativa de adivinhar credenciais.** O gate
(`n8n-readonly-reconcile.py`, somente leitura) está pronto e não foi executado.
Nada foi alterado no n8n.

**Para liberar:** informar usuário/chave (ou senha) do host do n8n. O gate compara
`activeVersionId` esperado `6a97fe4a…` e hash de grafo `60af8761…`, além do rascunho
`1f1405f8…`/`6bc74d79…`, e devolve `GO_CANDIDATE_APPLIES` ou `STOP_RECONCILE`.

## 5. Pendências

| #   | Item                                            | Estado                                |
| --- | ----------------------------------------------- | ------------------------------------- |
| 1   | Gate n8n (leitura)                              | ⏸️ **sem credencial do host**         |
| 2   | Publicação n8n RC7.1.2+prefixos                 | ⏸️ exige gate 1 + autorização própria |
| 3   | `deny node 5` na SEMPRE-DDoS                    | ⏸️ fora de escopo                     |
| 4   | Homologação física da COMPUTIZE (ACTIVATE real) | ⏸️ fora de escopo                     |
| 5   | Catálogo físico (`CATALOG_BOOTSTRAP`)           | ⏸️ correção posterior, como combinado |

## 6. Evidências

- `docs/evidence/preflight-bf7bc52-20261031-before.json` — retrato antes (`29748db1…`).
- `docs/evidence/postdeploy-bf7bc52-20261031-after.json` — retrato depois (`67d71c9e…`).
- `deploy/aglink-prefixes-bf7bc52/` — scripts A/B/rollback/postcheck/gate n8n.
- Kit e staging no host: `/home/guilherme/aglink-prefixes-deploy/`, `/home/guilherme/staging-bf7bc52/`.

**Publicação concluída. Nenhuma operação de mitigação foi executada. Parado para o gate do n8n.**
