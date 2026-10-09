# MIBs do NetVision — fontes, hashes, closure e validação

Coleta feita em 2026-10-09 (UTC). Uso previsto: documentação/validação de OIDs SNMP do
inventário e da telemetria (óptico/DDM, thresholds, hardware/ENTITY, chassis/slot/board,
interface/port, sensores, alarmes).

## Regras seguidas

- **Pesquisa da fonte oficial primeiro**: a Huawei publica a *documentação* por OID em
  `info.support.huawei.com` (pública, já citada pelos perfis em `apps/api/src/infrastructure/snmp/profiles`)
  mas distribui os **arquivos `.mib` dentro dos pacotes de software/MIB por produto**
  em `support.huawei.com`, atrás de login — não há download anônimo direto utilizável
  (tentativas registradas: `/enterprise/en/network-management` devolve app JS;
  `/enterprise/en/doc/EDOC1100306132/...` redireciona para `supportindex` sem conteúdo).
  → por isso as MIBs Huawei vieram de **MIRROR**.

- **MIRROR escolhido**: [LibreNMS](https://github.com/librenms/librenms) (`mibs/huawei/` e `mibs/`)
  e [Net-SNMP](https://github.com/net-snmp/net-snmp) (`mibs/`) para as MIBs padrão;
  **IANA** (fonte oficial) para os módulos da IANA.

- **Conteúdo preservado**: nenhum arquivo foi editado; cada sha256 abaixo é do arquivo
  como baixado. Os nomes foram normalizados para `<MODULO>.mib` (o nome original de cada
  download está registrado em `manifest.json`).

- **Closure mínima de IMPORTS resolvida** a partir das 6 MIBs solicitadas:
  33 módulos, 0 imports pendentes.

## Inventário

| módulo | arquivo | bytes | versão | last-updated | origem | URL final | sha256 | validação |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- || `HUAWEI-DEVICE-EXT-MIB` | `huawei/HUAWEI-DEVICE-EXT-MIB.mib` | 4799 | V2.04 | 202103151414Z | MIRROR (LibreNMS) | <https://raw.githubusercontent.com/librenms/librenms/master/mibs/huawei/HUAWEI-DEVICE-EXT-MIB> | `d1e20a21359eab94…` | PROBLEMA |
| `HUAWEI-DEVICE-MIB` | `huawei/HUAWEI-DEVICE-MIB.mib` | 433308 | V5.47 | 202302060000Z | MIRROR (LibreNMS) | <https://raw.githubusercontent.com/librenms/librenms/master/mibs/huawei/HUAWEI-DEVICE-MIB> | `8ca7d23e10e2b815…` | PROBLEMA |
| `HUAWEI-ENTITY-EXTENT-MIB` | `huawei/HUAWEI-ENTITY-EXTENT-MIB.mib` | 291707 | V3.84 | 202211240000Z | MIRROR (LibreNMS) | <https://raw.githubusercontent.com/librenms/librenms/master/mibs/huawei/HUAWEI-ENTITY-EXTENT-MIB> | `ebadc33325770169…` | PROBLEMA |
| `HUAWEI-GTL-MIB` | `huawei/HUAWEI-GTL-MIB.mib` | 44249 | V2.37 | 202209291731Z | MIRROR (LibreNMS) | <https://raw.githubusercontent.com/librenms/librenms/master/mibs/huawei/HUAWEI-GTL-MIB> | `e7d2f2c8b71cb39b…` | PROBLEMA |
| `HUAWEI-IF-EXT-MIB` | `huawei/HUAWEI-IF-EXT-MIB.mib` | 305243 | V3.30 | 202206180000Z | MIRROR (LibreNMS) | <https://raw.githubusercontent.com/librenms/librenms/master/mibs/huawei/HUAWEI-IF-EXT-MIB> | `687c2982aecc6ef2…` | PROBLEMA |
| `HUAWEI-IMA-MIB` | `huawei/HUAWEI-IMA-MIB.mib` | 32136 | V2.12 | 201801130000Z | MIRROR (LibreNMS) | <https://raw.githubusercontent.com/librenms/librenms/master/mibs/huawei/HUAWEI-IMA-MIB> | `1573a1b1e4c58dc5…` | PROBLEMA |
| `HUAWEI-MIB` | `huawei/HUAWEI-MIB.mib` | 379014 | V7.21 | 202302040000Z | MIRROR (LibreNMS) | <https://raw.githubusercontent.com/librenms/librenms/master/mibs/huawei/HUAWEI-MIB> | `ba362a1de240b708…` | PROBLEMA |
| `HUAWEI-PORT-MIB` | `huawei/HUAWEI-PORT-MIB.mib` | 438671 | V3.33 | 202211080000Z | MIRROR (LibreNMS) | <https://raw.githubusercontent.com/librenms/librenms/master/mibs/huawei/HUAWEI-PORT-MIB> | `e970e90c01c0a228…` | PROBLEMA |
| `HUAWEI-TC-MIB` | `huawei/HUAWEI-TC-MIB.mib` | 2497559 | V13.65 | 202302090000Z | MIRROR (LibreNMS) | <https://raw.githubusercontent.com/librenms/librenms/master/mibs/huawei/HUAWEI-TC-MIB> | `57f2e1750c35fa48…` | PROBLEMA |
| `IANA-ENTITY-MIB` | `iana/IANA-ENTITY-MIB.mib` | 6880 | — | 201507160000Z | OFFICIAL (IANA) | <https://www.iana.org/assignments/ianaentity-mib/ianaentity-mib> | `545cf9190c57fc58…` | OK |
| `IANAifType-MIB` | `iana/IANAifType-MIB.mib` | 39630 | — | 202603170000Z | OFFICIAL (IANA) | <https://www.iana.org/assignments/ianaiftype-mib/ianaiftype-mib> | `c676192edc492eb0…` | OK |
| `ATM-TC-MIB` | `ietf/ATM-TC-MIB.mib` | 27282 | — | 9810190200Z | MIRROR (LibreNMS) | <https://raw.githubusercontent.com/librenms/librenms/master/mibs/ATM-TC-MIB> | `279a938f6d73bba2…` | OK |
| `BRIDGE-MIB` | `ietf/BRIDGE-MIB.mib` | 50948 | — | 200509190000Z | MIRROR (Net-SNMP) | <https://raw.githubusercontent.com/net-snmp/net-snmp/master/mibs/BRIDGE-MIB.txt> | `1e18de882086fca7…` | OK |
| `ENTITY-MIB` | `ietf/ENTITY-MIB.mib` | 65951 | — | 201304050000Z | MIRROR (LibreNMS) | <https://raw.githubusercontent.com/librenms/librenms/master/mibs/ENTITY-MIB> | `e56b77653a231714…` | OK |
| `HCNUM-TC` | `ietf/HCNUM-TC.mib` | 4660 | — | 200006080000Z | MIRROR (Net-SNMP) | <https://raw.githubusercontent.com/net-snmp/net-snmp/master/mibs/HCNUM-TC.txt> | `c8d21522e3729416…` | OK |
| `IF-MIB` | `ietf/IF-MIB.mib` | 71691 | — | 200006140000Z | MIRROR (Net-SNMP) | <https://raw.githubusercontent.com/net-snmp/net-snmp/master/mibs/IF-MIB.txt> | `a41d2d0414bd6e1b…` | OK |
| `INET-ADDRESS-MIB` | `ietf/INET-ADDRESS-MIB.mib` | 16782 | — | 200502040000Z | MIRROR (Net-SNMP) | <https://raw.githubusercontent.com/net-snmp/net-snmp/master/mibs/INET-ADDRESS-MIB.txt> | `2cec7722aa39eb8f…` | OK |
| `IP-MIB` | `ietf/IP-MIB.mib` | 185667 | — | 200602020000Z | MIRROR (Net-SNMP) | <https://raw.githubusercontent.com/net-snmp/net-snmp/master/mibs/IP-MIB.txt> | `6a6ec284b2de6f21…` | OK |
| `P-BRIDGE-MIB` | `ietf/P-BRIDGE-MIB.mib` | 39879 | — | 200601090000Z | MIRROR (LibreNMS) | <https://raw.githubusercontent.com/librenms/librenms/master/mibs/P-BRIDGE-MIB> | `6dc239385992f51c…` | OK |
| `Q-BRIDGE-MIB` | `ietf/Q-BRIDGE-MIB.mib` | 84133 | — | 200601090000Z | MIRROR (LibreNMS) | <https://raw.githubusercontent.com/librenms/librenms/master/mibs/Q-BRIDGE-MIB> | `7c89bcd183025118…` | PROBLEMA |
| `RFC1155-SMI` | `ietf/RFC1155-SMI.mib` | 3067 | — | — | MIRROR (Net-SNMP) | <https://raw.githubusercontent.com/net-snmp/net-snmp/master/mibs/RFC1155-SMI.txt> | `070e8c1cbcb01513…` | OK |
| `RFC-1212` | `ietf/RFC-1212.mib` | 2866 | — | — | MIRROR (LibreNMS) | <https://raw.githubusercontent.com/librenms/librenms/master/mibs/RFC-1212> | `e66fa442d3e030d3…` | PROBLEMA |
| `RFC1213-MIB` | `ietf/RFC1213-MIB.mib` | 79667 | — | — | MIRROR (Net-SNMP) | <https://raw.githubusercontent.com/net-snmp/net-snmp/master/mibs/RFC1213-MIB.txt> | `b21ec8c8f5a3169a…` | PROBLEMA |
| `RFC1271-MIB` | `ietf/RFC1271-MIB.mib` | 147614 | — | — | MIRROR (LibreNMS) | <https://raw.githubusercontent.com/librenms/librenms/master/mibs/RFC1271-MIB> | `ba04a5788aa04670…` | PROBLEMA |
| `RMON2-MIB` | `ietf/RMON2-MIB.mib` | 223833 | — | 200605020000Z | MIRROR (LibreNMS) | <https://raw.githubusercontent.com/librenms/librenms/master/mibs/RMON2-MIB> | `13ded5addbf2f54c…` | PROBLEMA |
| `RMON-MIB` | `ietf/RMON-MIB.mib` | 147822 | — | 200005110000Z | MIRROR (Net-SNMP) | <https://raw.githubusercontent.com/net-snmp/net-snmp/master/mibs/RMON-MIB.txt> | `dcb729079c88a3aa…` | OK |
| `SNMP-FRAMEWORK-MIB` | `ietf/SNMP-FRAMEWORK-MIB.mib` | 22342 | — | 200210140000Z | MIRROR (Net-SNMP) | <https://raw.githubusercontent.com/net-snmp/net-snmp/master/mibs/SNMP-FRAMEWORK-MIB.txt> | `0b61ecae73be7eb8…` | OK |
| `SNMPv2-CONF` | `ietf/SNMPv2-CONF.mib` | 8263 | — | — | MIRROR (Net-SNMP) | <https://raw.githubusercontent.com/net-snmp/net-snmp/master/mibs/SNMPv2-CONF.txt> | `b3e90ba682e10c76…` | OK |
| `SNMPv2-MIB` | `ietf/SNMPv2-MIB.mib` | 29305 | — | 200210160000Z | MIRROR (Net-SNMP) | <https://raw.githubusercontent.com/net-snmp/net-snmp/master/mibs/SNMPv2-MIB.txt> | `b4f8ef130f580b86…` | OK |
| `SNMPv2-SMI` | `ietf/SNMPv2-SMI.mib` | 8924 | — | — | MIRROR (Net-SNMP) | <https://raw.githubusercontent.com/net-snmp/net-snmp/master/mibs/SNMPv2-SMI.txt> | `ece2355fc8b6140a…` | OK |
| `SNMPv2-TC` | `ietf/SNMPv2-TC.mib` | 38034 | — | — | MIRROR (Net-SNMP) | <https://raw.githubusercontent.com/net-snmp/net-snmp/master/mibs/SNMPv2-TC.txt> | `c1379575e6a0ad25…` | OK |
| `TOKEN-RING-RMON-MIB` | `ietf/TOKEN-RING-RMON-MIB.mib` | 101324 | — | — | MIRROR (LibreNMS) | <https://raw.githubusercontent.com/librenms/librenms/master/mibs/TOKEN-RING-RMON-MIB> | `2555bb9d8842bc42…` | PROBLEMA |
| `UUID-TC-MIB` | `ietf/UUID-TC-MIB.mib` | 3136 | — | 201304050000Z | MIRROR (LibreNMS) | <https://raw.githubusercontent.com/librenms/librenms/master/mibs/UUID-TC-MIB> | `7c30999e1e38066e…` | OK |
Origem `OFFICIAL` = IANA (publicação oficial). `MIRROR` = repositório público que preserva
o conteúdo original do vendor/IETF.

## Closure (o que foi puxado e por quê)

Raízes: `HUAWEI-MIB`, `HUAWEI-ENTITY-EXTENT-MIB`, `HUAWEI-DEVICE-MIB`,
`HUAWEI-DEVICE-EXT-MIB`, `HUAWEI-IF-EXT-MIB`, `HUAWEI-PORT-MIB`.

- Huawei privadas adicionais: `HUAWEI-TC-MIB` (importada por `HUAWEI-DEVICE-MIB`),
  `HUAWEI-GTL-MIB` e `HUAWEI-IMA-MIB` (importadas por `HUAWEI-PORT-MIB`).
- IETF/IANA: `SNMPv2-SMI/TC/CONF/MIB`, `SNMP-FRAMEWORK-MIB`, `ENTITY-MIB` (+ `UUID-TC-MIB`,
  `IANA-ENTITY-MIB`), `IF-MIB` (+ `IANAifType-MIB`), `IP-MIB`, `INET-ADDRESS-MIB`, `HCNUM-TC`,
  `ATM-TC-MIB`, `BRIDGE-MIB`, `P-BRIDGE-MIB`, `Q-BRIDGE-MIB`.
- **Cadeia RMON** (`RMON2-MIB`, `RMON-MIB`, `RFC1271-MIB`, `TOKEN-RING-RMON-MIB`, `RFC1213-MIB`,
  `RFC1155-SMI`, `RFC-1212`): entra porque `Q-BRIDGE-MIB` importa `TimeFilter` **de `RMON2-MIB`**,
  e `HUAWEI-IF-EXT-MIB` importa `Q-BRIDGE-MIB`. É a única razão da cadeia — não é opcional se a
  `HUAWEI-IF-EXT-MIB` precisar ser compilada.
- Descartado por não pertencer à closure: `TRANSPORT-ADDRESS-MIB` (baixado como candidato e removido).

## Validação

Ferramenta: **pysmi 2.0** (`mibdump --destination-format=null --rebuild`), um módulo por vez,
contra `mibs/huawei`, `mibs/ietf` e `mibs/iana`.

Resultado no conjunto **exatamente como está neste diretório**: **18 OK / 15 PROBLEMA**,
sendo que os 15 problemas têm **3 causas raiz** (todas *upstream*/mirror, nenhuma do nosso lado):

1. `HUAWEI-MIB` V7.21 — 5 símbolos de OID definidos duas vezes (subárvore `fw`).
   Bloqueia `HUAWEI-MIB` e quem o importa (7 módulos).
2. `HUAWEI-TC-MIB` V13.65 — 9 identificadores terminando em `-` (typo da Huawei).
3. `RFC-1212` — o arquivo dos mirrors é um *stub para libsmi* (o próprio cabeçalho diz que
   comentou o macro `OBJECT-TYPE` e usa diretiva `SMIC`); compiladores estritos recusam.
   Bloqueia a cadeia Q-BRIDGE/RMON.

Com uma **cópia temporária** corrigida apenas nos 5 duplicados (fora deste diretório),
as 6 raízes compilam: `HUAWEI-MIB`, `HUAWEI-ENTITY-EXTENT-MIB`, `HUAWEI-DEVICE-EXT-MIB`
e `HUAWEI-PORT-MIB` OK; `HUAWEI-DEVICE-MIB` e `HUAWEI-IF-EXT-MIB` seguem bloqueadas
**somente** pelas causas 2 e 3. Correções exatas (opcionais, não aplicadas) em
[`patches/known-issues.md`](./patches/known-issues.md).

Ferramentas *tolerantes* (Net-SNMP/snmptranslate, que implementa os macros SMIv1 nativamente)
normalmente carregam esses módulos com avisos, sem exigir as correções.

## Candidatas por família (listadas, NÃO baixadas)

Critério: só entram se servirem a óptico/DDM, thresholds, hardware/ENTITY,
chassis/slot/board, interface/port, sensores ou alarmes.

| MIB | família | por quê | tamanho |
| --- | --- | --- | ---: |
| `HUAWEI-ALARM-MIB` | todas | tabela de alarmes ativos via SNMP (alternativa a depender só de traps) | 40 KB |
| `HUAWEI-ENTITY-TRAP-MIB` | todas | traps de hardware/entidade (board, slot, sensor) | 249 KB |
| `HUAWEI-BASE-TRAP-MIB` | todas | traps base do device | 94 KB |
| `HUAWEI-ENVIRONMENT-MIB` | NE/roteadores | temperatura, ventoinha, tensão (sensores) | 173 KB |
| `HUAWEI-POWER-MIB` / `HUAWEI-ENERGYMNGT-MIB` | todas | energia/consumo (sensores) | 150 KB / 32 KB |
| `HUAWEI-STACK-MIB` | S6730/S6750 | chassis/stack (iStack) | 119 KB |
| `HUAWEI-E-TRUNK-MIB`, `HUAWEI-M-LAG-MIB`, `HUAWEI-SUPERLAG-MIB` | switches/OLT | agregação e LAG (interface/port) | 32/7,5/19 KB |
| `HUAWEI-POE-MIB` | switches | PoE por porta (energia/sensor) | 41 KB |
| `HUAWEI-ETHOAM-MIB` | switches | OAM/CFM por porta | 429 KB |
| `HUAWEI-XPON-MIB`, `HUAWEI-XPON-COMMON-MIB` | MA5800 (OLT) | portas PON, ONT/ONU, potência óptica | 951 KB / 762 KB |
| `HUAWEI-EPON-MIB` | MA5800/EPON | OLT EPON | 110 KB |
| `OPTIX-NE-MIB`, `OPTIX-BOARD-MANAGE-MIB`, `OPTIX-MISC-MIB`, `OPTIX-OID-MIB` | MA5800 (OSN/OLT) | chassis/slot/board da família OptiX | 12/15/21/2 KB |
| `HUAWEI-BRAS-PPPoX-MIB`, `HUAWEI-BRAS-RADIUS-MIB`, `HUAWEI-BRAS-L2TP-MIB` | NE40E/NE8000 (BNG) | sessões de assinantes (o projeto já usa o OID de PPP online) | 37/137/46 KB |
| `HUAWEI-BGP-VPN-MIB`, `HUAWEI-BFD-MIB` | NE40E/NE8000 | BGP/VRF e BFD (monitoração de peer já existente) | 121 KB / 143 KB |

Não há MIB Huawei específica de "óptico/DDM" no mirror: a potência óptica usada pelo
NetVision vem da `HUAWEI-ENTITY-EXTENT-MIB` (já incluída), que é a fonte dos OIDs
`.31.1.1.3.1.x` e `.31.1.1.4.1.x` dos perfis.

## Como usar

```bash
# Net-SNMP (tolerante; acha tudo pelo MIBS=+ALL)
export MIBDIRS="$PWD/mibs/huawei:$PWD/mibs/ietf:$PWD/mibs/iana"
snmptranslate -Td -m ALL 1.3.6.1.4.1.2011.5.25.31.1.1.3.1.8

# pysmi (estrito, gera JSON)
mibdump --mib-source=file:///caminho/mibs/huawei \
        --mib-source=file:///caminho/mibs/ietf \
        --mib-source=file:///caminho/mibs/iana \
        --destination-format=json --destination-directory=/tmp/mibs-json HUAWEI-MIB
```
