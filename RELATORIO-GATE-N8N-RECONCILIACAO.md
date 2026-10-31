# GATE n8n — reconciliação READ-ONLY do workflow publicado + rascunho

**31/10/2026 23:23:13 UTC · host `automacao.gmjtelecom.com.br` (179.189.80.25) · n8n `n8nio/n8n:2.4.4`**
**Somente leitura: SQLite aberto em `mode=ro` + `PRAGMA query_only=ON`, nada escrito no n8n.**

> **Resultado: `GO_CANDIDATE_APPLIES`.** O candidato pode ser aplicado sem sobrescrever nada.
> Aguardando autorização separada para publicar.

---

## 1. Estado medido no n8n

| Item                        | Esperado                               | Medido                                                             | ✅  |
| --------------------------- | -------------------------------------- | ------------------------------------------------------------------ | --- |
| Workflow                    | `SVh8Z-zUcSzQYOOJZ-DKP`                | `SVh8Z-zUcSzQYOOJZ-DKP`                                            | ✅  |
| `activeVersionId`           | `6a97fe4a-31ea-49e6-b892-1ac55f85d115` | idêntico                                                           | ✅  |
| Hash do grafo ATIVO         | `60af8761…5870`                        | `60af87618b6bfd2e1cf1678a16a769062151fa4ec320126fdb5498e3ee385870` | ✅  |
| Nós / arestas ativos        | 58 / 59                                | **58 / 59**                                                        | ✅  |
| `versionId` do rascunho     | `1f1405f8-e9bc-4d2e-91bc-4106dbb07285` | idêntico                                                           | ✅  |
| Hash do grafo do RASCUNHO   | `6bc74d79…9d23`                        | `6bc74d79b499c68ac20c1fd273f75bd17bec3eae51694de29ac5d2b560bf9d23` | ✅  |
| Última publicação           | evento `activated`                     | `activated`, versão `6a97fe4a…`, 29/10 18:19:48                    | ✅  |
| Container                   | rodando                                | `running`, `restartCount=0`, desde 27/10 19:03                     | ✅  |
| Valores de credencial lidos | não                                    | `credentialValuesRead: false`                                      | ✅  |

Evidência: `docs/evidence/n8n-reconcile-gate-20261031.json` (`c5166d06…e5c`).

**Identidade conferida por ID + `activeVersionId` + hash de grafo**, não pelo nome: o
`workflow_entity.name` hoje é `GMJ NetVision - Mitigacao DDoS - RC7.1.1 REVIEW-08 (fallback de grafico)`
— diferente do rótulo citado no relatório anterior. Isso **não** afeta a reconciliação.

## 2. Cadeia de hashes verificada de forma independente

Baixei os `nodes`/`connections` publicados (`workflow_history @ 6a97fe4a`) em leitura e
recalculei localmente com o mesmo método do gate
(`sha256(json.dumps({nodes, connections}, sort_keys=True))`):

| Objeto                                    | Hash recalculado | Confere           |
| ----------------------------------------- | ---------------- | ----------------- |
| Publicado (58/59)                         | `60af8761…5870`  | = esperado ✅     |
| Candidato (58/59)                         | `5c76e866…5154`  | = esperado ✅     |
| Candidato **sem** o delta do normalizador | `6bc74d79…9d23`  | = **rascunho** ✅ |

## 3. Diff final

### 3.1 Contra o **rascunho** (mudança funcional — a única)

**Um** nó alterado: `Normalizar Evento OUT` → `parameters.jsonOutput` (+729 caracteres).
Nada mais. Nós, conexões, parâmetros e credenciais idênticos.

```diff
   if (b.peer)
     lines.push(`<b>Peer principal:</b> ${esc(b.peer)}`);

+  // ==========================================================
+  // ESCOPO VERIFICADO - prefixos REAIS da mitigacao (campo aditivo)
+  // Sem lista => "indisponivel". Nunca inferir de profile/policy.
+  // ==========================================================
+  const scopePrefixes = Array.isArray(b.prefixes)
+    ? b.prefixes.filter((p) => typeof p === 'string' && p.length > 0)
+    : [];
+
+  lines.push('');
+
+  if (scopePrefixes.length > 0) {
+    lines.push(`<b>Prefixos (${scopePrefixes.length}):</b>`);
+    for (const item of scopePrefixes) lines.push(`\u2022 ${esc(item)}`);
+  } else {
+    lines.push('<b>Prefixos:</b> <i>indispon\u00edvel</i>');
+  }
+
   lines.push('');
   lines.push(
     '✅ <b>MITIGAÇÃO ATIVADA E VERIFICADA NO EQUIPAMENTO</b>'
@@ ...
     RT: b.rt ?? null,
+    PREFIXOS: scopePrefixes,
+    QTD_PREFIXOS: scopePrefixes.length,
     POLICY_COMPARTILHADA: b.sharedPolicy === true,
```

Arquivo: `docs/n8n/RC7.1.2-PREFIXOS-NORMALIZER.diff` (sha256 `edcf7669…cb40`).

Efeito prático na mensagem de mitigação verificada:

```
...
<b>Peer principal:</b> 10.200.201.2

<b>Prefixos (3):</b>
• 167.250.126.0/23
• 167.250.126.0/24
• 167.250.127.0/24

✅ MITIGAÇÃO ATIVADA E VERIFICADA NO EQUIPAMENTO
```

Sem lista (leitura falhou / evento antigo): `<b>Prefixos:</b> <i>indisponível</i>`.
Detecção bloqueada e simulação **não** recebem essas linhas.

### 3.2 Contra o **publicado** — ⚠️ correção de um relatório anterior

| Nó                                     | Campo        | Publicado       | Candidato              |
| -------------------------------------- | ------------ | --------------- | ---------------------- |
| `Normalizar Evento OUT`                | `parameters` | —               | novo bloco de prefixos |
| `Somente Status Mitigacao RC712?` (IF) | `position`   | `[-1650, 5100]` | `[-10576, 11600]`      |
| `Telegram - Status Mitigacao RC712`    | `position`   | `[-1350, 5100]` | `[-10272, 11600]`      |

**Correção:** o relatório anterior afirmava "diferença: **somente** `Normalizar Evento OUT`" e
"candidato − delta → hash `60af8761…` exato". **As duas afirmações estão erradas.** O candidato
foi construído sobre o **rascunho** (`1f1405f8…`), portanto carrega também as **duas mudanças de
posição** que o operador já tinha no rascunho. A prova correta é:
`candidato − normalizador = 6bc74d79…` (rascunho), não `60af8761…` (publicado).

**Impacto:** as duas diferenças são **apenas `position`** — coordenadas do canvas do editor.
Nenhuma mudança de nó, conexão, parâmetro, credencial ou comportamento. Efeito: ao publicar, o
layout do editor passa a refletir o rascunho do operador (os dois nós aparecem na posição movida).

**Duas opções, e é preciso escolher:**

| Opção                                 | O que publica        | Hash ativo final | Efeito                                                |
| ------------------------------------- | -------------------- | ---------------- | ----------------------------------------------------- |
| **B — candidato atual** (recomendada) | rascunho + prefixos  | `5c76e866…5154`  | preserva o layout do operador **e** adiciona prefixos |
| A — reconstruir do publicado          | publicado + prefixos | novo hash        | **descarta** os 2 movimentos de layout do rascunho    |

A opção B é a que atende "preservar todas as mudanças existentes" e é a que o gate valida
(exige o rascunho em `6bc74d79…`). A opção A exigiria regenerar o candidato e reexecutar o gate.

## 4. Credenciais

6 referências de credencial no workflow — **ids e nomes idênticos** ao publicado.
Nenhum valor, placeholder ou token no candidato. Nenhuma credencial é criada, alterada ou lida.

## 5. Publicação (não executada)

Pré-requisito já cumprido: API `bf7bc52` publicada e saudável desde 23:12 UTC.

1. Backup do workflow atual (GET autenticado).
2. `PATCH /rest/workflows/SVh8Z-zUcSzQYOOJZ-DKP` com **somente** `nodes` + `connections`
   do candidato + `expectedChecksum` (mesmo método de 29/10; sem CLI, sem PUT público, sem restart).
3. GET do rascunho → hash `5c76e866…5154`; `activeVersionId` ainda `6a97fe4a…`.
4. `POST …/activate` com o `versionId` do rascunho → conferir novo `activeVersionId` e hash ativo `5c76e866…`.

**Preciso de uma sessão autenticada do editor n8n** (ou API key) para executar os passos 2–4.
O gate read-only não requer credencial de API, mas o PATCH/activate requerem.

## 6. Rollback

Reativar `6a97fe4a-31ea-49e6-b892-1ac55f85d115` pelo histórico (ou PATCH do snapshot + activate)
e conferir hash ativo `60af8761…5870`. Independente do rollback da API.

## 7. O que NÃO foi feito

Nenhuma escrita no n8n. Nenhuma alteração de API, Huawei, Telegram, flags ou AUTO.
Nenhuma credencial lida. Arquivos temporários criados no host (`/root`) foram removidos;
os backups pré-existentes do host não foram tocados.

**Parado. Aguardando autorização para publicar o n8n.**
