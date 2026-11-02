# RELATORIO — PREPARACAO DO DEPLOY NA IMPLANTAR (SEM EXECUCAO)

Ambiente: `netvision-implantar` (45.163.144.8:2222) — **somente leitura**
Branch homologada (Windows): `feature/aglink-activate-safety`
Ultimo commit homologado: `934df6e` · commit funcional B6: `2ad62b8`
Data: 2026-11-02 09:57–10:15 (UTC-3) · reconhecimento em 2026-11-02 ~13:05 UTC

**Nada foi deployado, nenhuma migration rodada, nenhuma flag alterada, nenhum
servico reiniciado, nenhum comando Huawei, AUTO desligado.**

---

## 1. INVENTARIO DE PRODUCAO

### 1.1 Codigo efetivamente em execucao

| Item | Valor |
| --- | --- |
| WorkingDirectory da API | `/opt/netvision-auto-activate/releases/bf7bc527…/apps/api` |
| ExecStart | `/usr/bin/node …/apps/api/dist/server.cjs` (dist de 2026-10-31 21:23) |
| Identidade da release | `SOURCE_SHA` = `bf7bc527a94681b2f40e5d0d9f4b6daa329b4f59` |
| Release e repo git? | **nao** — copia imutavel de 319 MB |
| Drop-in que a ativa | `zzzzzzzzzzzzzzzzzzzzzzz-prefixes-bf7bc52.conf` (ultimo na ordem) |
| Web | `/opt/GMJ-NetVision-web-responsive/releases/f4b31fc3…/web` |
| MCP | `/opt/netvision-mcp/releases/mcp-5874fe0` |
| Checkout `/opt/GMJ-NetVision` | branch `main` @ `df3346d` — **nao e o que roda** |

### 1.2 Servicos e saude

| Servico | Estado | Desde | Health |
| --- | --- | --- | --- |
| netvision-api | **active** (PID 3460475) | 2026-10-31 23:12 UTC | `:3333/health` = **200** |
| netvision-web | **active** (PID 2976909) | 2026-10-26 21:10 UTC | `:80` = **200** |
| netvision-mcp | **active** (PID 3460477) | 2026-10-31 23:12 UTC | `:3335/health` = **200** |
| postgresql@18-main | **active** | — | — |

### 1.3 Versoes e recursos

| Item | Producao | Laboratorio homologado | Compatível |
| --- | --- | --- | --- |
| Node | v24.19.0 | v24.19.0 | ✅ |
| npm | 11.17.0 | 11.17.0 | ✅ |
| Prisma (CLI/@client) | 6.19.3 | 6.19.3 | ✅ |
| PostgreSQL | **18.6** | **18.6** | ✅ |
| Disco `/` | 58 G usados · **9,9 G livres** (86%) | — | ✅ (release ≈ 319 MB) |
| RAM | **7 GB total · 4 GB disponiveis** | 32 GB | ⚠️ limitado |

### 1.4 Flags de mitigacao — **EFETIVAS** (lidas de `/proc/<pid>/environ`)

| Flag | Valor atual |
| --- | --- |
| `NETVISION_INSTALLATION_ID` | **IMPLANTAR** |
| `MITIGATION_AUTO_PERSISTENCE_ENABLED` | **1** |
| `MITIGATION_AUTO_LIFECYCLE_ENABLED` | **0** |
| `MITIGATION_AUTO_EXECUTION_ENABLED` | **0** |
| `MITIGATION_MODE` | AUTO (avaliacao) |
| `MITIGATION_EXECUTOR` | HUAWEI |
| `MITIGATION_LIVE_WRITE_ENABLED` | true |
| `MITIGATION_ALLOWED_DEVICE_IDS` | `host-377c554a…` (F1A) |
| `MITIGATION_FAST_BRIDGE_MODE` | SHADOW · `FAST_BRIDGE_WRITES_ENABLED=false` · `FAST_POLL_MODE=OFF` |

### 1.5 Schema e tabela do baseline

| Item | Valor |
| --- | --- |
| Migrations aplicadas no banco | **43** — ultima `20261029090000_auto_lifecycle_durable` |
| Migrations no branch homologado | **43** (mesma ultima) |
| Migrations no checkout antigo `/opt/GMJ-NetVision` | 30 (defasado — irrelevante para a release) |
| Tabela `MitigationAutomationRecord` | **existe** (`id/kind/status/payload jsonb/createdAt/updatedAt`) |
| Linhas hoje | **0** |

### 1.6 Estado das mitigacoes (0 risco de escrita acidental)

| Item | Valor |
| --- | --- |
| Profiles | 39 habilitados (27 ALERT_ONLY · 12 AUTO) |
| Runtime | **38 NORMAL · 1 DISABLED** — **nenhum MITIGATED/ativo** |
| Eventos de mitigacao (7 dias) | **0** |
| Par planejado no runtime | 39 perfis tem plano (1/2) |

Nao existe mitigacao ativa: nao ha par 1/2 instalado em nenhuma policy.

### 1.7 Deploy e rollback usados hoje

- **Padrao:** release imutavel em `/opt/netvision-auto-activate/releases/<sha>` +
  drop-in de systemd sobrescrevendo `WorkingDirectory`/`ExecStart`
  (o drop-in atual declara explicitamente “Rollback: remover este arquivo”).
- **Empacotamento:** `scripts/single-pilot-package/build.ps1` → `git archive`,
  build em container Linux fixo (imagem `sha256:622f209f…`), `package.sha256` +
  `artifact-manifest.json` com hash de cada arquivo.
- **Instalacao:** `deploy/aglink-prefixes-bf7bc52/install-release.sh` — valida
  SHA do pacote/manifesto/arquivos, exige **migrations identicas** a release
  atual, instala ao lado (nao toca systemd/banco/WEB/MCP/Observer).
- **Alternativa in-place:** `deploy/update.sh` (git pull --ff-only + npm install +
  build + `prisma migrate deploy`) — **nao usar**: exige arvore git limpa e o
  `/opt/GMJ-NetVision` tem 12+ arquivos modificados.
- **Backups:** `/opt/netvision-backups/…operational.dump` (21/10, 1,94 G, com
  `SHA256SUMS`) · `/opt/backups/netvision-pre-*` (metadados de rollback).

---

## 2. PERSISTENCIA B6 — pre-requisito **JA SATISFEITO**

> Correcao de premissa: em missao anterior registrei que
> `MITIGATION_AUTO_PERSISTENCE_ENABLED` estava ausente. Isso foi um falso
> negativo (eu havia olhado apenas `.env` e drop-ins). O env **efetivo** do
> processo tem `MITIGATION_AUTO_PERSISTENCE_ENABLED=1`, vindo dos
> `EnvironmentFiles` `/etc/netvision/auto-activate-e78638a-stage0.env` e
> `/etc/netvision/single-pilot-4637696-auto0.env`, junto com
> `NETVISION_INSTALLATION_ID=IMPLANTAR`.

Consequencia para o B6: na proxima release,
`persistenceEnabled = (installation === 'IMPLANTAR' && PERSISTENCE_ENABLED === '1')`
avalia **true**, entao:

- `automationStore = new PrismaAutomationStore(prismaClient)` → existe;
- `new AutomationMitigationBaselineStore(automationStore)` → injetado no
  executor Huawei com **`durable: true`**;
- a tabela `MitigationAutomationRecord` ja existe com as 43 migrations → **nenhuma
  migration nova**.

**Nenhuma flag precisa ser alterada para o B6.** E habilitar persistencia **nao**
habilita execucao automatica: `MITIGATION_AUTO_EXECUTION_ENABLED=0` e
`MITIGATION_AUTO_LIFECYCLE_ENABLED=0` continuam sendo as travas.

### Efeitos colaterais ja vigentes da flag (importante para o plano)
`MITIGATION_AUTO_PERSISTENCE_ENABLED=1` tambem liga, desde ja:
- `DurableMitigationOutbox` (entrega de eventos com retry/lease);
- `requireAcknowledgement: true` no transporte n8n — a entrega exige ACK, e
  eventos sem ACK ficam `PENDING` e sao reentregues com o mesmo `eventId`.

Isso **nao muda com o deploy**; ja e o comportamento atual. So precisa constar
como criterio de validacao (2 integracoes de midia habilitadas).

---

## 3. COMPATIBILIDADE

### 3.1 Codigo homologado × producao

`bf7bc52` e **ancestral** de `934df6e` → o deploy e um fast-forward logico:

| Metrica | Valor |
| --- | --- |
| Commits a frente | **27** |
| Arquivos alterados (apps/api + apps/web) | 56 (+4.699 / −103) |
| `apps/web` alterado | **nao** |
| Migrations novas | **nenhuma** (43 = 43) |
| Arquivos de producao em `apps/api/src` tocados | 19 (mitigacao, SSH, routes) + 2 de `testing/` |

Superficie funcional alterada: par de nodes de mitigacao, derivacao de atributos,
inspetor fisico, write guard, transporte SSH (guardas de prompt/erro), registro
duravel do baseline, `routes.ts` (injecao do store).

### 3.2 Banco

- Schema **identico** (mesmas 43 migrations) → **sem migration, sem DDL**.
- `MitigationAutomationRecord` vazia → nao ha registro de baseline antigo para
  conflitar; o primeiro ACTIVATE real cria o registro.
- Registros de mitigacao existentes: 39 profiles / 38 runtime NORMAL, sem par
  ativo → as novas checagens (`baseline_record_store`, `preserved_attributes`,
  `policy_baseline_record`) **nao bloqueiam nada que ja funcione**: nenhuma
  mitigacao esta ativa para exigir registro previo.

### 3.3 API / Web / MCP / n8n

| Componente | Impacto |
| --- | --- |
| API | mesmo contrato HTTP; novos motivos de bloqueio no `safeError` (`MITIGATION_BASELINE_*`) e check extra no preflight |
| Web | **sem alteracao de codigo** (nada a recompilar no web) |
| MCP | nao depende do motor de mitigacao — sem alteracao |
| n8n | roda em **outro host** (nao ha 5678 aqui); consome webhooks. Sem mudanca de payload; a entrega com ACK ja e o comportamento atual |

### 3.4 Diferencas Windows × IMPLANTAR

| Item | Windows (homologado) | IMPLANTAR |
| --- | --- | --- |
| Node/Prisma/PG | 24.19 / 6.19.3 / **18.6** | 24.19 / 6.19.3 / **18.6** ✅ |
| Transporte SSH | simulado (VRP8 em arquivo) | **real** (ssh2) — guardas ja testados em unidade |
| Formato de read-back | config format (fixtures) | `display route-policy` real — validado por `ne8000-observed-readback.test.ts` |
| Persistencia | container descartavel | PostgreSQL de producao, `netvision` |
| RAM | 32 GB | **7 GB** (build nao roda aqui) |
| Docker | usado no lab | ausente/nao usado para build local |

### 3.5 O deploy NAO altera route-policies nem inicia mitigacao

- Publicar uma release troca apenas o binario servido pela API (drop-in).
- Nenhum codigo de mitigacao roda no boot: `AUTO_EXECUTION_ENABLED=0`,
  `AUTO_LIFECYCLE_ENABLED=0`, FAST em SHADOW/OFF.
- Nenhuma escrita no Huawei ocorre sem `ACTIVATE` explicito (manual) e preflight
  aprovado; confirmado no laboratorio (ETAPA 2 gerou comandos so porque chamamos
  `activate()` de propositio).

---

## 4. PLANO DE PUBLICACAO (nao executado)

### 4.1 Backup pre-deploy e prova de integridade

1. `pg_dump -Fc` da base `netvision` para
   `/root/netvision-backups/b6-<UTC>/netvision-operational.dump`
   (mesmo padrao do backup de 21/10), + `SHA256SUMS` + `dump-toc.txt`.
2. `sha256sum -c SHA256SUMS` e `pg_restore --list` para provar integridade.
3. Copia de `/etc/systemd/system/netvision-api.service.d/` e de
   `/opt/GMJ-NetVision/.env` para o mesmo diretorio (sem expor valores).
4. Registrar `SOURCE_SHA` atual e `systemctl show` da API.

### 4.2 Identificacao exata do codigo

- Fonte: `feature/aglink-activate-safety` @ **`2ad62b8`** (funcional) —
  `934df6e` inclui apenas o harness de laboratorio e relatorios.
- Tag/branch sugerida para o build: criar tag `b6-2ad62b8` para o pacote
  apontar para um SHA imutavel.

### 4.3 Build e publicacao

1. **Build na estacao Windows** (requer Docker ligado de novo):
   `scripts/single-pilot-package/build.ps1 -Output <dir novo>` — exige arvore
   limpa commitada; gera tar + `package.sha256` + `artifact-manifest.json`.
2. `pscp` do pacote para `/home/guilherme/staging-b6-2ad62b8/`.
3. No IMPLANTAR: `install-release.sh` adaptado para o novo SHA —
   valida hashes, exige **migrations identicas** (43 = 43), instala em
   `/opt/netvision-auto-activate/releases/2ad62b8…` **ao lado** da atual.
4. Criar drop-in `zzzzzzzzzzzzzzzzzzzzzzzz-b6-2ad62b8.conf`
   (ordem alfabetica posterior a atual) com `WorkingDirectory` e `ExecStart`
   apontando para a nova release.
5. `systemctl daemon-reload` + `restart netvision-api` **somente**.
   WEB, MCP, PostgreSQL e n8n **nao** sao tocados.

### 4.4 Janela e servicos impactados

- Janela sugerida: 10–15 min, fora de pico, com operador presente.
- Impacto: **apenas** `netvision-api` (restart de ~3 s; requests em voo falham).
- WEB e MCP seguem servindo; n8n pode receber erro de conexao momentaneo.

### 4.5 Validacoes de health

1. `systemctl is-active netvision-api` = active; `MainPID` novo.
2. `curl -fsS http://127.0.0.1:3333/health` = 200.
3. `curl -fsS http://127.0.0.1/` = 200 (web) e `:3335/health` = 200 (mcp).
4. `journalctl -u netvision-api -n 60` sem `AUTO_LIFECYCLE_REQUIRES_IMPLANTAR_PERSISTENCE`
   e sem crash-loop.
5. `systemctl show netvision-api -p ExecStart` aponta para a nova release.

### 4.6 Validacao de preflight **sem escrita**

Ja existe caminho read-only: `SIMULATE_ACTIVATE` executa o preflight real
(incluindo `baseline_record_store`, `preserved_attributes`, `node_occupancy`) e
**nao escreve** — `commandPreview` volta ao operador.

1. Chamar `SIMULATE_ACTIVATE` para um perfil do par AGLINK (ex.:
   `cmuoavm4e00bysslhqd0h3q7u`) e conferir `status: WOULD_ACTIVATE` +
   `preflight.ok: true` + `checks.baseline_record_store.ok: true`.
2. Conferir que `commandPreview` lista apenas os nodes 1 e 2 e termina em `commit`.
3. Confirmar que nada foi escrito: `git`/route-policy inalterados e
   `MitigationAutomationRecord` continua **0 linhas**.

### 4.7 Rollback da API

1. Remover (ou renomear) o drop-in novo
   `zzzzzzzzzzzzzzzzzzzzzzzz-b6-2ad62b8.conf`.
2. `systemctl daemon-reload` + `restart netvision-api` → volta para
   `bf7bc52` (release anterior permanece intacta no disco).
3. Banco: **nada a reverter** (sem migration). Se necessario,
   `pg_restore` do dump de 4.1 (procedimento completo, nao esperado).
4. Validar health novamente (4.5).

### 4.8 Criterios de ABORTAR a publicacao

- `install-release.sh` falhar em hash/manifesto ou acusar migrations divergentes;
- espaco livre em `/` < 3 GB antes de instalar (hoje 9,9 GB);
- `/health` da API != 200 apos 60 s, ou crash-loop (>3 restarts);
- log com `AUTO_LIFECYCLE_REQUIRES_IMPLANTAR_PERSISTENCE` ou erro de Prisma;
- `SIMULATE_ACTIVATE` retornar `preflight.ok: false` por `baseline_record_store`
  (indicaria persistencia nao ligada no processo novo);
- qualquer `MITIGATED` aparecer no runtime sem comando humano.

---

## 5. ENTREGA — RESUMO

### 5.1 Diferencas em relacao a versao homologada

Producao roda `bf7bc52`; homologado e `934df6e` (**27 commits** a frente,
`bf7bc52` e ancestral). Sem mudanca em `apps/web`, sem migration nova. As
alteracoes estao concentradas no motor de mitigacao (19 arquivos de producao em
`apps/api/src`).

### 5.2 Dependencias e bloqueantes

| # | Item | Situacao |
| --- | --- | --- |
| 1 | Persistencia duravel do baseline | **OK** — flag ja =1 e instalacao =IMPLANTAR |
| 2 | Migrations | **OK** — 43 = 43, nada a aplicar |
| 3 | Tabela `MitigationAutomationRecord` | **OK** — existe, 0 linhas |
| 4 | Versoes Node/Prisma/PG | **OK** — identicas ao laboratorio |
| 5 | Disco | **OK** — 9,9 GB livres (release ≈ 319 MB) |
| 6 | Mitigacao ativa que impeça o deploy | **nenhuma** (38 NORMAL + 1 DISABLED) |
| 7 | `/opt/GMJ-NetVision` com 12+ arquivos modificados | **BLOQUEIA `update.sh`** — usar o caminho de release imutavel |
| 8 | Build do pacote exige Docker na estacao | **atencao** — Docker foi desligado nesta sessao; religar antes do build |
| 9 | RAM do servidor (7 GB, 4 GB livres) | suficiente para servir; build **nao** roda nele |

### 5.3 Flags: atuais × necessarias

| Flag | Atual | Necessaria | Acao |
| --- | --- | --- | --- |
| `MITIGATION_AUTO_PERSISTENCE_ENABLED` | 1 | 1 | **nenhuma** |
| `MITIGATION_AUTO_LIFECYCLE_ENABLED` | 0 | 0 | nenhuma |
| `MITIGATION_AUTO_EXECUTION_ENABLED` | 0 | 0 | nenhuma |
| `MITIGATION_AUTO_REMOVE_ENABLED` | ausente | ausente/0 | nenhuma |
| `MITIGATION_MODE` / `EXECUTOR` / `LIVE_WRITE` | AUTO / HUAWEI / true | iguais | nenhuma |

### 5.4 GO / NO-GO

**GO para publicar a release** com o plano da secao 4, condicionado a:

1. backup `pg_dump` + `sha256sum -c` + `pg_restore --list` aprovados;
2. pacote gerado a partir de `2ad62b8` com `package.sha256` conferido;
3. janela autorizada e operador presente;
4. `SIMULATE_ACTIVATE` aprovado (read-only) apos o restart, antes de qualquer
   ACTIVATE real.

**NO-GO para qualquer ACTIVATE fisico nesta publicacao** — permanece exigindo
autorizacao separada. AUTO, lifecycle e REMOVE automatico seguem desligados.
