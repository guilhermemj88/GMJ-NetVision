# RELATÓRIO — AGLINK prefixos: ajuste final de publicação (PREPARADO, NÃO PUBLICADO)

**31/10/2026 · branch `feature/aglink-computize-prefixes` · base `228262b` → `bf7bc52`**
**Sem publicação de API/n8n, sem escrita Huawei, sem deny node 5, AUTO desligado, sem ACTIVATE/REMOVE,
sem catálogo/migration/restart, sem Telegram, motor FAST intacto.**

## 1. n8n — candidato refeito a partir da versão publicada

**Achado:** o JSON de `228262b` partia do RC7.1 (56 nós). Publicá-lo teria removido
`Somente Status Mitigacao RC712?` / `Telegram - Status Mitigacao RC712` e revertido 15 nós
(ACK estrito, 4 webhooks, alarmes). Ele foi descartado.

| Verificação                      | Resultado                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Fonte                            | snapshot protegido `NETVISION-N8N-RC712-PUBLISHED-VERIFIED.json` (`c3b8b470…`)                                         |
| Workflow / activeVersionId       | `SVh8Z-zUcSzQYOOJZ-DKP` / `6a97fe4a-31ea-49e6-b892-1ac55f85d115` ✅                                                    |
| Nome da revisão                  | `RC7.1.2 - NetVision strict Telegram ACK` ✅                                                                           |
| Nós / arestas                    | 58 / 59 ✅                                                                                                             |
| Hash do grafo (método do leitor) | `60af8761…5870` = medido **ao vivo** em 29/10 e 30/10 ✅                                                               |
| Candidato: nós / arestas         | 58 / 59; hash `5c76e866…5154`; arquivo `85e8b071…ce6c` (base rascunho `1f1405f8`, ver docs/n8n/RC7.1.2-PREFIXOS.md §0) |
| Diferença                        | **somente** `Normalizar Evento OUT.parameters.jsonOutput` (2 inserções)                                                |
| Credenciais                      | 6 referências reais (id/nome) preservadas; nenhum valor; sem placeholder                                               |
| Prova                            | candidato − delta → hash `60af8761…` exato (teste)                                                                     |

Artefatos: `docs/n8n/GMJ-NetVision-Telegram-RC7.1.2-PREFIXOS.json`,
`docs/n8n/RC7.1.2-PREFIXOS-NORMALIZER.diff`, `docs/n8n/RC7.1.2-PREFIXOS-MANIFEST.json`,
gerador `tools/n8n/build-rc712.py`, procedimento em `docs/n8n/RC7.1.2-PREFIXOS.md`.

**Limitação:** o acesso ao host n8n (`179.189.80.25`) não foi autorizado nesta missão; a
identidade foi conferida pelo snapshot + hash ao vivo de 29–30/10, não por nova leitura em 31/10.
O passo 1 da publicação exige reconferir `activeVersionId` e o hash antes do PATCH.

## 2. API

| Item                                       | Resultado                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| `4637696` ancestral de `228262b`/`bf7bc52` | ✅ (inclui `2beafda`, plano COMPUTIZE-only)                                   |
| Delta de runtime vs `4637696`              | 6 arquivos do contrato `prefixes`; **0** em `apps/api/prisma` (sem migration) |
| Delta de runtime `228262b` → `bf7bc52`     | nenhum (só testes, n8n, docs, rótulo do empacotador)                          |

### Leitura Huawei READ-ONLY (31/10 21:21Z)

`HuaweiBgpSshService.readReceivedRoutes` do `228262b`, executado em diretório temporário no
IMPLANTAR (removido em seguida), allowlist de **2** comandos, DB `default_transaction_read_only=on`:

- `screen-length 0 temporary` (só sessão) + `display bgp routing-table peer 10.200.201.2 received`;
- `Total Number of Routes: 3`; parser: 3 rotas, next-hop `10.200.201.2`, `warnings: []`;
- seletor → `167.250.126.0/23`, `167.250.126.0/24`, `167.250.127.0/24` (com e sem localAs).

A transcrição integral da sessão (banner + `quit`) agora é fixture de regressão:
`docs/evidence/aglink-received-routes-readonly-20261031.json`.

### Pacote Linux API-only

| Item                                                                         | SHA256                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `netvision-single-pilot-api-bf7bc527a94681b2f40e5d0d9f4b6daa329b4f59.tar.gz` | `585ed6ef2db7451075fb26e072a5bc5e666bf600e7a24e899f0970031eca5e7d` |
| source.tar (`git archive bf7bc52`)                                           | `97c5cf6da193b5b82c7a5cf91e8c18b54165ae04e62599f379d63023159b3a01` |
| `dist/server.cjs`                                                            | `09b12192d7ff1ba5ad625b823b2d4d8d1d4caacf8d906d4ca6819ddfaa0df634` |
| `dist/server.cjs.map`                                                        | `110ced01414c1a5d7ffdcf2467716502a2009da1ad9fd0cd40a0237a970f3bcd` |
| `catalog/physical-catalog-v1.yaml`                                           | `2a255fc270755c3511637b5763b859335ad1f574929625f461e01f674b143d64` |
| `artifact-manifest.json`                                                     | `e2c5057096c9cd18edcffccfc42f5e826d6054484e5d60a6e400a5dadcbbfacf` |

Builder `sha256:622f209f…` (node 24.19.0 bookworm), build e tar **reproduzidos** duas vezes,
10.070 arquivos, sem `.env`. Manifesto em `docs/evidence/api-package-bf7bc52-artifact-manifest.json`.

## 3. Testes executados

| Suíte                                        | Resultado                                                                                                                                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API completa (vitest)                        | **2697 passed / 39 skipped / 0 failed**                                                                                                                                                  |
| `mitigation-workflow-rc712.test.ts`          | 16 ✅ (hash, credenciais, webhooks, 3 prefixos, `null`, evento antigo byte-a-byte, itens inválidos, HTML, retry, simulação, detecção, ACK estrito, REMOVE confirm/execute/chat estranho) |
| `mitigation-scope-prefixes.test.ts`          | 16 ✅ (inclui captura real)                                                                                                                                                              |
| `tsc --noEmit` / eslint / `git diff --check` | 0 / 0 / limpo                                                                                                                                                                            |
| Smoke isolado (`--network none`, DEMO)       | sha do pacote OK, manifesto 10.070/0 divergências, `/health` `ok`, 0 linhas de erro                                                                                                      |

Limitações: n8n não executado dinamicamente (nós avaliados em sandbox JS); retry da outbox coberto
pelos testes da API, não por n8n real; smoke sem PostgreSQL/Huawei/n8n por desenho.

## 4. Publicação (cada etapa com autorização própria)

1. **API:** instalar o pacote como release nova ao lado de `4637696`, preservando EnvironmentFiles,
   flags AUTO=0 e drop-ins; sem migration. Restart planejado só na janela aprovada; health e
   `SOURCE_SHA=bf7bc52`.
2. **n8n:** reconferir `activeVersionId 6a97fe4a…` + hash `60af8761…`; backup; `PATCH` só de
   `nodes`/`connections`; GET (hash `5c76e866…`); `activate`; conferir.

## 5. Rollback

- **API:** apontar de volta para a release `463769620a2f…` (mesmo procedimento de rollback de 31/10),
  restart autorizado, health. Campo `prefixes` é aditivo: o n8n candidato mostra `indisponível`.
- **n8n:** reativar a versão `6a97fe4a…` do histórico (ou PATCH do snapshot + activate); hash `60af8761…`.
  Independente da API.

**Parado após preparar os artefatos.**
