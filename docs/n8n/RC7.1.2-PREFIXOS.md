# n8n RC7.1.2 + prefixos — candidato derivado da versão PUBLICADA

**Status: PREPARADO. NÃO PUBLICADO.** Nenhum n8n, Telegram ou webhook real foi
acionado.

| Item                 | Valor                                                                         |
| -------------------- | ----------------------------------------------------------------------------- |
| Candidato            | `docs/n8n/GMJ-NetVision-Telegram-RC7.1.2-PREFIXOS.json`                       |
| Diff                 | `docs/n8n/RC7.1.2-PREFIXOS-NORMALIZER.diff`                                   |
| Manifesto/hashes     | `docs/n8n/RC7.1.2-PREFIXOS-MANIFEST.json`                                     |
| Gerador              | `python -I tools/n8n/build-rc712.py <snapshot-publicado.json>`                |
| Workflow             | `SVh8Z-zUcSzQYOOJZ-DKP` (nome global preservado)                              |
| Base                 | activeVersion **`6a97fe4a-31ea-49e6-b892-1ac55f85d115`**, 58 nós / 59 arestas |
| Hash grafo base      | `60af87618b6bfd2e1cf1678a16a769062151fa4ec320126fdb5498e3ee385870`            |
| Hash grafo candidato | `92b5ea7fd646ac827254eb0c09c26524732ac62188b12656d0c886827834ae6f`            |

> A versão anterior deste arquivo partia do RC7.1 (56 nós). Publicá-la teria
> **removido** `Somente Status Mitigacao RC712?` / `Telegram - Status Mitigacao RC712`
> e revertido 15 nós do RC7.1.2 (ACK estrito, webhooks, alarmes). Foi descartada.

## 1. Origem da base

Snapshot somente leitura `NETVISION-N8N-RC712-PUBLISHED-VERIFIED.json`
(sha256 `c3b8b470…7257e`, registrado na publicação de 29/10), mantido fora do Git.
O gerador recusa a base se `id`, `activeVersionId`, `activeVersion.versionId`,
58/59 ou o hash do grafo divergirem. O hash `60af8761…` é o mesmo medido **ao vivo**
no `workflow_history` em 29/10 e 30/10 (`json.dumps({nodes, connections}, sort_keys=True)`).

## 2. O que muda — só `Normalizar Evento OUT.parameters.jsonOutput`

Duas inserções (ver `.diff`):

1. após `Peer principal`, na mensagem de mitigação verificada: bloco
   `Prefixos (N):` + um `• prefixo` por linha, ou `Prefixos: indisponível`;
2. na saída: `PREFIXOS` (array) e `QTD_PREFIXOS` (number).

Nós, ids, posições, credenciais (ids/nomes reais, sem valores), webhooks,
`webhookId`, callbacks REMOVE, ACK estrito, ramo S5/detecção, REENVIO v2 e
conexões: **idênticos**. Prova: retirar as duas inserções devolve exatamente o
hash `60af8761…` (teste `mitigation-workflow-rc712.test.ts`).

Topo do arquivo: `id`, `name`, `nodes`, `connections`, `settings`, `meta`, `tags`,
`pinData: {}`, `active: false`. Fora: `shared`, `scopes`, `activeVersion`,
`staticData`, `checksum`, `versionId`, contadores e datas.

## 3. Publicação (autorização separada)

Pré-requisito: API com `prefixes` publicada antes (senão a linha mostra
`indisponível`, sem erro).

1. Leitura: `activeVersionId` ainda `6a97fe4a…` e hash do grafo ativo `60af8761…`.
   Se divergir, **parar** e regenerar a partir do novo snapshot.
2. Backup do workflow atual (GET autenticado do editor).
3. `PATCH /rest/workflows/SVh8Z-zUcSzQYOOJZ-DKP` com **somente** `nodes` +
   `connections` do candidato + `expectedChecksum` (mesmo método de 29/10, sem CLI,
   sem PUT público, sem restart).
4. GET do rascunho: hash do grafo `92b5ea7f…`, `activeVersionId` ainda `6a97fe4a…`.
5. `POST …/activate` com o `versionId` do rascunho. Conferir novo `activeVersionId`
   e hash ativo `92b5ea7f…`.
6. Homologação real só com mitigação real autorizada.

## 4. Rollback

Republicar a versão `6a97fe4a-31ea-49e6-b892-1ac55f85d115` pelo histórico do
workflow (ativar o versionId anterior) ou PATCH dos `nodes`/`connections` do
snapshot protegido + activate. Conferir hash ativo `60af8761…`. Independente do
rollback da API (campo aditivo).
