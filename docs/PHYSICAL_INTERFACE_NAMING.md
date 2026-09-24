# Nomes de interface (CLI) no módulo Físico — levantamento do catálogo

Documento de apoio à mudança de UX em que **a identidade apresentada da porta é o nome da interface
CLI** (`100GE1/0/1`, `XGigabitEthernet0/0/1`, `ether1`…) e o **conector** (`QSFP28`, `SFP28`, `RJ45`…) passa
a ser característica física, nunca o nome principal.

## Como o catálogo já funciona

`apps/api/catalog/physical-catalog-v1.yaml` → `apps/api/src/infrastructure/physical/physical-catalog-yaml.ts`:

| campo do grupo | vira | significado |
| --- | --- | --- |
| `physicalLabelPattern` | `port.label` **e** nome da porta quando não há CLI | rótulo do painel/cage (`QSFP28-1`) |
| `interfaceNamePattern` | `port.name` **e** `PhysicalCatalogPort.interfaceName` | nome real usado pelo SO do equipamento |
| `connector` | `PhysicalCatalogPort.connector` + desenho | tipo do conector (`QSFP28`, `SFP28`…) |

Regra do loader: `const pattern = group.interfaceNamePattern ?? group.physicalLabelPattern;` — sem
`interfaceNamePattern` o nome persistido é o próprio rótulo físico (comportamento atual da maioria do catálogo).

## Levantamento

- SKUs exatos no catálogo: **121**
- SKUs com `interfaceNamePattern` declarado: **43** (todos MikroTik)
- SKUs que dependem de confirmação/captura: **50**
- Placeholders de família/genéricos (sem porta nenhuma ou sem verificação): **28**

### Tabela — SKUs sem nome CLI declarado (ação necessária)

| catalogKey | fabricante | modelo | physicalLabelPattern (por grupo) | interfaceNamePattern | status | ação necessária |
| --- | --- | --- | --- | --- | --- | --- |
| `huawei-ne8000-f1a-8h20q` | Huawei | NetEngine 8000 F1A-8H20Q | 100ge-cages: `100GE-{n}` (8×QSFP28) ; 25ge-cages: `25GE-{n}` (20×SFP28) ; 10ge-cages: `10GE-{n}` (28×SFP_PLUS) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `huawei-s6730-h24x6c` | Huawei | S6730 S6730-H24X6C | sfpplus-10g: `10GE-{n}` (24×SFP_PLUS) ; qsfp28-uplink: `QSFP28-{n}` (6×QSFP28) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `huawei-s6730-h48x6c` | Huawei | S6730 S6730-H48X6C | sfpplus-10g: `10GE-{n}` (48×SFP_PLUS) ; qsfp28-uplink: `QSFP28-{n}` (6×QSFP28) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `huawei-s6730-h24x6c-v2` | Huawei | S6730 S6730-H24X6C-V2 | sfpplus-10g: `10GE-{n}` (24×SFP_PLUS) ; qsfp28-uplink: `QSFP28-{n}` (6×QSFP28) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `huawei-s6730-h48x6c-v2` | Huawei | S6730 S6730-H48X6C-V2 | sfpplus-10g: `10GE-{n}` (48×SFP_PLUS) ; qsfp28-uplink: `QSFP28-{n}` (6×QSFP28) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `huawei-s6750-h48x8c` | Huawei | S6750 S6750-H48X8C | sfp28-service: `SFP28-{n}` (48×SFP28) ; qsfp28-uplink: `QSFP28-{n}` (8×QSFP28) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `huawei-s6750-h48y8c` | Huawei | S6750 S6750-H48Y8C | sfp28-service: `SFP28-{n}` (48×SFP28) ; qsfp28-uplink: `QSFP28-{n}` (8×QSFP28) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `huawei-s6750-h48y8c-b` | Huawei | S6750 S6750-H48Y8C-B | sfp28-service: `SFP28-{n}` (48×SFP28) ; qsfp28-uplink: `QSFP28-{n}` (8×QSFP28) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `huawei-s6750-h36c` | Huawei | S6750 S6750-H36C | qsfp28-service: `QSFP28-{n}` (32×QSFP28) ; qsfp28-uplink: `QSFP28-{n+32}` (4×QSFP28) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `juniper-mx80` | Juniper | MX MX80 | fixed-10gbe: `10GbE-{n}` (4×XFP) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `juniper-mx104` | Juniper | MX MX104 | built-in-10gbe: `XE-2/0/{n}` (4×XFP) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `juniper-mx204` | Juniper | MX MX204 | sfpplus-10g: `SFP+-{n}` (8×SFP_PLUS) ; rate-selectable: `QSFP28-{n}` (4×QSFP28) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `datacom-dm4370-4gt-4gx-4xs` | Datacom | DM4370 DM4370 4GT+4GX+4XS | rj45: `RJ45-{n}` (4×RJ45) ; sfp: `SFP-{n}` (4×SFP) ; sfpplus: `SFP+-{n}` (4×SFP_PLUS) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `datacom-dm4376-2gt-4gx-4xs` | Datacom | DM4376 DM4376 2GT+4GX+4XS | rj45: `RJ45-{n}` (2×RJ45) ; sfp: `SFP-{n}` (4×SFP) ; sfpplus: `SFP+-{n}` (4×SFP_PLUS) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `datacom-dm4380` | Datacom | DM4380 DM4380 | sfpplus: `SFP+-{n}` (12×SFP_PLUS) ; qsfp28: `QSFP28-{n}` (3×QSFP28) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `datacom-dm4270-24xs-2cx` | Datacom | DM4270 DM4270 24XS+2CX | sfpplus: `SFP+-{n}` (24×SFP_PLUS) ; configurable-uplink: `QSFP28-{n}` (3×QSFP28) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `datacom-dm4270-48xs-6cx` | Datacom | DM4270 DM4270 48XS+6CX | sfpplus: `SFP+-{n}` (48×SFP_PLUS) ; qsfp28: `QSFP28-{n}` (6×QSFP28) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `datacom-dm4270-8xs-16vs-6cx` | Datacom | DM4270 DM4270 8XS+16VS+6CX | sfpplus: `SFP+-{n}` (8×SFP_PLUS) ; sfp28: `SFP28-{n}` (16×SFP28) ; qsfp28: `QSFP28-{n}` (6×QSFP28) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `datacom-dm4770-32cx` | Datacom | DM4770 DM4770 32CX | qsfp28: `QSFP28-{n}` (32×QSFP28) ; sfpplus: `SFP+-{n}` (2×SFP_PLUS) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `datacom-dm4770-16cx` | Datacom | DM4770 DM4770 16CX | qsfp28: `QSFP28-{n}` (12×QSFP28) ; qsfpdd: `QSFP-DD-{n}` (4×QSFP_DD) ; sfp28: `SFP28-{n}` (4×SFP28) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `datacom-dm4780-16cx-8dx` | Datacom | DM4780 DM4780 16CX+8DX | sfpplus: `SFP+-1` (1×SFP_PLUS) ; qsfp28: `QSFP28-{n}` (8×QSFP28) ; qsfp56: `QSFP56-{n}` (4×QSFP56) ; qsfpdd-200: `QSFP-DD-200-{n}` (4×QSFP_DD) ; qsfpdd-400: `QSFP-DD-400-{n}` (8×QSFP_DD) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `datacom-dm4611` | Datacom | DM46xx DM4611 | gpon: `PON-{n}` (4×SFP) ; ge-rj45: `GE-RJ45-{n}` (2×RJ45) ; 10ge: `10GE-{n}` (2×SFP_PLUS) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `datacom-dm4612` | Datacom | DM46xx DM4612 | gpon: `PON-{n}` (8×SFP) ; ge-rj45: `GE-RJ45-{n}` (2×RJ45) ; 10ge: `10GE-{n}` (2×SFP_PLUS) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `datacom-dm4610-8gpon` | Datacom | DM46xx DM4610 8GPON | gpon: `PON-{n}` (8×SFP) ; ge-sfp: `GE-SFP-{n}` (8×SFP) ; ge-rj45: `GE-RJ45-{n}` (4×RJ45) ; 10ge: `10GE-{n}` (2×SFP_PLUS) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `datacom-dm4615-16gpon` | Datacom | DM46xx DM4615 16GPON | gpon: `PON-{n}` (16×SFP) ; ge-rj45: `GE-RJ45-{n}` (2×RJ45) ; 10ge: `10GE-{n}` (4×SFP_PLUS) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `datacom-dm4616` | Datacom | DM46xx DM4616 | xgsp-on: `PON-{n}` (4×SFP_PLUS) ; 10ge: `10GE-{n}` (4×SFP_PLUS) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `datacom-dm4618` | Datacom | DM46xx DM4618 | embedded-gpon: `PON-{n}` (32×SFP) ; sfp28-uplink: `25GE-{n}` (4×SFP28) ; qsfp28-uplink: `100GE-{n}` (2×QSFP28) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `zte-zxa10-c610` | ZTE | ZXA10 TITAN ZXA10 C610 | pon: `PON-{n}` (16×OTHER) ; uplink: `UPLINK-{n}` (6×SFP28) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `vsol-v1600g1-r` | VSOL | V1600 V1600G1-R | gpon: `PON-{n}` (8×SFP) ; ge-rj45: `GE-RJ45-{n}` (4×RJ45) ; ge-sfp: `SFP-SFPPLUS-{n}` (4×SFP_PLUS) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `vsol-v1600g2-r` | VSOL | V1600 V1600G2-R | gpon: `PON-{n}` (16×SFP) ; ge-rj45: `GE-RJ45-{n}` (4×RJ45) ; ge-sfp: `SFP-SFPPLUS-{n}` (4×SFP_PLUS) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |
| `vsol-v3600g1-c` | VSOL | V3600 V3600G1-C | combo-pon: `PON-{n}` (8×SFP_PLUS) ; ge-rj45: `GE-1` (1×RJ45) ; sfp28: `SFP28-{n}` (4×SFP28) ; qsfp28: `QSFP28-{n}` (2×QSFP28) | não | VERIFICADO (nome CLI falta) | confirmar o nome CLI real da família antes de declarar |

### Tabela — SKUs com nome CLI declarado (nada a fazer)

| fabricante | SKUs | padrao | interfaceNamePattern | status | ação necessária |
| --- | --- | --- | --- | --- | --- |
| MikroTik | 43 | `ether{n}`, `ether{n+5}`, `ether8`, `ether13`, `sfp1`, `sfp{n}`, `sfp-sfpplus{n}` | igual ao rótulo físico | CONFIRMADO (declarado) | nenhuma |

### Módulos (moduleTemplates)

| moduleKey | partNumber | physicalLabelPattern | interfaceNamePattern | status | ação necessária |
| --- | --- | --- | --- | --- | --- |
| `juniper-mic-3d-20ge-sfp` | MIC-3D-20GE-SFP | ge-sfp: `SFP-{n}` (20×SFP) | não | AGUARDANDO CONFIRMAÇÃO | usar `port.name` até existir interface real |
| `juniper-mic-3d-20ge-sfp-e` | MIC-3D-20GE-SFP-E | ge-sfp: `SFP-{n}` (20×SFP) | não | AGUARDANDO CONFIRMAÇÃO | usar `port.name` até existir interface real |
| `juniper-mic-macsec-20ge` | MIC-MACSEC-20GE | ge-sfp: `SFP-{n}` (20×SFP) | não | AGUARDANDO CONFIRMAÇÃO | usar `port.name` até existir interface real |
| `juniper-mic-3d-2xge-xfp` | MIC-3D-2XGE-XFP | 10ge-xfp: `XFP-{n}` (2×XFP) | não | AGUARDANDO CONFIRMAÇÃO | usar `port.name` até existir interface real |
| `juniper-mic-3d-40ge-tx` | MIC-3D-40GE-TX | tri-rate-rj45: `RJ45-{n}` (40×RJ45) | não | AGUARDANDO CONFIRMAÇÃO | usar `port.name` até existir interface real |
| `huawei-gpfd-16` | H802GPFD | gpon: `GPON-{n}` (16×SFP) | não | AGUARDANDO CONFIRMAÇÃO | confirmar o nome real da porta PON no OLT antes de declarar |
| `huawei-xgspon-16` | H901XGPB | xgspon: `XGSPON-{n}` (16×SFP_PLUS) | não | AGUARDANDO CONFIRMAÇÃO | usar `port.name` até existir interface real |
| `huawei-h901mpsc` | H901MPSC | console: `CONSOLE` (1×RJ45) ; mgmt: `MGMT` (1×RJ45) ; usb: `USB` (1×OTHER) ; uplink-10ge: `10GE-{n}` (2×SFP_PLUS) ; uplink-ge: `GE-{n}` (2×SFP) | não | AGUARDANDO CONFIRMAÇÃO | usar `port.name` até existir interface real |
| `huawei-h902mpla` | H902MPLA | uplink: `UPLINK-{n}` (4×OTHER) | não | AGUARDANDO CONFIRMAÇÃO | usar `port.name` até existir interface real |
| `huawei-scun` | H801SCUN | eth0: `ETH0` (1×RJ45) ; eth1: `ETH1` (1×RJ45) ; console: `CONSOLE` (1×RJ45) ; usb: `USB` (1×OTHER) | não | AGUARDANDO CONFIRMAÇÃO | usar `port.name` até existir interface real |
| `huawei-pac600s12-cb` | PAC600S12-CB | — | não | AGUARDANDO CONFIRMAÇÃO | usar `port.name` até existir interface real |

### Prioridade de confirmação (ordem pedida pela operação)

1. `huawei-ne8000-f1a-8h20q` — 100ge-cages: 100GE-{n} (8×QSFP28) ; 25ge-cages: 25GE-{n} (20×SFP28) ; 10ge-cages: 10GE-{n} (28×SFP_PLUS)
2. `huawei-s6730-h24x6c` — sfpplus-10g: 10GE-{n} (24×SFP_PLUS) ; qsfp28-uplink: QSFP28-{n} (6×QSFP28)
3. `huawei-s6730-h48x6c` — sfpplus-10g: 10GE-{n} (48×SFP_PLUS) ; qsfp28-uplink: QSFP28-{n} (6×QSFP28)
4. `huawei-s6730-h24x6c-v2` — sfpplus-10g: 10GE-{n} (24×SFP_PLUS) ; qsfp28-uplink: QSFP28-{n} (6×QSFP28)
5. `huawei-s6730-h48x6c-v2` — sfpplus-10g: 10GE-{n} (48×SFP_PLUS) ; qsfp28-uplink: QSFP28-{n} (6×QSFP28)
6. `huawei-s6750-h48x8c` — sfp28-service: SFP28-{n} (48×SFP28) ; qsfp28-uplink: QSFP28-{n} (8×QSFP28)
7. `huawei-s6750-h48y8c` — sfp28-service: SFP28-{n} (48×SFP28) ; qsfp28-uplink: QSFP28-{n} (8×QSFP28)
8. `huawei-s6750-h48y8c-b` — sfp28-service: SFP28-{n} (48×SFP28) ; qsfp28-uplink: QSFP28-{n} (8×QSFP28)
9. `huawei-s6750-h36c` — qsfp28-service: QSFP28-{n} (32×QSFP28) ; qsfp28-uplink: QSFP28-{n+32} (4×QSFP28)
10. `huawei-ne8000-m4` — sem grupos de porta (modular: portas só com placa)
11. `huawei-ne8000-m8-dc` — sem grupos de porta (modular: portas só com placa)
12. `huawei-ne8000-m8-ac` — sem grupos de porta (modular: portas só com placa)
13. `huawei-ne40e-x3` — sem grupos de porta (modular: portas só com placa)
14. `huawei-ma5800-x2` — sem grupos de porta (modular: portas só com placa)
15. `huawei-ma5800-x7` — sem grupos de porta (modular: portas só com placa)
16. `huawei-ma5800-x15` — sem grupos de porta (modular: portas só com placa)
17. `huawei-ma5800-x17` — sem grupos de porta (modular: portas só com placa)
18. `huawei-ma5683t` — sem grupos de porta (modular: portas só com placa)

## Implementado (identidade apresentada = interface CLI)

| camada | arquivo | regra |
| --- | --- | --- |
| apresentação | `apps/web/src/components/physical/physical-port-name.ts` | `mappedInterface.name` → `catalogInterfaceName` → `port.name`; expõe `displayName`, `panelLabel`, `compactLabel`, `interfacePrefix` |
| painel técnico | `physical-rack-canvas.tsx` + `physical-port-shape.tsx` | rótulo curto = ordinal da interface; tooltip `100GE1/0/1 · Conector QSFP28 · Painel físico QSFP28-1 · estado`; baía anuncia a faixa (`XGigabitEthernet0/0/1–48`) |
| inspector | `physical-inspector.tsx` | campos `Interface`, `Conector`, `Porta física`, `Velocidade`, `Estado`, `Operacional` |
| sincronização | `physical-domain.ts` (`planInterfaceSync`) | ordem: mapeada → `interfaceName` exato → `interfaceName` normalizado → `port.name` → alias do modelo → família/ordinal → ambíguo não mapeia |
| catálogo | `physical-catalog-v1.yaml` | 37 grupos MikroTik ganharam `interfaceNamePattern` (RouterOS usa o mesmo nome do rótulo já declarado) |

O que **não** muda: `PhysicalPort.id`, âncora de cabo, seleção, LLDP, breakout e a
contagem/numeração das portas. Assets já materializados mantêm os nomes atuais —
o catálogo só passa a declarar o nome CLI para novas materializações e para a
apresentação.

## Aliases por modelo (CATALOG_PANEL_ALIASES)

`apps/api/src/infrastructure/physical/physical-domain.ts` mantém 4 chaves de S6730:

```
'huawei-s6730-h24x6c': { xgigabitethernet: '10ge', '100ge': 'qsfp28' },
'huawei-s6730-h48x6c': { xgigabitethernet: '10ge', '100ge': 'qsfp28' },
'huawei-s6730-h24x6c-v2': { xgigabitethernet: '10ge', '100ge': 'qsfp28' },
'huawei-s6730-h48x6c-v2': { xgigabitethernet: '10ge', '100ge': 'qsfp28' },
```

O alias diz que o VRP desses modelos responde `XGigabitEthernet<slot>/<subslot>/N` para o grupo `10GE-{n}`
e `100GE<slot>/<subslot>/N` para o grupo `QSFP28-{n}` — **sem fixar o slot** (stack/iStack muda o primeiro
número). Por isso ele continua sendo a correlação segura desses 4 SKUs enquanto o nome CLI exato do
slot não for confirmado por captura da unidade.

## Como declarar um padrão confirmado

```yaml
portGroups:
  - groupKey: sfpplus-10g
    count: 48
    connector: SFP_PLUS
    role: SERVICE
    physicalLabelPattern: 10GE-{n}          # rótulo do painel (mantido)
    interfaceNamePattern: XGigabitEthernet0/0/{n}   # somente com confirmação
```

Efeitos automáticos depois disso: `PhysicalCatalogPort.name`/`interfaceName` passam a ser o nome CLI,
`label` continua o rótulo físico, o painel técnico mostra o nome CLI, a sincronização casa por nome exato
e o Inspector mostra `Interface` + `Conector` + `Porta física`. Nada disso renomeia `PhysicalPort.id`.

> Sem confirmação, o nome apresentado continua o rótulo físico até a porta ter uma interface mapeada
(`mappedInterface.name`), que é sempre o nome real reportado pelo equipamento.
