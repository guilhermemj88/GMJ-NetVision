# Validação das MIBs — pristine × overlay

As MIBs vendorizadas em `mibs/huawei`, `mibs/ietf` e `mibs/iana` são **pristine**
(byte-for-byte iguais às fontes registradas em [`../SOURCES.md`](../SOURCES.md) e
`manifest.json`) e **nunca** são editadas. A validação vive em uma camada separada.

## Conceito

| Camada | O que é | Pode ser modificada? |
| --- | --- | --- |
| **PRISTINE** | `mibs/{huawei,ietf,iana}` — arquivos como baixados, com sha256 registrado | **Nunca** |
| **VALIDATION OVERLAY** | árvore temporária criada por `tools/mibs/prepare-validation-tree.ps1` | Sim, só ela; é apagada ao final |

Defeitos conhecidos (catalogados em [`known-issues.json`](./known-issues.json)):

1. `HUAWEI-MIB` V7.21 — 5 símbolos de OID duplicados (subárvore `fw`) — upstream.
2. `HUAWEI-TC-MIB` V13.65 — 9 identificadores terminando em `-` — upstream.
3. `RFC-1212` — *stub para libsmi* publicado pelos mirrors (macro `OBJECT-TYPE` comentado,
   diretiva `SMIC`) — empacotamento do mirror, não é defeito Huawei.

## Como validar

```powershell
# valida pristine e overlay, grava o resultado e apaga o temporário
powershell -NoProfile -ExecutionPolicy Bypass -File tools/mibs/prepare-validation-tree.ps1
# (ou `pwsh -File ...` onde houver PowerShell 7)

# mantendo o temporário para inspeção
powershell -NoProfile -File tools/mibs/prepare-validation-tree.ps1 -Keep

# usando um validador específico
powershell -NoProfile -File tools/mibs/prepare-validation-tree.ps1 -Validator C:\Python312\Scripts\mibdump.exe
```

Saída: tabela `MODULO × PRISTINE × OVERLAY` no console e o JSON completo em
[`results/`](./results) (`validation-<timestamp>.json`); código de saída `0` quando o
overlay passa em todos os módulos, `2` quando sobra alguma falha. O último run
(`validation-20261009T004537Z.json`) deu **pristine 18 PASS / 15 FAIL** e
**overlay 33 PASS / 0 FAIL**. Nenhum arquivo de `mibs/` é tocado (conferido por sha256
contra o `manifest.json` após o run).

O script:

1. copia `mibs/{huawei,ietf,iana}` para um diretório temporário;
2. aplica **somente no temporário** os overlays do `known-issues.json`
   (renames dos 5 duplicados, remoção dos 9 hífens finais e substituição do `RFC-1212`
   por um módulo SMIv1 equivalente para o compilador);
3. roda o validador (`pysmi`/`mibdump`) por módulo nas duas árvores;
4. grava `validation/results/validation-<timestamp>.json`;
5. apaga o temporário (salvo `-Keep`).

Validador de referência: **pysmi 2.0** (`mibdump --destination-format=null --rebuild`).
Ferramentas tolerantes (Net-SNMP) implementam os macros SMIv1 nativamente e normalmente
carregam os módulos apenas com aviso — o overlay serve para quem precisa de compilador estrito.

## Resultado de referência (2026-10-09)

| módulo | PRISTINE | OVERLAY |
| --- | --- | --- |
| `HUAWEI-MIB` | FAIL — duplicate symbols (upstream) | PASS |
| `HUAWEI-TC-MIB` | FAIL — invalid trailing identifiers (upstream) | PASS |
| `RFC-1212` | LEGACY_COMPATIBILITY_STUB (mirror) | PASS |
| `HUAWEI-DEVICE-MIB` | FAIL — herdado do `HUAWEI-TC-MIB` (+`HUAWEI-MIB`) | PASS |
| `HUAWEI-IF-EXT-MIB` | FAIL — herdado do `RFC-1212` (+`HUAWEI-MIB`) | PASS |
| `HUAWEI-ENTITY-EXTENT-MIB`, `HUAWEI-DEVICE-EXT-MIB`, `HUAWEI-PORT-MIB`, `HUAWEI-GTL-MIB`, `HUAWEI-IMA-MIB` | FAIL — herdado do `HUAWEI-MIB` | PASS |
| `Q-BRIDGE-MIB`, `RMON2-MIB`, `RMON-MIB`, `RFC1271-MIB`, `TOKEN-RING-RMON-MIB`, `RFC1213-MIB` | FAIL — herdado do `RFC-1212` | PASS |
| demais 18 módulos | OK | OK |
