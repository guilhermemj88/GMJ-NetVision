# Fechamento n8n RC7.1.2 — logs do incidente e procedimento do normalizador

**Data:** 2026-11-01 · **Produção:** READ-ONLY (nada publicado, editado, reiniciado ou alterado)
**Host n8n:** `179.189.80.25` · container `n8n` (`n8nio/n8n:2.4.4`) · volume de dados `/storage/n8n-data`
**Workflow:** `SVh8Z-zUcSzQYOOJZ-DKP`

Referências: [`RELATORIO-ENCERRAMENTO-INCIDENTE-N8N-READONLY.md`](RELATORIO-ENCERRAMENTO-INCIDENTE-N8N-READONLY.md) · [`RELATORIO-INCIDENTE-N8N-DELETE-E-RESTAURACAO.md`](RELATORIO-INCIDENTE-N8N-DELETE-E-RESTAURACAO.md)

---

# TAREFA 1 — Logs do incidente (31/10/2026, 23:28–23:32 UTC)

## 1.1 Período real de indisponibilidade

| Marco | Timestamp UTC | Fonte |
|---|---|---|
| Último snapshot pré-DELETE | `23:28:18.633` | mtime de `/root/n8n-backup-20261031T232818Z.json` (169 627 B) |
| **DELETE** | entre `23:28:18.633` e `23:29:44.874` | ver limitação 1.5-A |
| `SIGTERM` (parada para restauração) | `23:29:44.874` | log do container |
| `n8n ready` | `23:30:38.381` | log do container |
| Workflow reativado | `23:30:52.763` | `Activated workflow "…" (ID: SVh8Z-…)` |
| Estado atual | `started=23:30:30`, `RestartCount=0` | `docker inspect` |

- Processo fora do ar: **53,5 s**
- Workflow inativo (pior caso, a partir do DELETE): **154,1 s**
- Workflow inativo (melhor caso, a partir do SIGTERM): **68,0 s**

## 1.2 Evidência positiva de que nada chegou

O Traefik grava access log em arquivo (`/storage/traefik-app/logs/access.log`, 121 MB, timestamps em **UTC**), portanto a janela é auditável mesmo durante a indisponibilidade do n8n — uma requisição recusada apareceria como `502` **e** deixaria linha no `error.log`.

| Verificação (23:20–23:40 UTC) | Resultado |
|---|---|
| Linhas de access log na janela | 331 |
| `POST /webhook/netvision-mitigation` | **0** |
| `POST /webhook/netvision-alarmes` | **0** |
| `POST /webhook/netvision-alarmes-vnt` | **0** |
| `POST /webhook/netvision-alarmes-fibinet` | **0** |
| `POST /webhook/5d4b610d-…/webhook` (callback Telegram) | **0** |
| Linhas no `error.log` do Traefik na janela (502/504/connection refused) | **0** |
| Execuções no n8n na janela | **0** |

**Todo o tráfego dirigido ao n8n na janela:**

| Hora | Origem | Requisição | Status |
|---|---|---|---|
| 23:28:03 (×2) | 186.232.160.198 (host NetVision) | `POST /webhook/zabbix` | 404 |
| 23:31:04 | 186.232.160.198 | `POST /webhook/zabbix` | 404 |
| 23:31:40 / 23:32–23:33 | 192.168.250.229 (UI do editor) | `/rest/*`, ícones, telemetria | 200/304 |
| 23:34:03, 23:37:03, 23:39:15 | 186.232.160.198 | `POST /webhook/zabbix` | 404 |

`/webhook/zabbix` **nunca** foi uma rota registrada — 37 627 ocorrências no arquivo, com 404 em todo o histórico (inclusive 04h, 05h e dias anteriores). Não é efeito do incidente.

## 1.3 Emissores

| Emissor | Fonte consultada | Resultado |
|---|---|---|
| NetVision API (IMPLANTAR) | `journalctl -u netvision-api`, 23:20–23:40 | 30 linhas, **todas** heartbeat `windowSeconds` (23:27:33, 23:28:27, 23:29:27, 23:30:27, 23:31:27, 23:32:49, 23:37:53) + 2 linhas de health check às 23:31:48. **Zero** menções a n8n/webhook/delivery. |
| NetVision (cadência real) | access log Traefik, 31/10 | Webhooks NetVision dispararam **apenas** nas horas 04 e 05 UTC (8 requisições). Entre **22:00 e 00:30 UTC: 0**. |
| VNT / Fibinet | mesma origem (186.232.160.198) | Nenhuma requisição a `netvision-alarmes-vnt` / `-fibinet` na janela |
| `gmj-monitor-fibinet` | `docker logs`, 20:26–20:35 local | **0** linhas no período |
| Base de entregas | `MediaDeliveryLog` | 0 linhas em 23:20–23:40 (198 no total; última entrega 30/10 14:10 UTC) |

Os heartbeats a cada ~60 s **durante** toda a janela provam que o processo da API estava vivo e escrevendo em journal — logo a ausência de linhas de entrega é um fato observado, e não uma lacuna de log.

## 1.4 Conclusão objetiva

**Não há evidência de qualquer evento perdido — e há evidência positiva de que nenhuma requisição chegou aos quatro webhooks nem ao callback do Telegram durante toda a janela, inclusive nos 154 s de exposição máxima.**

A conclusão não se apoia em "ausência de erro": apoia-se em (a) access log do proxy cobrindo 100% da janela, (b) `error.log` sem nenhuma falha de conexão, (c) journal do emissor comprovadamente ativo e sem tentativa de entrega, (d) cadência real dos webhooks nula no período, (e) tabela de entregas vazia na janela.

## 1.5 Limitações declaradas

| # | Limitação | Impacto |
|---|---|---|
| A | O instante exato do DELETE não é registrável: as chamadas à API foram diretas ao IP do container (`10.249.0.3:5678`), fora do Traefik; o n8n não loga mutações de API em nível `info`; e `docker events` não reteve eventos dessa janela. | Intervalo provado de 86,241 s entre o snapshot e o `SIGTERM`. Não afeta a conclusão de 1.4. |
| B | Se um emissor tivesse falhado **antes** de atingir o Traefik (DNS/TCP/timeout local), não haveria linha de access log. | Coberto pelo journal da API NetVision, que não mostra nenhuma tentativa de entrega no período. |
| C | Não é possível provar o que o Telegram *tentou*; prova-se o que **chegou**. | Nenhum callback era esperado: não havia mensagem com botões ativa no período. |
| D | A cópia forense teve o WAL checkpointado ao ser aberta às 23:36:12 (consequência da análise anterior). | O artefato `-wal` isolado deixou de existir; o conteúdo foi incorporado ao arquivo principal, sem perda de dados. |

---

# TAREFA 2 — Procedimento do normalizador (validado em n8n 2.4.4 descartável)

## 2.1 Base reconstruída e verificada

| Item | Valor |
|---|---|
| Normalizador **BEFORE** (reconstruído a partir do diff) | 17 652 B · sha256 `b2894a5f32fd0577c9da83061da7567114cd81dfcc3ca7796ad6bb4b58697ee5` — **igual ao manifesto** |
| Normalizador **AFTER** (candidato) | 18 381 B · sha256 `0b5e2984bda50c36bb68f7b625615e844d6f87cfbc9632f8c99c64d933573be4` — **igual ao manifesto** |
| Delta | +729 B, dois trechos (bloco de `scopePrefixes` e as 2 chaves `PREFIXOS`/`QTD_PREFIXOS`) |

**Prova de que o rascunho de produção é a base correta:** o workflow montado com o normalizador BEFORE tem 58 nós / 42 chaves / 59 arestas e hash de grafo
`6bc74d79b499c68ac20c1fd273f75bd17bec3eae51694de29ac5d2b560bf9d23` — **idêntico ao rascunho ativo em produção** (`1f1405f8…`). Ou seja: os dois deslocamentos visuais do rascunho (`Somente Status Mitigacao RC712?` e `Telegram - Status Mitigacao RC712`) já estão nele e são preservados.

**Comparação estrutural candidato × base:** apenas **1 nó** difere (`Normalizar Evento OUT`); as **conexões são byte-idênticas**; os 6 nós de ACK/REMOVE/status permanecem intactos:
`Telegram Trigger - Callback`, `Interpretar Callback`, `IF - Callback de Escopo?`, `Telegram - ACK Escopo`, `Somente Status Mitigacao RC712?`, `Telegram - Status Mitigacao RC712`.

## 2.2 Semântica do marcador `=` (testada, não presumida)

O valor armazenado no campo `jsonOutput` é `=` + quebra de linha + `{{…}}` (18 381 B). Testei as três formas plausíveis de colagem numa instância `n8nio/n8n:2.4.4` descartável:

| Variante | Valor armazenado | Bytes | Comportamento em 2.4.4 | Hash de grafo |
|---|---|---|---|---|
| **T1 — expressão, colando o arquivo sem o `=` inicial** | `=\n{{…}}` | 18 381 | **correto**: objeto JSON com `PREFIXOS` | **`5c76e866…`** ✅ (candidato) |
| T2 — colar o arquivo inteiro em modo expressão | `==\n{{…}}` | 18 382 | executa (o `=` extra é tolerado), mas o valor armazenado muda | `≠ 5c76e866…` ❌ |
| T3 — colar sem `=` (campo em modo fixo) | `\n{{…}}` | 18 380 | **HTTP 500 / execução com erro** (o texto vira literal; `JSON.parse` falha) | ❌ |

**Conclusão:** o campo precisa permanecer em **modo Expressão**, e o texto colado deve ser o arquivo **sem o primeiro caractere `=`** — ou seja, começando por uma linha vazia e depois `{{`.

## 2.3 Comportamento funcional (BEFORE × AFTER, mesma carga)

| Caso | BEFORE (base) | AFTER (candidato) |
|---|---|---|
| `MITIGATION_VERIFIED` com 3 prefixos AGLINK | `ROUTE=ACTIVATED`, sem bloco de prefixos | `ROUTE=ACTIVATED`, `PREFIXOS` 3 itens, `QTD_PREFIXOS=3` |
| `MITIGATION_VERIFIED` sem o campo `prefixes` | `ROUTE=ACTIVATED`, sem bloco | `PREFIXOS=[]`, `QTD=0`, `<b>Prefixos:</b> <i>indisponível</i>` |
| `MITIGATION_VERIFIED` com `prefixes: []` | idem | `PREFIXOS=[]`, `QTD=0`, mesmo fallback |
| `MITIGATION_STATUS_RESEND` (ACK/status) | `RESEND_READBACK_REQUIRED` | **`RESEND_READBACK_REQUIRED`** (idêntico) |

Mensagem gerada com os três prefixos da AGLINK:

```
<b>Prefixos (3):</b>
• 167.250.126.0/23
• 167.250.126.0/24
• 167.250.127.0/24
```

A única diferença funcional entre base e candidato é o bloco de prefixos na mensagem de ativação; o caminho de status/ACK responde de forma idêntica e o caminho de REMOVE não foi tocado (nenhum nó alterado, nenhuma conexão alterada).

## 2.4 Procedimento exato de publicação pelo editor

Pré-requisitos: backup do estado atual; nenhum outro editor aberto no workflow; janela curta sem campanha de alarmes.

1. Abrir `SVh8Z-zUcSzQYOOJZ-DKP` e confirmar que o rascunho é `1f1405f8-e9bc-4d2e-91bc-4106dbb07285` (hash `6bc74d79…`).
2. Abrir **somente** o nó `Normalizar Evento OUT` (tipo `n8n-nodes-base.set`, `typeVersion 3.4`, modo `raw`).
3. No campo **JSON Output**, manter o campo em **modo Expressão** (o `=` inicial pertence ao n8n e não aparece no texto).
4. Colar o conteúdo de [`docs/n8n/RC7.1.2-PREFIXOS-NORMALIZER-AFTER.txt`](docs/n8n/RC7.1.2-PREFIXOS-NORMALIZER-AFTER.txt) **apagando apenas o primeiro caractere `=`**. O texto colado começa com uma linha vazia e depois `{{`.
5. Salvar (sem publicar).
6. **Gate de hash:** o rascunho deve ficar com 58 nós / 59 conexões e hash de grafo
   `5c76e86618ada3b73d2c2aabf974a8b1fdaf7c24a12813711f93b3a11b5b5154`.
   Se não bater, **desfazer** e repetir o passo 4 (foi colado o `=` a mais, ou o campo não estava em expressão).
7. Publicar.
8. Verificar que `activeVersionId ≠ 6a97fe4a-31ea-49e6-b892-1ac55f85d115` e que o grafo da versão ativa tem hash `5c76e866…`.
9. Rodar `deploy/aglink-prefixes-bf7bc52/n8n-readonly-reconcile.py` e anexar a saída.

Nenhum outro nó, conexão, posição, expressão ou credencial deve ser tocado.

## 2.5 Hash final e critérios de rollback

| Estado | Hash esperado |
|---|---|
| Rascunho atual (pré-edição) | `6bc74d79b499c68ac20c1fd273f75bd17bec3eae51694de29ac5d2b560bf9d23` |
| **Publicado atual** | `60af87618b6bfd2e1cf1678a16a769062151fa4ec320126fdb5498e3ee385870` (versão `6a97fe4a…`) |
| **Rascunho após a edição = alvo da publicação** | **`5c76e86618ada3b73d2c2aabf974a8b1fdaf7c24a12813711f93b3a11b5b5154`** |

**Rollback**

1. **Editor (preferido):** republicar a versão `6a97fe4a-31ea-49e6-b892-1ac55f85d115` → grafo ativo volta a `60af8761…`.
2. **Reimportação do rascunho íntegro:** [`docs/n8n/PRE-EDIT-draft-de-producao.json`](docs/n8n/PRE-EDIT-draft-de-producao.json) — é exatamente o rascunho de produção (`6bc74d79…`), útil se o rascunho ficar inconsistente.
3. **Último recurso:** parar o container e restaurar `/root/n8n-restored-20261031T233741Z.sqlite` (sha256 `0f56f790…4af52ee`).

---

# GO / NO-GO

**GO condicionado** para a publicação manual pelo editor.

Condições obrigatórias:
1. backup recém-gerado antes de editar;
2. gate de hash `5c76e866…` conferido **no rascunho antes** de publicar e **na versão ativa depois**;
3. nenhum outro editor concorrente no workflow durante a edição;
4. nada de `PUT`/`PATCH`/`DELETE` na API pública (não há `PATCH`; só o editor é suportado);
5. rollback pronto (versão `6a97fe4a…` republicável).

Motivo do NO-GO automático: 2 modos de colagem falham (T2 gera hash diferente; T3 quebra o nó). Só a colagem sem o `=` inicial reproduz o candidato aprovado.

---

# Confirmação de não-alteração

Produção somente leitura: nenhum `PUT`/`PATCH`/`POST`/`DELETE` em `/api/v1` ou `/rest/`; nenhum SQL mutante; nenhum restart de serviço; nenhuma credencial alterada; nenhum Telegram real; nada alterado em Huawei, API NetVision, VNT, Fibinet ou flags AUTO; catálogo físico intocado; backups e evidências preservados.
Instância descartável `n8n-rc712-test` (`127.0.0.1:5688`) criada e **removida** ao final, junto com seus dados e temporários.
Estado final da produção: `SVh8Z-zUcSzQYOOJZ-DKP` `active=1`, `versionId=1f1405f8`, `activeVersionId=6a97fe4a`.
