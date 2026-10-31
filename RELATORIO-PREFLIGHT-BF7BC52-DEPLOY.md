# PREFLIGHT — deploy da API `bf7bc52` (contrato `prefixes`) no IMPLANTAR

**31/10/2026 22:57–23:00 UTC · branch `feature/aglink-computize-prefixes` · HEAD `1f60aa5`**
**Executado: apenas leitura + staging em `/home/guilherme`. Nenhum serviço reiniciado, nenhuma release
instalada, nenhum drop-in criado, nenhuma migration, nenhum ACTIVATE/REMOVE, nenhum Telegram, n8n intocado.**

> **GATE ATIVO:** a publicação exige autorização explícita. Nada abaixo foi aplicado.

---

## 1. Estado da API em produção (medido agora)

Fonte: `docs/evidence/preflight-bf7bc52-20261031-before.json` (sha256 `29748db1…06c1`),
gerado por `deploy/aglink-prefixes-bf7bc52/readonly-state.py` (READ-ONLY, DB com
`default_transaction_read_only=on`).

| Item                                    | Valor                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `netvision-api`                         | `active`, PID **3440280**, `NRestarts=0`, desde 30/10 19:25:17 UTC                                     |
| Release ativa                           | `/opt/netvision-auto-activate/releases/463769620a2f39f9803b60a43314851fe3a77e0e`                       |
| `SOURCE_SHA`                            | `463769620a2f39f9803b60a43314851fe3a77e0e`                                                             |
| `dist/server.cjs`                       | **`5937a56815a08837de73d9b56e2fc1c9f44ab9b98ba86822f19e6e6e0352d08d`**                                 |
| `dist/catalog/physical-catalog-v1.yaml` | `2a255fc270755c3511637b5763b859335ad1f574929625f461e01f674b143d64`                                     |
| Drop-ins da unit                        | **24**; último = `zzzzzzzzzzzzzzzzzzzzzz-single-pilot-4637696-auto0.conf`                              |
| EnvironmentFiles                        | 13 entradas (7 delas `api-rc7.env`); **nenhuma muda**                                                  |
| `netvision-mcp`                         | `active`, PID 3440281, cwd `/opt/netvision-mcp/releases/mcp-5874fe0`, `Requires=netvision-api.service` |
| `netvision-web`                         | `active`, PID **2976909** (inalterado desde 26/10 21:10)                                               |
| `netvision-fast-observer`               | `active`, PID 2594846                                                                                  |
| Health                                  | api **200** `{"status":"ok","demoMode":false,"snmpPolling":true}` · web **200** · mcp **200**          |
| Migrations aplicadas                    | **43**, pendentes **0**, última `20261029090000_auto_lifecycle_durable`                                |
| Perfis / registros duráveis             | **39** / **0**                                                                                         |
| Disco livre em `/`                      | 5,4 GB após staging (5,86 GB antes)                                                                    |

### Flags efetivas (lidas de `/proc/3440280/environ`)

| Flag                                            | Valor             | Exigência    |
| ----------------------------------------------- | ----------------- | ------------ |
| `MITIGATION_AUTO_PERSISTENCE_ENABLED`           | **`1`**           | preservar ✅ |
| `MITIGATION_AUTO_EXECUTION_ENABLED`             | **`0`**           | preservar ✅ |
| `MITIGATION_AUTO_LIFECYCLE_ENABLED`             | **`0`**           | preservar ✅ |
| `MITIGATION_AUTO_REMOVE_ENABLED`                | **`0`**           | preservar ✅ |
| `MITIGATION_AUTO_EXECUTION_ALLOWED_PROFILE_IDS` | _(vazia)_         | preservar ✅ |
| `MITIGATION_AUTO_MAX_ACTIVE`                    | `1`               | preservar    |
| `MITIGATION_MODE` / `MITIGATION_EXECUTOR`       | `AUTO` / `HUAWEI` | preservar    |
| `MITIGATION_LIVE_WRITE_ENABLED`                 | **`true`**        | ⚠️ ver §6    |

## 2. Escopo AGLINK pronto para o campo novo (READ-ONLY, DB)

| Verificação   | Resultado                                                                            |
| ------------- | ------------------------------------------------------------------------------------ |
| Perfil        | `cmuoavm4e00bysslhqd0h3q7u` · `PL-AGLINK_IPv4-IN` · IPV4 · enabled · RT `268568:660` |
| Device        | `host-377c554a-8d1e-47c4-baa4-f258693b4d91` = `BHE-VTA-F1A-BGP-01`                   |
| Peer primário | `10.200.201.2` (`primary=t`) → `primaryPeer` resolve, o leitor **será** chamado      |
| SSH do device | `sshEnabled=t`, host/usuário/credencial presentes ✅                                 |

Sem isso o campo cairia em `indisponível`. Está pronto: a leitura de rotas recebidas
funcionará quando houver um ACTIVATE real autorizado.

## 3. Validação dos hashes

| Artefato                                            | Esperado          | Medido                         | Resultado |
| --------------------------------------------------- | ----------------- | ------------------------------ | --------- |
| Pacote `netvision-single-pilot-api-bf7bc52….tar.gz` | `585ed6ef…ca5e7d` | idêntico (local **e** no host) | ✅        |
| `artifact-manifest.json`                            | `e2c50570…bfacf`  | idêntico (local **e** no host) | ✅        |
| `SOURCE_SHA` dentro do pacote                       | `bf7bc527…4f59`   | idêntico                       | ✅        |
| `dist/server.cjs` no pacote                         | `09b12192…f634`   | idêntico                       | ✅        |
| `dist/catalog/physical-catalog-v1.yaml`             | `2a255fc2…3d64`   | idêntico **ao de produção**    | ✅        |
| 10.070 arquivos do manifesto                        | byte a byte       | **0 divergências**             | ✅        |
| Migrations do pacote × produção                     | idênticas         | `diff` vazio                   | ✅        |
| `SOURCE_SHA` de produção                            | `4637696…`        | idêntico                       | ✅        |

Cadeia de commits: `4637696` **é ancestral** de `bf7bc52` (`git merge-base --is-ancestor`);
`apps/api/prisma` **sem delta** entre eles (nenhuma migration).

Delta de runtime `4637696 → bf7bc52`: **6 arquivos** —
`huawei-bgp-ssh.ts` (+`readReceivedRoutes`), `mitigation-command-service.ts`,
`mitigation-scope-prefixes.ts` (novo), `mitigation-webhook.ts`,
`notification-publisher.ts`, `routes.ts`. Motor FAST e executor de escrita: **sem delta**.

Bundle publicado contém o contrato: `selectMitigationScopePrefixes`,
`… received\``, `scopePrefixesLocalAs`, `fieldsUnavailable`, `prefixes` → todos presentes.

## 4. Resultado do preflight

| #   | Checagem                                                           | Resultado                                                 |
| --- | ------------------------------------------------------------------ | --------------------------------------------------------- |
| 1   | Pacote disponível e íntegro (local + host)                         | ✅                                                        |
| 2   | Manifesto confere 10.070/10.070                                    | ✅                                                        |
| 3   | Migrations idênticas → **instalação não aplica migration**         | ✅                                                        |
| 4   | Release `bf7bc52` **não** existe em `/opt/…/releases`              | ✅ (só `4637696`, `e78638a`)                              |
| 5   | Pré-condição do `activate-api.sh` (último drop-in)                 | ✅                                                        |
| 6   | Blast radius do restart: **somente `netvision-mcp`** (`Requires=`) | ✅ WEB/Observer intocados                                 |
| 7   | Health atual 200 nos três endpoints                                | ✅                                                        |
| 8   | Flags AUTO=0 / persistence=1 / allowlist vazia                     | ✅                                                        |
| 9   | Rollback: bundle `5937a568…` presente na release antiga            | ✅                                                        |
| 10  | Espaço para extrair ~300 MB                                        | ✅ 5,4 GB livres                                          |
| 11  | Suíte de testes no HEAD                                            | ✅ **2698 passed / 39 skipped / 0 failed** (193 arquivos) |
| 12  | `tsc` / `eslint --max-warnings=0` / `git diff --check`             | ✅ 0 / 0 / limpo                                          |
| 13  | n8n: candidato `85e8b071…` = manifesto; 17 testes do workflow      | ✅                                                        |

## 5. Plano de deploy (não executado)

### Etapa A — instalar release inativa (sem restart)

```bash
sudo bash install-release.sh /home/guilherme/staging-bf7bc52
```

Verifica SHA256 de pacote + manifesto, `SOURCE_SHA`, os 10.070 arquivos e as migrations;
extrai em `/opt/netvision-auto-activate/releases/bf7bc527a9…` **inativa**. Não toca em
systemd, banco, WEB, MCP nem Observer.

### Etapa B — ativar (restart API + MCP)

```bash
sudo bash activate-api.sh
```

Cria **um** drop-in novo `zzzzzzzzzzzzzzzzzzzzzzz-prefixes-bf7bc52.conf` (só
`WorkingDirectory`/`ExecStart`), `daemon-reload`, `restart netvision-api`
→ MCP reinicia junto. Nenhuma flag, EnvironmentFile ou migration muda.

### Etapa C — pós-checagem

```bash
sudo python3 -I readonly-state.py > after.json
python3 -I postcheck-compare.py before.json after.json api=bf7bc52     # 19 invariantes
python3 - '<restart UTC>' < api-logs-contract-check.py                  # contrato + erros
```

Aceito apenas o erro conhecido `CATALOG_BOOTSTRAP` (o mesmo da `4637696`):
0 fatais, contrato `prefixes` presente, **0** linhas de comando de mitigação.
Depois: observar 5 min (PIDs estáveis, `NRestarts=0`).

### Rollback

```bash
sudo bash rollback-api.sh        # remove só o drop-in novo, confere 5937a568…, restart
python3 -I postcheck-compare.py before.json after.json api=4637696
```

Release `bf7bc52` fica no disco, inativa. `prefixes` é aditivo: o n8n candidato
mostra `indisponível` se a API voltar.

## 6. Riscos declarados

1. **`MITIGATION_LIVE_WRITE_ENABLED=true`** e `MITIGATION_MODE=AUTO`. Quem impede escrita
   automática é o kill switch (`AUTO_EXECUTION_ENABLED=0`). Ele **não muda** neste deploy e o
   postcheck falha se mudar. Comando manual continua possível — nada neste deploy o dispara.
2. **Restart do `netvision-mcp`** é inevitável (`Requires=`). O postcheck exige MCP `active`,
   `NRestarts=0` e cwd inalterado.
3. `netvision-api` reinicia: ~segundos de indisponibilidade na API/WEB (WEB consome a API).
4. O campo `prefixes` só aparece em `MITIGATION_VERIFIED` real; nenhum dado sintético é gerado.
5. Sem migration, o rollback é puramente de binário.

## 7. Pendências para autorização

| #   | Autorização necessária                                           | Estado               |
| --- | ---------------------------------------------------------------- | -------------------- |
| A   | Executar `install-release.sh` (instala release inativa)          | ⏸️ aguardando        |
| B   | Executar `activate-api.sh` (**restart API/MCP**)                 | ⏸️ aguardando        |
| C   | Gate n8n: host `179.189.80.25` — **não autorizado** nesta missão | ⏸️ aguardando        |
| D   | Publicação n8n (PATCH + activate)                                | ⏸️ aguardando gate C |
| E   | Qualquer ACTIVATE/REMOVE Huawei                                  | ⏸️ fora de escopo    |
| F   | `deny node 5` na SEMPRE-DDoS                                     | ⏸️ fora de escopo    |

### Sobre o n8n (etapas 8–10)

O candidato está pronto e reconciliado com a versão **efetivamente ativa** (não com o RC7.1):
58 nós / 59 arestas, delta **único** em `Normalizar Evento OUT.parameters.jsonOutput`,
6 referências de credencial preservadas, hash do grafo `5c76e866…` e prova de que
"candidato − delta = `60af8761…`" (hash publicado). O gate de leitura
(`n8n-readonly-reconcile.py`) precisa rodar **no host do n8n** com Docker — acesso não
autorizado até aqui. **Nada foi alterado no n8n.**

## 8. Evidências para auditoria posterior (Claude)

- `docs/evidence/preflight-bf7bc52-20261031-before.json` — retrato READ-ONLY do estado.
- `docs/evidence/api-package-bf7bc52-artifact-manifest.json` — 10.070 arquivos + metadados do builder.
- `docs/n8n/RC7.1.2-PREFIXOS-MANIFEST.json`, `…-NORMALIZER.diff`, `…-PREFIXOS.json`.
- `deploy/aglink-prefixes-bf7bc52/` — scripts A/B/rollback/postcheck/gate n8n.
- Staging no host: `/home/guilherme/staging-bf7bc52/` (pacote + manifesto, hashes conferidos).
- Kit no host: `/home/guilherme/aglink-prefixes-deploy/` (scripts, sintaxe validada).

**Parado no gate. Nenhuma alteração produtiva foi feita.**
