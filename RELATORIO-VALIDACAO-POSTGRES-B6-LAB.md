# RELATORIO — VALIDACAO POSTGRESQL REAL B6 (LABORATORIO LOCAL)

Ambiente: Windows (estacao de trabalho) — nenhum acesso ao servidor IMPLANTAR
Worktree: `C:\projetos\GMJ-NetVision-aglink-activate-safety`
Branch: `feature/aglink-activate-safety` · HEAD inicial: `0aa072f`
Codigo B6 validado: **`2ad62b8`** (presente no historico, worktree limpo)
Data: 2026-11-02 09:42–09:50 (UTC-3)

**Resultado: 2/2 testes PostgreSQL EXECUTADOS e verdes** (nao skipped) contra
PostgreSQL **18.6** real e descartavel. Suite completa: **2792 verdes / 39 skip**.

---

## FASE 1 — Inventario

| Item | Resultado |
| --- | --- |
| Branch | `feature/aglink-activate-safety` |
| HEAD | `0aa072f` (docs) |
| `git status` | **limpo** |
| Commit B6 `2ad62b8` | presente (`git cat-file -t` = commit) |
| Docker | Docker Desktop instalado; engine parado → iniciado (**29.7.2**) |
| WSL2 | Debian (buster) e Ubuntu 20.04 — **sem** PostgreSQL instalado |
| Disco `C:` | 198,7 GB livres |
| RAM | 31,9 GB total / 8,2 GB livres |
| Porta 55077 | **livre** (antes e durante) |
| `.env` produtivo na worktree | **ausente** (nenhum carregamento de credencial de producao) |

### Como os testes PostgreSQL existentes preparam o schema
`apps/api/prisma/migrations` (43 migrations) aplicadas com
`prisma migrate deploy` em banco **vazio e descartavel** — mesmo procedimento do
`docs/SINGLE_AUTO_PILOT.md`. A limpeza e feita pelo proprio teste
(`beforeEach → deleteMany()`), sempre restrita ao banco de teste.

### Producao
**Nenhuma conexao** com `45.163.144.8` nesta sessao; nenhuma variavel
`DATABASE_URL` de producao usada; nenhum `.env` produtivo lido.

---

## FASE 2 — Laboratorio

| Item | Valor |
| --- | --- |
| Container | `netvision-baseline-pg` |
| Imagem | `postgres:18` (`sha256:29754c75…6df3`) |
| Versao do servidor | **PostgreSQL 18.6** (mesma do IMPLANTAR) |
| Publicacao | `5432/tcp -> 127.0.0.1:55077` (**somente loopback**) |
| Banco | `mitigation_baseline_test` |
| Usuario/senha | `nv_baseline_lab` / senha exclusiva de laboratorio |
| Bancos na instancia | `mitigation_baseline_test`, `postgres`, `template0`, `template1` — **nenhum produtivo** |
| `Mounts` / `Binds` | `[]` / `null` → **nenhum volume ou bind do host** (storage efemero do container + tmpfs) |
| Recursos em uso | CPU 0,00% · MEM **113 MiB** |

Alternativa nao foi necessaria: Docker funcional e nenhum componente do Windows
instalado/alterado (apenas o Docker Desktop ja instalado foi iniciado).

---

## FASE 3 — Preparacao

Guarda programatica executada **antes** de qualquer DDL:

```
host=127.0.0.1 port=55077 db=mitigation_baseline_test   -> OK
identidade: db=mitigation_baseline_test | user=nv_baseline_lab
            data_directory=/var/lib/postgresql/18/docker | port=5432
            bancos=4                                     -> OK
```

Schema: `prisma migrate deploy` → **43 migrations aplicadas** em banco vazio;
tabela `MitigationAutomationRecord` confirmada
(`id text, kind text, status text, payload jsonb, createdAt, updatedAt`),
**0 linhas** antes dos testes. Nenhuma migration em banco preexistente.

---

## FASE 4 — Testes reais

`MITIGATION_BASELINE_TEST_DATABASE_URL` apontando **exclusivamente** para
`127.0.0.1:55077/mitigation_baseline_test`.

| Teste | Resultado |
| --- | --- |
| `persiste o registro e recupera por uma instancia nova do adaptador` | ✅ **PASSOU** (46 ms) |
| `devolve null para escopo sem registro` | ✅ **PASSOU** (5 ms) |

Execucao: `Test Files 1 passed (1) · Tests 2 passed (2)` — **nao skipped**.

### Prova de gravacao real (consulta direta ao PostgreSQL)
```
id          : mitigation-baseline:host-f1a:PL-CLIENTE_IPv4-IN
kind/status : mitigation-baseline | ACTIVE
device      : host-f1a
policy      : PL-CLIENTE_IPv4-IN
par         : bogon=1 mitigation=2
readBackSha256 : 7a035d5d1422e2bd8ce7f83d8b7f1f481ced1596bdce133b81c2faca106e3063
capturedAt  : 2026-11-02T12:45:13.233Z
nodes permanentes: 10,1000
clausulas node 10: ["if-match ip-prefix PREFIX8to24",
                    "apply local-preference 1100",
                    "apply extcommunity rt 268568:140 additive"]
```

### Prova de recuperacao entre instancias
O teste faz: `save` (instancia A) → **`$disconnect()`** (conexao encerrada) →
**novo `PrismaClient`** (instancia B) → **novo adaptador** → `load` →
`toEqual(record)` (device, policy, par, nodes e hash **integros**).

### Evidencia extra: executor real sobre PostgreSQL real
Teste de evidencia **temporario** (nao versionado, removido apos a execucao) com
`HuaweiMitigationExecutor` real + `AutomationMitigationBaselineStore` sobre
Prisma/PostgreSQL — 4/4 verdes:

| Cenario | Resultado |
| --- | --- |
| Instancia A grava no PG e e descartada; instancia B valida o **REMOVE** | ✅ `policy_baseline_record` ok, `preflight.ok = true` |
| Registro **AUSENTE** no PG | ✅ REMOVE bloqueado (`MITIGATION_BASELINE_RECORD_MISSING`) |
| Registro **CORROMPIDO** no PG | ✅ REMOVE bloqueado |
| Node permanente **ALTERADO** desde o ACTIVATE | ✅ REMOVE bloqueado (`MITIGATION_BASELINE_DRIFT`) |

Depois da execucao o arquivo temporario foi **apagado**; `git status` limpo.

---

## FASE 5 — Validacao

| Verificacao | Resultado |
| --- | --- |
| Testes PG realmente executados | ✅ 2 passed (arquivo nao aparece como skipped) |
| Regressao B5/B6 + REMOVE (6 arquivos) | ✅ **114 passed** |
| `tsc --noEmit` | ✅ 0 |
| `eslint --max-warnings=0` (mitigation + worker) | ✅ 0 |
| Suite completa da API | ✅ **2792 verdes / 39 skip (2831)**, exit 0 |
| Isolamento do laboratorio | ✅ porta somente loopback, 4 bancos, sem volumes |

Observacao: os demais suites `*.postgres.test.ts` (single-pilot, readiness,
fast-traffic) continuam **skipped** porque exigem URLs/bancos proprios
(`SINGLE_PILOT_TEST_DATABASE_URL`, etc.) — comportamento esperado e inalterado.

---

## FASE 6 — Encerramento

### Ambiente de laboratorio mantido
| Recurso | Valor |
| --- | --- |
| Container | `netvision-baseline-pg` (rodando) |
| Memoria | 113 MiB — limite do host 15,58 GiB |
| CPU | 0,00% ocioso |
| Disco | container efemero (sem volume nomeado); imagem `postgres:18` 457 MB ja existente |
| Porta | `127.0.0.1:55077` (loopback) |
| Finalidade | reexecutar as validacoes da proxima etapa sem reprovisionar |

O ambiente nao foi apagado, conforme instruido. Para remove-lo depois:
`docker rm -f netvision-baseline-pg` (nada mais e afetado — sem volumes).

### Falhas
Nenhuma falha nos testes. Duas observacoes de infraestrutura, sem impacto:

1. a primeira tentativa de container falhou porque `postgres:18` exige o mount em
   `/var/lib/postgresql` (nao `/data`) — corrigido no proprio laboratorio;
2. `docker inspect --format` com `\n` quebrou no PowerShell; contornado com
   `--format '{{json ...}}'` (nenhuma alteracao de codigo do projeto).

### Riscos residuais
- O banco de laboratorio **nao tem** os dados reais; valida o adaptador e o
  contrato de persistencia, nao o volume de dados de producao.
- Permanece valido o risco ja registrado no B6: sem persistencia configurada em
  producao, a escrita real fica bloqueada por desenho.

---

## GO / NO-GO

**GO** para a proxima etapa de homologacao em laboratorio.

Comprovado neste ambiente: gravacao real em PostgreSQL 18.6, recuperacao integra
por instancia nova (conexao encerrada e recriada), validacao de baseline para
REMOVE e bloqueio de registro ausente/corrompido/divergente — tudo com
`2ad62b8` sem nenhuma alteracao de codigo funcional.

**NO-GO continua valido para ACTIVATE fisico**: exige autorizacao explicita do
responsavel. Nada foi publicado, nenhuma escrita no Huawei, `n8n` intocado,
AUTO desligado, PostgreSQL da IMPLANTAR nao acessado.
