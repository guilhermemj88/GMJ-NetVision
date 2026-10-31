# Encerramento do incidente n8n — verificação READ-ONLY

**Data:** 2026-10-31 (UTC)
**Host n8n:** `179.189.80.25` (`automacao.gmjtelecom.com.br`), container `n8n` = `n8nio/n8n:2.4.4`
**Workflow afetado:** `SVh8Z-zUcSzQYOOJZ-DKP` — *GMJ NetVision - Mitigacao DDoS - RC7.1.1 REVIEW-08 (fallback de grafico)*
**Escopo desta missão:** exclusivamente leitura na produção. Nenhum `PUT`/`PATCH`/`POST`/`DELETE`, nenhum SQL mutante, nenhum restart de serviço, nenhuma credencial alterada, nenhum Telegram real, nenhuma alteração em Huawei/NetVision, AUTO não habilitado.

Referência do incidente: [`RELATORIO-INCIDENTE-N8N-DELETE-E-RESTAURACAO.md`](RELATORIO-INCIDENTE-N8N-DELETE-E-RESTAURACAO.md).

---

## 1. Estado do workflow restaurado

| Item | Valor |
|---|---|
| `id` | `SVh8Z-zUcSzQYOOJZ-DKP` |
| `active` | `1` |
| `versionId` (draft) | `1f1405f8-e9bc-4d2e-91bc-4106dbb07285` |
| `activeVersionId` | `6a97fe4a-31ea-49e6-b892-1ac55f85d115` |
| `versionCounter` | `332` |
| `isArchived` | `0` |
| Nós / conexões | 58 / 59 |
| Hash do grafo (draft) | `6bc74d79b499c68ac20c1fd273f75bd17bec3eae51694de29ac5d2b560bf9d23` |
| Hash do grafo (ativo) | `60af87618b6bfd2e1cf1678a16a769062151fa4ec320126fdb5498e3ee385870` |
| Workflows na instância | 24 |

`workflow_history` do workflow:

| versionId | nome | createdAt | len(nodes) |
|---|---|---|---|
| `6a97fe4a-…85d115` | `RC7.1.2 - NetVision strict Telegram ACK` | 2026-10-29 18:19:33.471 | 75 287 |
| `1f1405f8-…b07285` | *(null)* | 2026-10-29 18:21:39.441 | 75 291 |

**6 referências de credencial** idênticas entre draft e ativo: `Header Auth account`, `Header Auth account FIBINET`, `Header Auth account NetVision Alarmes`, `Header Auth account NetVision Mitigacao OUT`, `Header Auth account VNT`, `Telegram gmjflow_bot`.

**Webhooks registrados** (`webhook_entity`, 5 linhas):

| path | método | node |
|---|---|---|
| `netvision-mitigation` | POST | Webhook NetVision OUT |
| `5d4b610d-7fbb-49e7-9e8e-6149072f5a90/webhook` | POST | Telegram Trigger - Callback |
| `netvision-alarmes` | POST | Webhook NetVision Alarmes |
| `netvision-alarmes-vnt` | POST | Webhook NetVision Alarmes - VNT |
| `netvision-alarmes-fibinet` | POST | Webhook NetVision Alarmes - Fibinet |

Produção estável desde a restauração: `started=2026-10-31T23:30:30Z`, `RestartCount=0`, `OOMKilled=false`, política `unless-stopped`.

---

## 2. Janela 23:29–23:31 UTC — webhooks e logs

**Indisponibilidade medida**

| Evento | Timestamp |
|---|---|
| `SIGTERM` (parada para restauração) | 23:29:44.874 |
| n8n inicializado | 23:30:37.343 |
| `n8n ready` | 23:30:38.381 |
| `Activated workflow "…" (ID: SVh8Z-zUcSzQYOOJZ-DKP)` | 23:30:52.763 |

Downtime de processo ≈ 54 s; webhooks do workflow voltaram a ficar registrados ≈ 68 s após o SIGTERM.

**Verificação de tráfego na janela**

| Verificação | Resultado |
|---|---|
| Linhas de log com os 4 caminhos de webhook | **0** |
| `unknown webhook` para os 4 caminhos | **0** |
| `unknown webhook` na janela | presente apenas para ruído pré-existente (`POST zabbix`, `fc117bf5…`, `test`, `GET test/contact/submit`) |
| Execuções (`execution_entity`) na janela | **0** |
| Erros novos no log | **0** (apenas o ruído pré-existente de `X-Forwarded-For` ValidationError) |

**Distinção exigida "registrado" × "entrega comprovada":**

- *Registrado*: comprovado — 5 linhas em `webhook_entity` e linha de boot `Activated workflow`.
- *Entrega/processamento comprovado*: **nenhum** na janela. Não houve requisição HTTP para nenhum dos quatro caminhos.

---

## 3. Eventos perdidos na janela

| Fonte | Janela consultada | Resultado |
|---|---|---|
| `MediaDeliveryLog` (API NetVision) | 23:20–23:40 UTC | **0** registros (198 no total, última entrega 2026-10-30 14:10 UTC) |
| `MitigationAutomationRecord` | idem | **vazio** |
| Journal da API NetVision | 23:28–23:33 UTC | **0** menções a webhook / media / delivery / n8n |

**Conclusão:** não houve evento perdido. Nenhuma tentativa de entrega ocorreu durante a indisponibilidade; o silêncio é ausência de eventos, não falha de entrega.

---

## 4. Backups anteriores ao incidente e tentativa de recuperação do histórico

**Inventário**

| Artefato | Tamanho | Conteúdo | Serve para recuperar histórico? |
|---|---|---|---|
| `/root/n8n-backup-20261031T232818Z.json` | 169 627 B (sha256 `214ad4fb…1045e`) | JSON do workflow imediatamente antes do DELETE | **Não** — carrega só grafo (nodes/connections), sem histórico |
| `/root/backup_n8n_2026-01-22/database.sqlite` | 455 MB | 9 workflows, último update 2026-01-22 18:21 | **Não** — o workflow foi criado em 2026-09-29, não existe nesse backup |
| `/root/n8n_backup.tgz` | 48.7 MB | arquivo de 2026-01-24 | **Não** — mesma época, anterior ao workflow |
| `/root/n8n-pre-restore-20261031T232944Z/` | 1.32 GB + WAL 10.9 MB | cópia do DB feita **após** o DELETE, com o container parado (md5 `6fb6507cca01f5d1b026357c6b2d98d1`) | Avaliado — ver abaixo |

**Tentativa em ambiente isolado (a cópia, nunca o banco produtivo)**

- `sqlite3 ".recover"` na cópia: **22 543 linhas** reconstruídas (o utilitário funciona — um workflow existente aparece 10 604 vezes), mas **0 linhas** contendo `SVh8Z-zUcSzQYOOJZ-DKP`.
- Varredura de bytes crus na mesma cópia: **500 ocorrências** do `workflowId`; **224** com `"nodes":` a ≤ 30 KB; **184** com a assinatura completa de `workflow_history` (`nodes` + `connections` + `createdAt`); 156 ocorrências de `"name":"Normalizar Evento OUT"`; 1 ocorrência de `RC7.1.2 - NetVision strict Telegram ACK`.
- Amostragem de contexto confirma fragmentos íntegros e legíveis de `webhook_entity` (ex.: `netvision-alarmes-fibinet` / `POST` / `Webhook NetVision Alarmes - Fibinet`) e de `workflow_statistics`.

**Conclusão:** os bytes das linhas excluídas sobrevivem em **buracos de células dentro de páginas alocadas**, situação em que o `.recover` não os enumera (ele reconstrói apenas células vivas e páginas da freelist). A recuperação exigiria *carving* manual de páginas b-tree — fora do ferramental homologado e sem garantia de reconstrução de linha. **Não recomendado.** Nenhuma alteração foi feita no banco produtivo.

> **Achado de segurança:** o conteúdo do workflow excluído permanece fisicamente no arquivo do banco ativo. O arquivo deve ser tratado como material sensível e o descarte da cópia forense, quando autorizado, deve ser definitivo.

---

## 5. Backup consistente do estado restaurado

| Item | Valor |
|---|---|
| Arquivo | `/root/n8n-restored-20261031T233741Z.sqlite` |
| Tamanho | 1 323 446 272 B (página a página igual à origem) |
| sha256 | `0f56f7902530469135e8bf8788b344696ecc915b57eb04c6333628f6d4af52ee` |
| Método | `.backup` a partir de conexão **read-only** (`file:…?mode=ro`) — produção não parada, não alterada |
| `PRAGMA integrity_check` | `ok` |
| `PRAGMA foreign_key_check` | 0 linhas |
| Conteúdo | 24 workflows · histórico 2 do workflow · webhooks 5 · shared 1 · `workflow_publish_history` 1 (id 168) |

**Recuperabilidade: sim.** É um SQLite completo e íntegro; a restauração consiste em parar o container `n8n`, substituir `/storage/n8n-data/database.sqlite` (removendo `-wal`/`-shm`) e iniciar novamente. Não executado nesta missão.

---

## 6. Limitações da recuperação por SQL direto

| Perda | Situação | Recuperável? |
|---|---|---|
| Versões antigas de `workflow_history` | restaram só a ativa (`6a97fe4a`) e o draft (`1f1405f8`) | Não — nenhum backup as contém; carve não é confiável |
| `workflow_publish_history` ids **149–167** (19 registros) | restaurado apenas o id 168 | Não |
| `execution_entity` do workflow | removidas por CASCADE | Não |
| `workflow_statistics` | zeradas | Só fragmentos crus |
| `workflow_history` do draft: `name` / `description` | `NULL` (o JSON exportado não carrega esses metadados) | Não |
| Grafo (nodes/connections), `activeVersionId`, `shared_workflow`, `webhook_entity`, `versionCounter` | integralmente restaurados | — |

Nenhum desses itens pode ser reconstruído a partir de JSON exportado: o export carrega o grafo, não o histórico de versões, execuções ou estatísticas.

---

## 7. Proposta de atualização pelo editor oficial (somente `Normalizar Evento OUT`)

Motivo: a API pública do n8n 2.4.4 **não oferece `PATCH`** (`405`) em `/api/v1/workflows/{id}`; o caminho suportado e seguro é o editor.

**Pré-requisitos**
1. Sessão autenticada no editor (`https://<host>` via Traefik), usuário com permissão de edição/publicação no projeto do workflow.
2. Backup recém-gerado do estado atual (usar o procedimento do item 5).
3. Nenhuma automação publicando no mesmo workflow durante a janela.

**Procedimento**
1. Abrir `SVh8Z-zUcSzQYOOJZ-DKP` no editor. Confirmar que o rascunho exibido é `versionId = 1f1405f8…` (hash `6bc74d79…`).
2. Abrir **apenas** o nó `Normalizar Evento OUT` (tipo `n8n-nodes-base.set`, `typeVersion 3.4`, `mode: raw`).
3. Substituir integralmente o campo `jsonOutput` pelo conteúdo de [`docs/n8n/RC7.1.2-PREFIXOS-NORMALIZER-AFTER.txt`](docs/n8n/RC7.1.2-PREFIXOS-NORMALIZER-AFTER.txt) — versão *after*, sha256 `0b5e2984bda50c36bb68f7b625615e844d6f87cfbc9632f8c99c64d933573be4`, idêntico ao valor armazenado no nó. O arquivo preserva o prefixo `=` de expressão do n8n e as duas primeiras linhas (`=`, `{{`) exatamente como o campo as guarda: **colar o conteúdo inteiro do arquivo, sem editar**. O diff correspondente está em [`docs/n8n/RC7.1.2-PREFIXOS-NORMALIZER.diff`](docs/n8n/RC7.1.2-PREFIXOS-NORMALIZER.diff).
4. **Salvar** (cria/altera o rascunho). Nenhum outro nó, conexão, posição, expressão ou credencial deve ser tocado.
5. Conferir o rascunho salvo: 58 nós / 59 conexões e hash de grafo `5c76e86618ada3b73d2c2aabf974a8b1fdaf7c24a12813711f93b3a11b5b5154` (inclui, por decisão de escopo adotada, as 2 diferenças de posição já presentes no rascunho: `Somente Status Mitigacao RC712?` e `Telegram - Status Mitigacao RC712`).
6. **Publicar** no editor. Verificar que `activeVersionId` deixou de ser `6a97fe4a…` e que o grafo da versão ativa tem hash `5c76e866…`.
7. Reexecutar a reconciliação read-only (`deploy/aglink-prefixes-bf7bc52/n8n-readonly-reconcile.py`) e anexar a saída como evidência.

**Rollback (no editor):** republicar a versão `6a97fe4a…` — grafo ativo volta a `60af8761…`. Em último caso, restaurar o backup do item 5 com o container parado.

**Proibições mantidas:** nada de `PUT`/`DELETE` na API pública, nada de SQL mutante, nada de reinício de serviço para publicar.

---

## 8. Demonstração em ambiente isolado (n8n 2.4.4)

Instância descartável, sem relação com produção: `docker run --name n8n-rc712-test -p 127.0.0.1:5688:5678 -v <volume isolado> n8nio/n8n:2.4.4`, sem labels do Traefik. **Nenhum endpoint mutante de produção foi acessado** (porta 5678 de produção nunca tocada). Container e volume removidos ao final.

**Fidelidade de importação**

| Verificação | Resultado |
|---|---|
| Import de `docs/n8n/GMJ-NetVision-Telegram-RC7.1.2-PREFIXOS.json` (sha256 `85e8b071…`) | ok |
| Nós após import | 58 |
| Hash do grafo após import | `5c76e86618ada3b73d2c2aabf974a8b1fdaf7c24a12813711f93b3a11b5b5154` — **idêntico ao manifesto** |

**Execução real do normalizador** (workflow de teste `Webhook → Normalizar Evento OUT`, com o `jsonOutput` copiado byte a byte do candidato)

| Caso | Entrada | `PREFIXOS` | `QTD_PREFIXOS` | Linha no `telegramText` |
|---|---|---|---|---|
| A | `prefixes: ["167.250.126.0/23","167.250.126.0/24","167.250.127.0/24"]` | 3 itens | 3 | `<b>Prefixos (3):</b>` + 3 bullets |
| B | evento anterior, campo `prefixes` ausente | `[]` | 0 | `<b>Prefixos:</b> <i>indisponível</i>` |
| C | `prefixes: []` (readback parcial) | `[]` | 0 | `<b>Prefixos:</b> <i>indisponível</i>` |

Fail-closed observado nas validações do adaptador: `IDENTITY_INVALID` sem `profileId`; `ACTIVATION_UNVERIFIED_OR_SCOPE_INVALID` sem `bogonNode`/`mitigationNode`/`addressFamily` em caixa alta. Só com o escopo completo vem `RC712_VALID=true`, `RC712_ROUTE=ACTIVATED`.

**Descobertas operacionais relevantes**
- Em 2.4.4 o CLI não tem mais `update:workflow --active`; a mensagem é explícita: *"Please use: publish:workflow --id=…"*.
- Após publicar por CLI é necessário reiniciar o container para o webhook de produção ser registrado — mesma mecânica que explica a janela de indisponibilidade do incidente.

---

## 9. Recomendação sobre a API key

| Campo | Valor |
|---|---|
| `id` | `h7LjVLsx9tnzXsYJ` |
| `label` | `deepseek` |
| criada | 2026-10-31 23:26:14.758 UTC |
| escopos | 43, incluindo **`workflow:delete`**, `workflow:activate`, `workflow:deactivate`, `workflow:create`, `workflow:update`, `credential:create/update/delete/move`, `user:create/delete/changeRole/enforceMfa`, `project:*`, `variable:*`, `execution:delete`, `execution:retry`, `securityAudit:generate`, `sourceControl:pull` |

`workflow:delete` presente é a causa direta do incidente: a sondagem de métodos resultou em `DELETE` aceito (HTTP 200).

**Recomendação (não executada nesta missão):** revogar esta chave e, se houver necessidade operacional, recriar com escopo mínimo de leitura — `workflow:read`, `workflow:list`, `execution:read`, `execution:list` — sem `workflow:delete`, `workflow:activate`/`deactivate`, `credential:*`, `user:*`, `project:*` e `variable:*`. O n8n armazena apenas o hash da chave; o texto não é recuperável do banco.

---

## Riscos residuais

1. Conteúdo do workflow excluído continua fisicamente no arquivo do banco ativo (item 4) — tratar como sensível.
2. Cópia forense de 1.32 GB em `/root` (host com 3.2 GB livres em `/`). Retenção a decidir; a remoção deve ser definitiva.
3. Publicação dos prefixos permanece **suspensa**; o workflow segue com rascunho (`1f1405f8…`) à frente da versão ativa (`6a97fe4a…`).
4. API key ampla ainda válida até revogação.
5. Histórico de versões, execuções, estatísticas e 19 registros de publicação são perda definitiva.

## Confirmação de não-alteração

Nenhum `PUT`/`PATCH`/`POST`/`DELETE` em produção · nenhum SQL mutante no banco produtivo · nenhum restart de serviço de produção · nenhuma credencial alterada · nenhum Telegram real · nenhuma alteração em Huawei, NetVision, VNT ou Fibinet · AUTO não habilitado · nenhum deploy nem push.
