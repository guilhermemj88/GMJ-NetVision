# Publicacao controlada B6 — release 2ad62b8 na IMPLANTAR

Executado em **2026-11-02, 20:09Z–20:45Z** (UTC), janela autorizada pelo responsavel.
Escopo: publicar **somente a API**, com escrita BGP desabilitada.

| Item | Valor |
| --- | --- |
| Release anterior | `bf7bc527a94681b2f40e5d0d9f4b6daa329b4f59` |
| Release publicada | `2ad62b8077250d99a25ef243d0b8ea632e85d757` (B6) |
| Fonte funcional | `2ad62b8` (sem alteracao de codigo nesta missao) |
| Pacote | `netvision-single-pilot-api-2ad62b8….tar.gz` — sha256 `a17b503c…086a22` |
| Manifesto | sha256 `5ff8fedb…8c24` · 10.070 arquivos |
| Servico reiniciado | **apenas** `netvision-api` |

## 1. Gates iniciais (todos atendidos)

`netvision-api`, `netvision-web`, `netvision-mcp` e `postgresql@18-main` ativos; `/health`
200/200/200; 9,8 GB livres; `MitigationAutomationRecord` com 0 linhas; runtime 38 `NORMAL`
+ 1 `DISABLED`; hashes do pacote e do manifesto validos no staging.

## 2. Backup pre-deploy

`/root/netvision-backups/b6-20261102T200958Z/`

| Arquivo | Conteudo |
| --- | --- |
| `netvision-operational.dump` | `pg_dump -Fc` — 2.323.093.342 bytes (2,16 GB) |
| `dump-toc.txt` | 556 linhas de TOC · 65 `TABLE DATA` |
| `SHA256SUMS` | dump `fcd7b2a3…0ff1df4` · configs `59fc7f27…ac955a50` |
| `configs-rollback.tar.gz` | drop-ins da API e do WEB, `.env`, `/etc/netvision`, `api-unit-before.txt` |

Verificacoes: `sha256sum -c` = **OK** para os dois; `pg_restore --list` leu o arquivo
inteiro (rc=0); `pg_restore` do dump completo validado sem erro de formato.

## 3. Copia externa validada

Destino: `C:\projetos\netvision-backups-implantar\b6-20261102T200958Z\`
(dump + `nv-b6-configs.tar.gz` + `nv-b6-SHA256SUMS` + `nv-b6-dump-toc.txt`).

| Arquivo | SHA256 origem | SHA256 destino |
| --- | --- | --- |
| dump | `fcd7b2a3…0ff1df4` | `fcd7b2a3…0ff1df4` |
| configs | `59fc7f27…ac955a50` | `59fc7f27…ac955a50` |

A copia temporaria em `/home/guilherme` foi removida **somente depois** da conferencia
(2,16 GB devolvidos ao filesystem).

## 4. Migrations e schema

| Fonte | Migrations |
| --- | --- |
| Release ativa `bf7bc52` | 43 |
| Release candidata `2ad62b8` | 43 |
| `_prisma_migrations` (banco) | 43 (todas finalizadas) |

`diff` vazio nos tres cruzamentos; conteudo dos `migration.sql` identico byte a byte;
`prisma/schema.prisma` identico (1898 linhas, ambas as releases em CRLF).
**Nenhuma migration pendente, nenhum DDL executado.**

Prova de que o pacote carrega o B6 (bundle `server.cjs`, sha256 `7cdff4e9…30f05d`):

| Marca | bf7bc52 | 2ad62b8 |
| --- | --- | --- |
| `MITIGATION_BASELINE_RECORD_UNAVAILABLE` | 0 | 6 |
| `baseline_record_store` | 0 | 1 |
| `MITIGATION_BASELINE_DIVERGED` | 0 | 1 |
| `MITIGATION_BASELINE_NOT_DERIVABLE` | 0 | 2 |
| `MITIGATION_BASELINE_UNSAFE` | 0 | 2 |
| `AutomationMitigationBaselineStore` | 0 | 2 |

## 5. Instalacao

`install-release.sh` aprovou: hash do pacote, hash do manifesto, 10.070 arquivos do
manifesto, ausencia de `.env`, migrations identicas a release ativa e folga de disco.
Release instalada **ao lado** em `/opt/netvision-auto-activate/releases/2ad62b8…`;
`SOURCE_SHA` confere. A API continuou em `bf7bc52` ate a ativacao.

## 6. Drop-ins e precedencia (conferida antes do restart)

Ordem efetiva dos dois ultimos drop-ins:

```
…/zzzzzzzzzzzzzzzzzzzzzzzz-b6-2ad62b8.conf      (release)
…/zzzzzzzzzzzzzzzzzzzzzzzzzz-b6-flags.conf      (flags, 26 z)
```

`ExecStart`/`WorkingDirectory` passaram a apontar para `2ad62b8…`. `Environment`
efetivo antes do restart: `LIVE_WRITE=false`, `AUTO_EXECUTION=0`, `AUTO_LIFECYCLE=0`,
`AUTO_REMOVE=0`, `AUTO_PERSISTENCE=1`.

Nota de precedencia: `MITIGATION_LIVE_WRITE_ENABLED=true` vinha de `zz-auto.conf`
(`Environment=`), sem nenhum `EnvironmentFile` definindo a chave — por isso o drop-in
de flags a sobrescreve. As demais chaves tambem existem nos dois `EnvironmentFile`
(`auto-activate-e78638a-stage0.env` e `single-pilot-4637696-auto0.env`) com **os mesmos
valores**, de modo que o resultado efetivo e o desejado em qualquer ordem de leitura.

`MITIGATION_AUTO_REMOVE_ENABLED=0` e obrigatorio: `lifecycleConfig()` aborta o boot
(`MITIGATION_AUTO_REMOVE_ENABLED_MUST_BE_0`) quando `NETVISION_INSTALLATION_ID=IMPLANTAR`
e persistencia/lifecycle estao ligados.

## 7. Ativacao

`activate-release.sh` → `daemon-reload` + `systemctl restart netvision-api`.
Health 200 em **3 s**. PID novo **3508440**; `NRestarts=0`.

Flags lidas do `/proc/<pid>/environ` do processo novo:

```
MITIGATION_LIVE_WRITE_ENABLED       = false
MITIGATION_AUTO_EXECUTION_ENABLED   = 0
MITIGATION_AUTO_LIFECYCLE_ENABLED   = 0
MITIGATION_AUTO_REMOVE_ENABLED      = 0
MITIGATION_AUTO_PERSISTENCE_ENABLED = 1
NETVISION_INSTALLATION_ID           = IMPLANTAR
```

Diff do `Environment=` efetivo contra o snapshot pre-B6 (20:09Z): apenas
`LIVE_WRITE true→false` e as tres chaves AUTO_* que passaram a ser explicitadas
(`EXECUTION` ja era 0). Nenhuma outra variavel alterada.

## 8. Validacao pos-publicacao

| Verificacao | Resultado |
| --- | --- |
| `netvision-api` | active · PID 3508440 · restarts 0 |
| `:3333/health` | 200 (monitorado por 10 s, estavel) |
| `netvision-web` | active · **PID 2976909 inalterado** · 200 |
| `netvision-mcp` | active · 200 · reiniciado **por dependencia** |
| `postgresql@18-main` | active · 200 via `pg_isready` |
| Logs da API desde a ativacao | nenhuma entrada `warning` ou superior |
| Runtime de mitigacao | 38 `NORMAL` + 1 `DISABLED` (inalterado) |
| `BgpMitigationEvent` (24 h) | 0 |
| Registros de baseline (`kind <> outbox`) | 0 |
| Migrations aplicadas | 43 (inalterado) |

**MCP:** a unit tem `Requires=netvision-api.service` + `After=`, portanto o restart da
API reinicia o MCP automaticamente. Nenhum arquivo do MCP foi alterado (release
`mcp-5874fe0` intacta, 0 arquivos novos); o servico respondeu 200 imediatamente.

## 9. Preflight read-only (SIMULATE_ACTIVATE)

Perfil autorizado `cmuoavm4e00bysslhqd0h3q7u` (`PL-AGLINK_IPv4-IN`, AUTO), entrada pela
rota inbound do n8n — mesmo `MitigationCommandService` da UI.

```
requestId      = sim-b6-1793652153
status         = WOULD_ACTIVATE
ok             = true
preflight.ok   = true
baseline_record_store   = true  (armazenamento do baseline disponivel para escrita real)
preserved_attributes    = true  ([if-match ip-prefix AGLINK-BLOCO-TODO-23 |
                                 apply local-preference 1100 |
                                 apply extcommunity rt 268568:140 rt 268568:660 additive])
node_occupancy          = true  (nodes 1 e 2 livres — caso A)
policy_mitigation_scope = true  (nenhum node de mitigacao na policy)
comandos previstos = 8 (preview; nenhum enviado)
```

Somente leitura no equipamento: nenhum `commit`, nenhuma escrita, nenhuma
route-policy alterada.

## 10. Achado: evento de notificacao (comportamento pre-existente)

O `SIMULATE_ACTIVATE` gera o evento `MITIGATION_SIMULATION_TRIGGERED`. Com
`MITIGATION_AUTO_PERSISTENCE_ENABLED=1` o outbox duravel entra em modo
`requireAcknowledgement` e **persistiu 1 linha de outbox** (nao e baseline):

```
outbox:MITIGATION_SIMULATION_TRIGGERED:sim-b6-1793652153 | PENDING
erro: transport did not acknowledge delivery
```

O webhook `https://automacao.gmjtelecom.com.br` respondeu **HTTP 200** mas sem
`delivered: true`; por isso o registro continua `PENDING` e sera reprocessado com
backoff (30 s → 600 s) ate, no maximo, 12 tentativas, quando vira `FAILED`
(`durable-mitigation-outbox.ts`). Duas tentativas foram registradas em
`MediaDeliveryLog` com `status=FAILED`.

Evidencia de que **nao e regressao do B6**: `requireAcknowledgement` e a mensagem
`transport did not acknowledge delivery` existem tambem no bundle `bf7bc52`
(2 e 1 ocorrencias, identicas). O mesmo ocorreria na release anterior.

## 11. Garantias de escopo

- **Zero escrita no Huawei.** O unico acesso foi o preflight read-only.
- **Zero `ACTIVATE`/`REMOVE` fisico**; nenhuma route-policy tocada.
- **Zero migration/DDL**; banco inalterado alem da linha de outbox do item 10.
- **n8n nao foi alterado**: nenhuma configuracao, workflow ou token modificados; houve
  apenas uma notificacao de evento do proprio motor (item 10).
- **WEB nao foi atualizado nem reiniciado** (PID inalterado).
- **AUTO desligado**: `EXECUTION=0`, `LIFECYCLE=0`, `REMOVE=0`.
- **Sem `git push`**, sem deploy de WEB/MCP.

## 12. Rollback preparado (nao executado)

`sudo bash /home/guilherme/staging-b6-2ad62b8/rollback-to-bf7bc52.sh`
— remove os dois drop-ins B6, `daemon-reload`, reinicia **somente a API** e reimprime as
flags efetivas. Sem tocar no banco (nenhuma migration foi aplicada). A release `bf7bc52`
permanece instalada; o backup pre-deploy esta local e externo.

## 13. GO/NO-GO

**GO.** A release `2ad62b8` esta ativa, saudavel, com escrita BGP desabilitada, AUTO
desligado, persistencia duravel habilitada e preflight read-only aprovado com
`baseline_record_store` e `preserved_attributes` confirmados.

Pendencias registradas antes de qualquer homologacao fisica:

1. Decidir sobre o `delivered: true` do webhook n8n (linha de outbox `PENDING` →
   `FAILED` apos 12 tentativas). Nenhuma acao foi tomada.
2. Habilitar `MITIGATION_LIVE_WRITE_ENABLED=true` exige **autorizacao separada**.
3. A homologacao fisica (ACTIVATE/REMOVE no equipamento) nao foi iniciada.
