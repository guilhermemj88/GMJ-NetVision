# RELATORIO — PRE-PUBLICACAO DA API B6 (pacote preparado, nada publicado)

Ambientes: Windows (build) + IMPLANTAR (verificacoes read-only e staging)
Branch: `feature/aglink-activate-safety` · Codigo funcional: **`2ad62b8`**
Producao atual: **`bf7bc52`** (release imutavel ativa)
Data: 2026-11-02 10:15–10:35 (UTC-3)

**Nada foi publicado, nenhuma release foi trocada, nenhum servico reiniciado,
nenhuma migration aplicada, nenhuma flag alterada, nenhum comando Huawei.**

---

## 1. SHA exato do codigo empacotado

| Item | Valor |
| --- | --- |
| HEAD do branch | `a4d91fc` |
| Codigo funcional | **`2ad62b8`** |
| Commit empacotado (`sourceSha`) | **`2ad62b8077250d99a25ef243d0b8ea632e85d757`** |
| Build executado em worktree limpa e detachada nesse SHA | `/projetos/GMJ-NetVision-b6-release` (HEAD = `2ad62b8`, arvore limpa) |

Commits **posteriores** a `2ad62b8` — verificados um a um, **nenhuma mudanca funcional**:

```
a4d91fc docs(deploy): plano de publicacao do motor B6 na IMPLANTAR
934df6e test(homolog): ciclo ACTIVATE -> restart -> REMOVE em laboratorio
12306fb docs(bgp): validacao PostgreSQL 18 real do baseline B6
0aa072f docs(bgp): validacao PostgreSQL B6 no IMPLANTAR
9d0959a docs(bgp): relatorio da correcao B6
```

Arquivos tocados: 5 relatorios `.md` + 6 arquivos de `apps/api/lab-homolog/`.
**Zero** arquivos em `apps/api/src` e **zero** em `apps/web`.

---

## 2. Pacote de publicacao (construido)

| Item | Valor |
| --- | --- |
| Diretorio | `C:\projetos\netvision-release-b6-2ad62b8` |
| Pacote | `netvision-single-pilot-api-2ad62b8077…d757.tar.gz` |
| `package.sha256` | **`a17b503ca2c6ce9389223a76af6f8af3a4bfd981189160643bc58c1987086a22`** |
| `artifact-manifest.json` | **`5ff8fedb473161f638f3ed301ecaa1b7851b6bf23911cc24d1aaa82c87428c24`** |
| Tamanho comprimido | 95.296.623 bytes (90,9 MiB) |
| Tamanho instalado | 300.595.798 bytes · **10.070 arquivos** |
| `sourceArchiveSha256` | `cb0272eff7dafba45d915d980dc1dbcef87b4156f174379b8270de912c0815be` |
| Build reproduzivel | `compiledHashesReproduced=true` · `packageTarReproduced=true` |
| Builder | imagem `sha256:622f209f…` · linux/x64 · node v24.19.0 · npm 11.17.0 |
| `server.cjs` | `7cdff4e930c8909eecedf42fb4c55f75a6b7707ae923f93c56d2d1a2ac30f05d` |

Auditoria de conteudo (extraindo o tar): **0** `.env`, **0** bundle WEB/MCP,
**0** arquivo de laboratorio ou relatorio, **43** migrations presentes.

### Staging entregue no servidor
`/home/guilherme/staging-b6-2ad62b8/` com pacote + manifesto + `package.sha256`
(94.944 KB). Gates do instalador validados **no servidor**, sem instalar:

| Gate | Resultado |
| --- | --- |
| `sha256sum -c package.sha256` | **OK** |
| `sha256sum` do manifesto | **OK** (`5ff8fedb…`) |
| `SOURCE_SHA` dentro do pacote | `2ad62b80…d757` = esperado |
| Manifesto: hash de cada arquivo | **10.070/10.070 conferidos** |
| `diff` migrations release ativa × candidata | **IDENTICAS** |
| Migrations banco × pacote | 43 × 43, **sem divergencia** |

---

## 3. Migrations — a divergencia 38 × 43 **nao existe**

Medicao direta nos tres lugares pedidos:

| Local | Migrations |
| --- | --- |
| Release ativa `bf7bc52` (`apps/api/prisma/migrations`) | **43** |
| Release candidata `2ad62b8` (pacote) | **43** |
| `_prisma_migrations` no PostgreSQL de producao | **43** (43 `finished_at` = 43 total, nenhuma falha/pendente) |
| `diff` arquivo a arquivo (sha256) entre ativa e candidata | **vazio** |
| `comm` banco × pacote | **vazio** |

Ultima migration nos tres: `20261029090000_auto_lifecycle_durable`.

Outras releases instaladas tambem tem 43 (`4637696`, `e78638a`), e nenhuma tem 38.
O unico numero diferente no servidor e o **checkout git legado**
`/opt/GMJ-NetVision` com **30** diretorios de migration — irrelevante, porque ele
**nao** e o que roda (a API serve a release imutavel).

**Conclusao:** o valor "38" nao corresponde a nenhum artefato em producao hoje;
provavelmente veio de uma contagem antiga ou de um diretorio fora do caminho de
execucao. **Nenhuma acao corretiva necessaria** e **nenhum DDL** deve ser feito.

---

## 4. Capacidade para o backup pre-deploy

| Item | Valor |
| --- | --- |
| Banco `netvision` | **26.037.368.511 bytes (24,2 GB)** |
| Backup de referencia (21/10) | 2.088.376.709 bytes (1,94 GB) → ~8% do banco |
| Estimativa do novo dump | **2,0–3,0 GB** (formato custom, comprimido) |
| Livre em `/` hoje | **9,8 GB** (86%) |
| Margem apos o dump | **~6,8–7,8 GB** — **suficiente** |

Plano de destino: `/root/netvision-backups/b6-<UTC>/` com `netvision-operational.dump`,
`SHA256SUMS`, `dump-toc.txt` e copia dos drop-ins + `.env`.
Recomendado replicar o dump para fora do servidor (a estacao ja hospeda as copias
externas dos dumps de 08/10 e 09/10).

---

## 5. Flags de escrita manual — estado efetivo

| Flag | Valor **atual** (de `/proc/<pid>/environ`) | Necessaria nesta publicacao |
| --- | --- | --- |
| `MITIGATION_EXECUTOR` | HUAWEI | inalterada |
| `MITIGATION_LIVE_WRITE_ENABLED` | **true** | **propoe-se `false`** |
| `MITIGATION_ALLOWED_DEVICE_IDS` | `host-377c554a…` | inalterada |
| `MITIGATION_AUTO_EXECUTION_ENABLED` | **0** | inalterada (deve seguir 0) |
| `MITIGATION_AUTO_LIFECYCLE_ENABLED` | **0** | inalterada (deve seguir 0) |
| `MITIGATION_AUTO_PERSISTENCE_ENABLED` | **1** | inalterada |
| `MITIGATION_AUTO_REMOVE_ENABLED` | ausente | ausente |

**Nenhuma flag foi alterada nesta missao.**

### Proposta para a primeira publicacao (implementada nos scripts, nao aplicada)
Manter `MITIGATION_LIVE_WRITE_ENABLED=false` via drop-in novo
(`…-b6-live-write-off.conf`), que ordena depois de `zz-auto.conf` e vence.

Semantica verificada no codigo:
`canReadLive = executor HUAWEI + device na allowlist`;
`canWriteLive = canReadLive && liveWriteEnabled`.

Ou seja, com `false`: **preflight, readback e `SIMULATE_ACTIVATE` continuam
funcionando** (validacao real contra o Huawei), e **qualquer escrita real e
bloqueada** com `MITIGATION_WRITE_DISABLED`. A habilitacao posterior exige
autorizacao separada e um drop-in novo.

---

## 6. Confirmacao: a nova release nao age sozinha

| Verificacao | Evidencia |
| --- | --- |
| Nao inicia ACTIVATE | lifecycle so inicia com `MITIGATION_AUTO_LIFECYCLE_ENABLED` (=0); `autoExecutionBlocked` exige `AUTO_EXECUTION_ENABLED` (=0). Verificado em `routes.ts` (`onReady` só roda `rehydrate/reconcile` quando `lifecycleSettings.enabled`) |
| Nao executa REMOVE | `removeEnabled: false` no `lifecycleConfig`; REMOVE só por comando manual autenticado |
| Nao altera route-policies | nenhum comando Huawei e enviado no boot; único caminho de escrita é `activate()/remove()` chamados por comando |
| Nao altera n8n | nenhuma mudança de payload/contrato; outbox já existe hoje (persistência já =1) e a tabela tem **0 linhas** (nada a drenar) |
| Nao exige migrations | 43 = 43 = 43, `diff` vazio |
| Nao interfere em Web/MCP | `apps/web` sem alteração; o pacote contém **somente** API/dist + prisma + deps; nenhum restart de web/mcp no script |
| Contrato HTTP | `routes.ts` no intervalo: **0** rotas adicionadas/removidas/alteradas (apenas injeção do baseline store) |

---

## 7. Sequencia exata de publicacao, validacao e rollback

Artefatos prontos em `deploy/b6-2ad62b8/` (sintaxe validada com `bash -n`):

1. **Backup** (autorizacao propria): `pg_dump -Fc netvision` → `SHA256SUMS` +
   `pg_restore --list`; copiar drop-ins e `.env`.
2. **Instalar** (ETAPA A): `sudo bash install-release.sh /home/guilherme/staging-b6-2ad62b8`
   — confere hashes/manifesto, exige ≥3 GB, compara migrations, instala em
   `/opt/netvision-auto-activate/releases/2ad62b8…` **ao lado**. A API segue em `bf7bc52`.
3. **Ativar** (ETAPA B): `sudo bash activate-release.sh`
   — cria drop-in da release + drop-in `LIVE_WRITE=false`, `daemon-reload`,
   reinicia **somente** `netvision-api`, e valida health em até 30 s.
   (`--keep-live-write` somente com autorizacao explicita.)
4. **Validar (read-only)**: `BASE=http://127.0.0.1:3333 TOKEN=… bash validate-readonly.sh <profileId>`
   — confirma ExecStart no SHA novo, flags efetivas, `SIMULATE_ACTIVATE` com
   `baseline_record_store` disponível e `MitigationAutomationRecord` sem linhas novas.
5. **Rollback**: `sudo bash rollback-to-bf7bc52.sh`
   — remove os dois drop-ins da B6, `daemon-reload`, restart da API, health check.
   **Banco: nada a reverter** (nenhuma migration). A release B6 fica instalada e inativa.

### Criterios de abortar
- `install-release.sh` falhar em hash/manifesto/migrations ou espaço < 3 GB;
- `/health` ≠ 200 em 30 s, crash-loop (>3 restarts) ou log com
  `AUTO_LIFECYCLE_REQUIRES_IMPLANTAR_PERSISTENCE`/erro Prisma;
- `SIMULATE_ACTIVATE` retornar `preflight.ok:false` por `baseline_record_store`;
- qualquer `MITIGATED` aparecer no runtime sem comando humano.

---

## 8. Divergencias encontradas e correcoes

| # | Divergencia | Situacao |
| --- | --- | --- |
| 1 | "38 × 43 migrations" | **nao reproduzida**: todos os artefatos em uso tem 43; `diff` e `comm` vazios. Registrado; nada a corrigir |
| 2 | `git status` do `/opt/GMJ-NetVision` sujo (12+ arquivos) | **irrelevante** para este deploy: a release vem do `git archive` do SHA homologado, nao do checkout. `update.sh` (in-place) segue **proibido** |
| 3 | `install-release.sh` do bf7bc52 comparava migrations com `4637696` | **corrigido** no script novo: compara com a release **ativa** por padrao (`CURRENT_RELEASE` sobreponivel) e exige ≥3 GB livres |
| 4 | Escrita real ligada por padrao | **mitigado**: `activate-release.sh` cria drop-in deixando `LIVE_WRITE=false` na primeira publicacao |

---

## 9. GO / NO-GO

**GO** para instalar e ativar a release, com as seguintes condicoes:

1. autorizacao explicita para a janela (backup + instalacao + ativacao);
2. backup `pg_dump` validado (`sha256sum -c` + `pg_restore --list`) e copia externa;
3. `install-release.sh` executado **antes** de `activate-release.sh`;
4. `LIVE_WRITE=false` mantido na primeira publicacao (default do script);
5. `AUTO_EXECUTION_ENABLED=0` e `AUTO_LIFECYCLE_ENABLED=0` inalterados;
6. `SIMULATE_ACTIVATE` aprovado **depois** da ativacao, antes de qualquer
   pedido de escrita.

**NO-GO para escrita real (ACTIVATE/REMOVE) nesta publicacao** — permanece
exigindo autorizacao separada, com o preflight read-only aprovado e o registro
de baseline conferido.

---

## Anexo — artefatos gerados

| Caminho | Conteudo |
| --- | --- |
| `C:\projetos\netvision-release-b6-2ad62b8\` | pacote + manifesto + `package.sha256` + `reproducible-build.sha256` |
| `/home/guilherme/staging-b6-2ad62b8/` (IMPLANTAR) | pacote + manifesto + `package.sha256` (94.944 KB) |
| `deploy/b6-2ad62b8/install-release.sh` | instala ao lado, valida hashes/manifesto/migrations, exige 3 GB |
| `deploy/b6-2ad62b8/activate-release.sh` | drop-in + `LIVE_WRITE=false` + restart so da API + health |
| `deploy/b6-2ad62b8/validate-readonly.sh` | preflight via `SIMULATE_ACTIVATE`, sem escrita |
| `deploy/b6-2ad62b8/rollback-to-bf7bc52.sh` | remove drop-ins + restart so da API |
| `deploy/b6-2ad62b8/README.md` | resumo operacional e hashes |
