# Runbook — API bf7bc52 (contrato `prefixes`) e n8n RC7.1.2+prefixos — IMPLANTAR

**Nada aqui foi executado em modo mutante.** Cada etapa marcada 🔒 exige autorização explícita.
Ordem obrigatória: API → (observação) → n8n. Rollbacks independentes.

| Item                      | Valor                                                                        |
| ------------------------- | ---------------------------------------------------------------------------- |
| Pacote                    | `netvision-single-pilot-api-bf7bc527a94681b2f40e5d0d9f4b6daa329b4f59.tar.gz` |
| SHA256 pacote / manifesto | `585ed6ef…ca5e7d` / `e2c50570…bfacf`                                         |
| `server.cjs` novo / atual | `09b12192…f634` / `5937a568…d08d` (4637696)                                  |
| Migrations                | 43, **idênticas byte a byte** às da 4637696 → nenhuma migration              |
| Flags                     | nenhuma muda (mesmas EnvironmentFiles; nenhum arquivo `.env` novo)           |

## API

1. Retrato antes: `ssh … 'sudo -n python3 -' < readonly-state.py > before.json`.
2. Copiar pacote + `artifact-manifest.json` para `/home/guilherme/staging-bf7bc52/`.
3. 🔒 `sudo bash install-release.sh /home/guilherme/staging-bf7bc52`: confere hashes, SOURCE_SHA,
   10.070 arquivos e migrations; instala em `/opt/netvision-auto-activate/releases/bf7bc52…`
   **inativa**. Não toca em systemd/banco/serviços.
4. 🔒 **restart API/MCP**: `sudo bash activate-api.sh`: drop-in `zzzzzzzzzzzzzzzzzzzzzzz-prefixes-bf7bc52.conf`
   (só `WorkingDirectory`/`ExecStart`), `daemon-reload`, `restart netvision-api`. O MCP reinicia
   junto (`Requires=`). WEB e Observer não são tocados.
5. Pós: `readonly-state.py > after.json`;
   `python -I postcheck-compare.py before.json after.json api=bf7bc52` (19 invariantes);
   `python3 - '<restart UTC>' < api-logs-contract-check.py`: aceita só o erro conhecido
   `CATALOG_BOOTSTRAP` (o mesmo da 4637696), 0 fatais, contrato `prefixes` presente,
   0 linhas de comando de mitigação.
6. Observar 5 min (PIDs estáveis, NRestarts=0).

**Rollback API** 🔒: `sudo bash rollback-api.sh` (remove só o drop-in novo, confere
`5937a568…` e reinicia), depois `postcheck-compare.py … api=4637696`. A release nova fica no disco.

## n8n (só depois da API aceita)

1. Gate de leitura no host do n8n: `python3 - < n8n-readonly-reconcile.py` → precisa `GO_CANDIDATE_APPLIES`
   (active `6a97fe4a…`/`60af8761…` **e** rascunho `1f1405f8…`/`6bc74d79…`). Senão: **parar**.
2. 🔒 Publicação: procedimento de `docs/n8n/RC7.1.2-PREFIXOS.md` §3 (PATCH só de `nodes`/`connections`
   - activate, sessão do editor do operador). Diff: `docs/n8n/RC7.1.2-PREFIXOS-NORMALIZER.diff`.
3. Pós: gate de leitura deve mostrar active = hash `5c76e866…`.

**Rollback n8n** 🔒: reativar `6a97fe4a…` (histórico) → hash ativo `60af8761…`.

## Validação sem ACTIVATE/REMOVE/Telegram

- API: contrato no bundle + suíte de testes (2697) + `/health`; nenhum endpoint de comando é chamado.
- n8n: hash do grafo ativo; nenhuma execução é disparada. O teste de mensagem real com
  prefixos fica para a homologação física autorizada da AGLINK.
