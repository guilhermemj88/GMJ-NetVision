# Defeitos conhecidos nas MIBs baixadas (correções opcionais)

Os arquivos em `mibs/huawei|ietf|iana` foram preservados **byte a byte** como publicados
(sha256 em [`../SOURCES.md`](../SOURCES.md) e `manifest.json`). As correções abaixo **não**
foram aplicadas: são anotações para quem precisar de um compilador estrito (pysmi/mibdump,
libsmi). Ferramentas tolerantes (Net-SNMP, que implementa os macros SMIv1 nativamente)
normalmente carregam os módulos com aviso, sem correção.

Sempre que aplicar uma correção, ela deixa de ser o arquivo original: registre o novo sha256
e mantenha o original em outro lugar.

---

## 1. `HUAWEI-MIB` V7.21 — cinco OIDs definidos duas vezes

Mesma revisão define o mesmo nome de duas formas na subárvore `fw` (firewall). O `MODULE-IDENTITY`
já sugere a origem do caso: linha 1106 — *"Changed the name of USG6635F-AC to USG6635F"*
(o nome antigo continuou na árvore e colidiu com o novo).

| símbolo | 1ª definição | 2ª definição |
| --- | --- | --- |
| `eudemon200S` | linha 4520 | linha 4525 |
| `USG6635F` | linha 5634 (`{ fw 284 }`) | linha 5745 (`{ fw 402 }`) |
| `USG6525F` | linha 5764 | linha 5776 |
| `USG6565F` | linha 5766 | linha 5775 |
| `ne40ex16b` | linha 5960 | linha 5962 |

Exemplo de correção conservadora (renomear a **segunda** ocorrência, que é a que colide com o
nome já publicado, mantendo o restante intacto):

```bash
sed -i '5745s/^\(\s*\)USG6635F\b/\1USG6635F-DUP/'         mibs/huawei/HUAWEI-MIB.mib
sed -i '5776s/^\(\s*\)USG6525F\b/\1USG6525F-DUP/'         mibs/huawei/HUAWEI-MIB.mib
sed -i '5775s/^\(\s*\)USG6565F\b/\1USG6565F-DUP/'         mibs/huawei/HUAWEI-MIB.mib
sed -i '5962s/^\(\s*\)ne40ex16b\b/\1ne40ex16b-DUP/'       mibs/huawei/HUAWEI-MIB.mib
sed -i '4525s/^\(\s*\)eudemon200S\b/\1eudemon200S-DUP/'   mibs/huawei/HUAWEI-MIB.mib
```

Efeito: `HUAWEI-MIB` compila e, com isso, os 7 módulos que o importam deixam de ser
bloqueados por este defeito (verificado em cópia temporária: `HUAWEI-MIB`,
`HUAWEI-ENTITY-EXTENT-MIB`, `HUAWEI-DEVICE-EXT-MIB` e `HUAWEI-PORT-MIB` passaram a compilar).

## 2. `HUAWEI-TC-MIB` V13.65 — identificadores terminando em `-`

Nove nomes de TC/objeto da família `subbname8090DEV*` foram publicados com hífen final, o que é
inválido em SMI. Linhas: **22728, 22729, 22730, 22731, 22732, 22733, 22744, 22745, 22746**.

```
subbname8090DEVCR5D00P8E871-(225867),   -- 8-Port 100/1000Base-X-SFP + 8-Port OC-3c/STM-1c POS-SFP
...
```

Correção: remover o `-` final de cada nome, por exemplo:

```bash
sed -i -E 's/(subbname8090DEV[A-Z0-9-]*[A-Z0-9])-\(/\1(/' mibs/huawei/HUAWEI-TC-MIB.mib
```

Efeito: desbloqueia `HUAWEI-DEVICE-MIB` (uma das 6 MIBs solicitadas).

## 3. `RFC-1212` — o arquivo dos mirrors é um *stub para libsmi*

O cabeçalho do próprio arquivo (idêntico no LibreNMS e no `mibs.pysnmp.com`) diz:

```
-- file: RFC-1212.my
-- changes:
--      Removed IMPORTS.
--      Commented out OBJECT-TYPE macro definition and replaced
--        with SMIC directive to enable it.
```

Ou seja: o macro `OBJECT-TYPE` está comentado e há uma diretiva `SMIC` do libsmi, que o pysmi
não entende (`Bad grammar near offset 435, line 79`). Isso bloqueia `Q-BRIDGE-MIB` → `RMON2-MIB`
→ `RMON-MIB`/`RFC1271-MIB`/`TOKEN-RING-RMON-MIB` → `RFC1213-MIB` → e, por consequência,
`HUAWEI-IF-EXT-MIB`.

Opções, em ordem de preferência:

1. **Não corrigir**: usar Net-SNMP (`snmptranslate`), que implementa os macros SMIv1
   internamente e não depende desse arquivo para resolver a árvore.
2. Substituir o arquivo por um módulo `RFC-1212` **não editado**, obtido a partir do texto do
   RFC 1212 (a extração do macro não é "conteúdo original do mirror" — precisa ser registrada
   como transformação, com novo sha256).
3. Manter o stub e ignorar o erro (`mibdump --ignore-errors`), ciente de que a compilação
   estrita de Q-BRIDGE/RMON fica comprometida.

---

## Reverificação

```bash
mibdump --mib-source=file://$PWD/mibs/huawei \
        --mib-source=file://$PWD/mibs/ietf \
        --mib-source=file://$PWD/mibs/iana \
        --destination-format=null --rebuild HUAWEI-MIB
```

Estado atual (pristine): **18 módulos OK / 15 com problema**, integralmente explicados pelos
itens 1–3 acima.
