# Release B6 — motor de mitigacao BGP (2ad62b8)

Pacote imutavel + scripts de instalacao, ativacao, validacao e rollback.
**Nada aqui foi executado.** Toda acao exige autorizacao explicita.

## Artefatos

| Item | Valor |
| --- | --- |
| Fonte empacotada | `2ad62b8077250d99a25ef243d0b8ea632e85d757` |
| Pacote | `netvision-single-pilot-api-2ad62b8077250d99a25ef243d0b8ea632e85d757.tar.gz` |
| `package.sha256` | `a17b503ca2c6ce9389223a76af6f8af3a4bfd981189160643bc58c1987086a22` |
| `artifact-manifest.json` | `5ff8fedb473161f638f3ed301ecaa1b7851b6bf23911cc24d1aaa82c87428c24` |
| Tamanho | 95.296.623 bytes (90,9 MiB comprimido · 300.595.798 bytes descomprimido) |
| Arquivos no manifesto | 10.070 |
| Build reproduzivel | `compiledHashesReproduced=true` · `packageTarReproduced=true` |
| Builder | imagem `sha256:622f209f…` (Linux x64, node v24.19.0, npm 11.17.0) |
| Migrations no pacote | **43** (identicas as 43 da release ativa e do banco) |

## Ordem de execucao (cada passo autorizado separadamente)

1. `sudo bash install-release.sh /home/guilherme/staging-b6-2ad62b8`
   — valida hashes/manifesto, exige ≥3 GB, compara migrations e instala a
   release **ao lado** da atual. A API continua servindo `bf7bc52`.
2. `sudo bash activate-release.sh`
   — cria o drop-in da release + (por padrao) o drop-in de flags
   `zzzzzzzzzzzzzzzzzzzzzzzzzz-b6-flags.conf` com
   `MITIGATION_LIVE_WRITE_ENABLED=false`, `MITIGATION_AUTO_EXECUTION_ENABLED=0`,
   `MITIGATION_AUTO_LIFECYCLE_ENABLED=0`, `MITIGATION_AUTO_REMOVE_ENABLED=0` e
   `MITIGATION_AUTO_PERSISTENCE_ENABLED=1`; faz `daemon-reload`, reinicia
   **somente** `netvision-api` e reimprime as flags lidas do processo novo.
   Use `--keep-live-write` apenas com autorizacao para escrita real no primeiro
   deploy.
3. `BASE=http://127.0.0.1:3333 TOKEN=… bash validate-readonly.sh <profileId>`
   — valida release ativa, flags efetivas, preflight via `SIMULATE_ACTIVATE`
   (sem escrita) e confirma `MitigationAutomationRecord` sem linhas novas.
4. Rollback: `sudo bash rollback-to-bf7bc52.sh`
   — remove os drop-ins da B6, `daemon-reload`, restart da API. Banco intacto
   (nenhuma migration foi aplicada).

## O que NAO muda

- `apps/web` e MCP: nenhum arquivo publicado, nenhum restart.
- Banco: zero migration, zero DDL.
- n8n: nenhuma alteracao; payload e assinatura inalterados.
- `AUTO_EXECUTION_ENABLED=0`, `AUTO_LIFECYCLE_ENABLED=0` e AUTO REMOVE=0 permanecem;
  persistencia durável do baseline habilitada nao habilita execucao automatica.
