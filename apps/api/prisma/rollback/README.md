# Rollback do release MPLS/VPWS (achados A2-a e A2-b)

`MplsSource` ganhou o valor `SSH` na migration `20261118150000_mpls_ssh_ldp_discovery`.
Um cliente Prisma gerado pelo schema **anterior** (`3ed18fe`) não conhece esse valor e
**falha a leitura** de todas as tabelas MPLS:

```
Value 'SSH' not found in enum 'MplsSource'
```

Voltar o código da API sem tratar os dados derruba o painel MPLS e os endpoints
`/api/hosts/:hostId/mpls*` (HTTP 500), mesmo com o banco intacto.

**Nada aqui converte SSH para SNMP.** A linha vai inteira para a quarentena (JSONB) e
volta com a proveniência original.

## 1. Quarentena (`mpls-ssh-quarantine.sql`)

Rodar com a **API parada**, imediatamente antes de subir um build anterior.

O script calcula o **conjunto afetado completo** antes de qualquer `DELETE`:

| Tabela | Critério |
| --- | --- |
| `MplsVsi` | `source = 'SSH'` |
| `MplsAc`, `MplsPw` | `source = 'SSH'` **ou** `mplsVsiId` de uma VSI SSH |
| `MplsDeviceState` | `source = 'SSH'` |

O segundo critério é o **A2-a**: `MplsAc.mplsVsiId` e `MplsPw.mplsVsiId` são
`ON DELETE CASCADE`, então AC/PW com origem **SNMP** pendurados numa VSI SSH seriam
apagados pelo cascade. A versão anterior só guardava linhas `SSH` e os perdia.

Garantias do script (tudo em uma transação):

1. `MplsSshQuarantine` guarda `row_source` (proveniência), `row_data` (JSONB) e `batch_id`;
2. `MplsSshQuarantineSnapshot` registra contagem, **digest por tabela** e quantas linhas
   foram afetadas por cascade — sempre **antes** do `DELETE`;
3. validação fail-closed: se o que foi guardado não for exatamente o conjunto afetado,
   `RAISE EXCEPTION` e **nada é apagado**;
4. validação pós-delete: nenhuma linha do conjunto afetado pode continuar viva.

Relatório ao final: `linhas_em_quarentena`, `origem_ssh`, `origem_nao_ssh_preservada`
e `ac_pw_preservados`.

## 2. Restauração (`mpls-ssh-restore.sql`)

Rodar depois de voltar ao build novo (que conhece `MplsSource.SSH`).
Cria a função `netvision_mpls_ssh_restore()` e a executa dentro de uma transação.

### 2.1 Colisões (A2-b)

Durante a janela de rollback a API antiga continua coletando por SNMP e pode
**recriar** `MplsDeviceState` (único por `hostId`) e `MplsVsi` (único por
`hostId`,`name`) com **IDs diferentes** dos que foram para a quarentena.

| Situação | Decisão |
| --- | --- |
| `MplsDeviceState` já existe para o host (outro id) | o registro **vivo** (coletado na janela) é preservado; a linha antiga fica na quarentena com `superseded_at` + motivo |
| `MplsVsi` já existe com o mesmo `id` | conta como `ja_presente` |
| `MplsVsi` existe com outro `id` mas mesma `(hostId, name)` | **reconciliação**: a VSI viva é mantida e os AC/PW da quarentena são **reparentados** para o `id` vivo |
| AC/PW já existe com a mesma chave natural (`hostId`,`vsiName`,`ifIndex` / `+pwId,remoteIp`) | o registro vivo vence; a linha antiga fica registrada |
| AC/PW cuja VSI pai não existe | fica na quarentena com motivo (nunca é descartado em silêncio) |

Não há `ON CONFLICT DO NOTHING`: cada conflito é tratado explicitamente e a função
devolve a contagem de `restauradas`, `ja_presentes`, `reconciliadas` e `supersedidas`.

### 2.2 Verificação de digest e integridade

Depois das inserções a função compara, por tabela, o **digest do que está vivo** com o
**digest do que foi guardado**. Para `MplsAc`/`MplsPw` o `mplsVsiId` é ignorado no
digest (ele pode ter sido remapeado de propósito) e o vínculo é garantido por uma
checagem de **órfãos**. Qualquer divergência levanta exceção e a transação é desfeita.

## 3. Fluxo operacional

```bash
# 1) API PARADA
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/api/prisma/rollback/mpls-ssh-quarantine.sql
# 2) subir o build anterior
# ... janela de rollback (a API antiga pode coletar normalmente)
# 3) ao voltar para o build novo
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/api/prisma/rollback/mpls-ssh-restore.sql
```

Rollback do próprio rollback: se a restauração falhar no meio, a transação é desfeita e
nada muda — a quarentena continua intacta (`pendentes` > 0) e pode ser reexecutada.

## 4. Como a falha foi reproduzida (PostgreSQL 18 descartável)

```bash
export DATABASE_URL=postgresql://postgres:<senha>@127.0.0.1:<porta>/a2_rollback?schema=public
npx prisma migrate deploy
git show 3ed18fe:apps/api/prisma/schema.prisma > .a2-schema-antigo.prisma
# trocar a linha `output` do generator para `./.a2-old-client`
npx prisma generate --schema=.a2-schema-antigo.prisma
# sonda com o cliente antigo contra linhas source='SSH'
```

## 5. Evidência do ensaio (18/11/2026, PostgreSQL 18, 46 migrations)

Cenário misto: `VSI-SSH` com um AC SNMP, um AC SSH e um PW SNMP, mais `VSI-SNMP`
independente.

| Passo | Resultado |
| --- | --- |
| Quarentena | 5 linhas guardadas — **3 SSH + 2 não-SSH preservadas pelo cascade** (o bug do A2-a) |
| Tabelas vivas após a quarentena | apenas `vsi-snmp`, `ac-snmp-sob-snmp`, `pw-snmp-sob-snmp` |
| Janela de rollback simulada | API antiga recriou `MplsDeviceState` e `VSI-SSH` com IDs novos + um AC com a mesma chave natural |
| Restauração | `MplsDeviceState` 1 supersedido · `MplsVsi` 1 reconciliada · `MplsAc` 1 restaurado + 1 supersedido · `MplsPw` 1 restaurado |
| Órfãos após a restauração | **0** |
| Proveniência | `ac-ssh` voltou como `SSH`; `pw-snmp-sob-ssh` voltou como `SNMP` (reparentado para a VSI viva) |
| Digest vivo × guardado | **igual** nas quatro tabelas (senão a função teria abortado) |
| 2ª execução | `restauradas`/`ja_presentes`/`reconciliadas`/`supersedidas` = 0 em todas as tabelas (idempotente) |
| Linha inválida na quarentena | `ERROR: null value ... violates not-null constraint` → **ROLLBACK**: nada foi criado e a linha segue pendente |

Reexecutado em 18/11/2026 partindo de **instalação limpa** (banco vazio, 47 migrations,
incluindo `20261118170000_mpls_ssh_session_lease`): mesmo resultado — 5 linhas em
quarentena (3 SSH + 2 não-SSH preservadas do cascade), 0 órfãos, proveniência mantida
(`ac-ssh` volta como SSH, `pw-snmp-sob-ssh` volta como SNMP) e digest igual.

> Os contadores de `MplsAc`/`MplsPw` passaram a ser **por execução**. Antes eles somavam
> o lote inteiro, então uma segunda execução (que não insere nada) ainda reportava
> `restauradas = 1`; o estado sempre esteve correto, o relatório é que mentia.

## 6. Proteções de runtime do fallback CLI (A1 e P6)

Estas regras valem **independentemente** do rollback — estão documentadas aqui porque
são o que mantém o `MplsSource.SSH` confinado.

| Proteção | Comportamento |
| --- | --- |
| Opt-in por equipamento | `MplsDeviceState.sshFallbackEnabled` nasce `false` em qualquer linha existente ou nova. Sem opt-in, o polling usa **somente SNMP**. |
| Plataforma | Só Huawei VRP identificado recebe CLI. Juniper, OLT, modelo contraditório e fabricante ausente são recusados (`PLATFORM_NOT_HUAWEI_VRP`) antes de abrir sessão. |
| Orçamento | `MplsSshSessionLog` + `pg_advisory_xact_lock`: no máximo 2 sessões simultâneas e 12 por hora em **toda a instalação**, valendo entre processos e sobrevivendo a restart. Linhas sem `finishedAt` expiram pela janela de staleness (processo morto não bloqueia para sempre) e o histórico com mais de um dia é removido. |
| Sem rebaixamento | Recusa por concorrência, orçamento ou timeout (`executed: false`) não grava coleta e não altera o estado de descoberta — `FOUND_L2VC` nunca vira `INCOMPLETE` por falta de vaga. |
| Caminho administrativo | `GET/PUT /api/hosts/:hostId/mpls/ssh-fallback` (ADMIN). Habilitar exige Huawei VRP comprovado (409 caso contrário); desabilitar é sempre permitido. Nunca é preciso `UPDATE` manual no banco. |

Evidência: `mpls-ssh-budget.test.ts`, `mpls-ssh-fallback-routes.test.ts` e
`prisma-mpls-ssh-lease.postgres.test.ts` (PostgreSQL 18, dois pools independentes).

## 7. A2-N1 — escopo da validação de integridade

O digest da restauração comparava **todas** as linhas já restauradas com o snapshot
congelado da quarentena. Bastava uma atualização legítima (o coletor novo atualizar o
`status` de uma VSI restaurada) para a reexecução abortar:

```
ERROR: A2_RESTORE_DIGEST_MISMATCH (MplsAc): 7263bab9… <> d960e21e…
ROLLBACK
```

A restauração ficava permanentemente bloqueada sem nenhum problema real.

Agora cada execução marca as linhas que **ela** inseriu (`restore_run`) e valida somente
esse conjunto. O snapshot original (`MplsSshQuarantineSnapshot.digest`) continua intocado
como evidência histórica do instante da quarentena, e a conferência de órfãos também é
por execução.

| Cenário | Resultado |
| --- | --- |
| Restauração inicial | restaura e valida o que inseriu |
| Atualização legítima depois da restauração | aceita |
| Reexecução | `0` em todos os contadores, **sem** abortar digest |

## 8. A2-N3 — equipamento removido na janela

Se o `Device` foi excluído do inventário durante a janela, a FK de `MplsVsi` /
`MplsDeviceState` barraria a reinserção e a transação inteira abortaria — inclusive para
os hosts que estavam íntegros.

O script **não recria cadastro** e **não descarta dado**:

| Situação | Comportamento |
| --- | --- |
| `Device` do `hostId` ausente | linhas das quatro tabelas ficam **bloqueadas** (`blocked_at` + `blocked_reason`), não restauradas e não supersedidas |
| AC/PW cujo pai é uma VSI bloqueada | também bloqueados (o host é recuperado por inteiro depois) |
| AC/PW sem VSI pai em lugar nenhum | bloqueados (antes eram marcados como supersedidos, o que os tornava irrecuperáveis) |
| Demais hosts | restaurados normalmente **na mesma execução** (é transacionalmente seguro) |
| `Device` devolvido ao inventário | a execução seguinte **reabre** o bloqueio e restaura as linhas |

Evidência (PostgreSQL 18, banco criado do zero): com `d1` íntegro e `d2` removido, a
restauração comitou, `d1` voltou completo, `d2` ficou com 1 estado + 1 VSI + 1 AC
bloqueados, `Device d2` **não** foi recriado (`count = 0`). Recriando o cadastro de `d2`
sob supervisão, a execução seguinte reabriu e restaurou os três registros.

