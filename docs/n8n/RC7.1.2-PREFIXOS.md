# n8n RC7.1.2 — apresentação dos prefixos do escopo verificado

**Status: PREPARADO. NÃO PUBLICADO.** Nenhum n8n, Telegram ou webhook real foi
acionado nesta missão.

Arquivo: `docs/n8n/GMJ-NetVision-Telegram-RC7.1.2-PREFIXOS.json`
Gerado por: `python tools/n8n/build-rc712.py` (determinístico e verificável)
Base: `docs/n8n/GMJ-NetVision-Telegram-RC7.1-WORKFLOW-COMPATIBILITY.json`

---

## 1. O que muda — exatamente uma coisa

| Item                                   | RC7.1                  | RC7.1.2            |
| -------------------------------------- | ---------------------- | ------------------ |
| Nós                                    | 56                     | **56 (idênticos)** |
| Conexões                               | —                      | **idênticas**      |
| Credenciais / webhooks / Header Auth   | 4 independentes        | **idênticos**      |
| `lastNode` nos 3 canais de alarmes     | sim                    | **sim**            |
| Ramo S5 de detecção bloqueada          | sim                    | **sim**            |
| REENVIO v2 / `INCLUIR_DADOS_DE_ESCOPO` | sim                    | **sim**            |
| Nó `Normalizar Evento OUT`             | não renderiza prefixos | **renderiza**      |

O gerador falha se qualquer nó fora do normalizador mudar ou se as conexões
divergirem. O teste `mitigation-workflow-rc712.test.ts` revalida isso.

## 2. Alteração no normalizador

Bloco adicionado na mensagem de **mitigação verificada** (após o peer principal):

```js
const scopePrefixes = Array.isArray(b.prefixes)
  ? b.prefixes.filter((p) => typeof p === 'string' && p.length > 0)
  : [];

lines.push('');

if (scopePrefixes.length > 0) {
  lines.push(`<b>Prefixos (${scopePrefixes.length}):</b>`);
  for (const item of scopePrefixes) lines.push(`• ${esc(item)}`);
} else {
  lines.push('<b>Prefixos:</b> <i>indisponível</i>');
}
```

Saída adicional no objeto do nó: `PREFIXOS` (array) e `QTD_PREFIXOS` (number).

Regras de apresentação:

- lista presente → um item por linha, escapado;
- lista ausente/vazia → **`indisponível`** (nunca omitir, nunca inventar);
- evento anterior ao campo → mesma linha `indisponível` (compatível);
- simulação → continua **não** sendo mitigação real;
- detecção bloqueada → **não** recebe a linha de prefixos (o texto de detecção é outro).

## 3. Contrato consumido

Só o campo aditivo `prefixes` do payload da API:

```json
{
  "event": "MITIGATION_VERIFIED",
  "verified": true,
  "simulation": false,
  "prefixes": ["167.250.126.0/23", "167.250.126.0/24", "167.250.127.0/24"],
  "fieldsUnavailable": []
}
```

Nenhuma expressão usa `$env`, nenhum token literal, nenhuma credencial nova.

---

## 4. Procedimento de publicação (autorização separada)

1. **Pré-requisito de API**: a release em produção precisa já enviar `prefixes`.
   Ordem recomendada: publicar a API primeiro (com o campo) e depois o workflow —
   assim o campo existe antes de a apresentação depender dele. Enquanto a API
   antiga estiver no ar, a mensagem mostra `indisponível`, sem erro.
2. Importar `GMJ-NetVision-Telegram-RC7.1.2-PREFIXOS.json` no n8n.
3. Remapear as **quatro** credenciais Header Auth para as credenciais reais do
   ambiente (o arquivo traz placeholders; nunca tokens).
4. Comparar com o RC7.1 publicado nó a nó (diff deve ser apenas o normalizador).
5. Teste isolado: payload sintético `MITIGATION_VERIFIED` com os três prefixos →
   executar o nó normalizador e conferir o texto.
6. Teste isolado: mesmo payload **sem** `prefixes` → linha `indisponível`.
7. Publicar o workflow.
8. Homologação real: só com mitigação real autorizada e mensagem real no Telegram,
   com recibo. Nada disso foi feito aqui.

## 5. Rollback

Republicar o RC7.1 (`GMJ-NetVision-Telegram-RC7.1-WORKFLOW-COMPATIBILITY.json`).
Como o único delta está no normalizador e o campo `prefixes` é aditivo, o rollback
do workflow é independente do rollback da API.

## 6. Pendências declaradas

- **Sem n8n isolado neste ambiente** → nenhuma execução dinâmica foi feita.
  A verificação é estática (estrutura + execução do normalizador em sandbox JS).
- A homologação dinâmica permanece com o operador/Claude.
- Não há publicação, nem merge, nem push nesta missão.
