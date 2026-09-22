# Catálogo físico versionado — `physical-catalog-v1.yaml`

Este diretório guarda o **arquivo fonte de verdade** dos templates `SYSTEM` do
módulo físico (DCIM): `physical-catalog-v1.yaml`.

O catálogo embutido em `apps/api/src/infrastructure/physical/physical-catalog.ts`
existe apenas como **fallback de emergência** para o caso do arquivo não existir.
Quando o YAML está presente e válido, ele é usado sozinho — sem merge.

## Conteúdo atual (V1.1)

| Item | Valor |
| --- | --- |
| `catalogKey` | `gmj-netvision-physical-catalog-v1.1` |
| Templates de equipamento | **121** |
| Templates de placa | **5** |
| `vendorVerified: true` | **90** (equipamentos) + 5 placas |
| `vendorVerified: false` | **31** |
| Conectores declarados | 1.480 |
| Slots declarados | 153 |
| Fabricantes | Huawei 28 (23 verificados), MikroTik 43 (40), Datacom 15 (15), Generic 12 (0), FiberHome 7 (0), ZTE 6 (4), VSOL 6 (5), Juniper 4 (3) |

Destaques do V1.1: `huawei-ne8000-f1a-8h20q` (56 conectores: 8×100GE + 20×25GE + 28×10GE),
chassis `NetEngine 8000 M4/M8 DC/M8 AC` (somente slots de placa), família NE40E com as variantes
`NE40E-X3 (DC)` 4U e `NE40E-X3 (AC)` 5U, novas variantes `S6750-H48Y8C-B` e `S6750-H36C`, e a
varredura de verificação das páginas oficiais MikroTik (console/gerência declarados separadamente
e `rackMount: false` preservado nos equipamentos de mesa). O V1.0 permanece no histórico do Git.

## Caminhos procurados (nesta ordem)

1. `PHYSICAL_CATALOG_YAML_PATH` (variável de ambiente, caminho absoluto);
2. `apps/api/catalog/physical-catalog-v1.yaml` relativo ao diretório de trabalho
   (produção: `WorkingDirectory=/opt/GMJ-NetVision` + `npm run start -w @gmj/api`);
3. `catalog/physical-catalog-v1.yaml` relativo ao diretório de trabalho (útil ao
   rodar a partir de `apps/api`).

## Política de falha

| Situação | Comportamento |
| --- | --- |
| arquivo presente e válido | `source: "yaml"`, catálogo carregado integralmente |
| arquivo presente e inválido | `source: "invalid"` + `errors[]`; o bootstrap lança `PhysicalCatalogError` e **não** há fallback silencioso |
| arquivo ausente | `source: "builtin"` + warning; catálogo embutido de emergência |

`GET /api/physical/catalog` devolve `source`, `path`, `schemaVersion`,
`warnings`, `errors`, `unsupportedFields` e `counts` (`templates`,
`moduleTemplates`, `vendorVerified`, `unverified`, `ports`, `slots`).

## Estrutura do arquivo (schemaVersion 1.0)

```yaml
schemaVersion: '1.0'
catalogKey: gmj-netvision-physical-catalog-v1.1
policies: { ... }                 # documentação de políticas (idempotência, breakout, …)
interfaceClassification: { ... }  # regras PHYSICAL/LOGICAL por fabricante (documentação)
sources:                          # catálogo de referências oficiais
  mikrotik-rb5009:
    vendor: MikroTik
    title: RB5009UG+S+IN
    url: https://mikrotik.com/product/rb5009ug_s_in
    kind: official
templates:                        # 121 chassis/modelos (V1.1: 90 verified / 31 unverified)
  - catalogKey: mikrotik-crs328-24p-4splus-rm
    manufacturer: MikroTik
    family: CRS
    model: CRS328-24P-4S+RM
    aliases: []
    kind: SWITCH                  # ROUTER|SWITCH|OLT|SERVER|DIO|PATCH_PANEL|POWER|GENERIC
    layoutType: FIXED             # FIXED|MODULAR
    heightU: 1                    # aceita fração (ex.: 3.5 do MX104)
    rackMount: true
    vendorVerified: true
    portGroups:
      - groupKey: ether
        count: 24
        connector: RJ45           # RJ45|SFP|SFP_PLUS|SFP28|XFP|QSFP_PLUS|QSFP28|QSFP56|QSFP_DD|COMBO|USB_MINI_B|OTHER
        role: SERVICE             # SERVICE|UPLINK|MGMT|MGMT_OR_SERVICE|PON|CONSOLE|POWER
        speeds: [1G]
        breakoutCapable: false
        physicalLabelPattern: ether{n}     # rótulo do painel
        interfaceNamePattern: ether{n}     # nome de CLI (quando conhecido)
    slotGroups:
      - groupKey: mic
        slotIds: ['0/0', '0/1']
        role: MIC
        capacityNote: ...
    compatibleModuleKeys: [juniper-mic-3d-20ge-sfp]
    managementPorts: [{ count: 1, connector: RJ45, role: MGMT }]
    consolePorts: [{ label: serial, connector: RJ45, role: CONSOLE }]
    sourceRefs: [mikrotik-products]
    verificationNote: ...
moduleTemplates:                  # 5 placas compatíveis
  - moduleKey: juniper-mic-3d-20ge-sfp
    manufacturer: Juniper
    partNumber: MIC-3D-20GE-SFP
    name: 20-port Gigabit Ethernet MIC with SFP
    compatibleCatalogKeys: [juniper-mx80, juniper-mx104]
    vendorVerified: true
    portGroups: [{ groupKey: ge-sfp, count: 20, connector: SFP, role: SERVICE, speeds: [1G], breakoutCapable: false, physicalLabelPattern: SFP-{n} }]
    sourceRefs: [juniper-mics]
implementationNotes: [ ... ]      # notas de implementação (patterns, offsets, …)
```

## Como o importador traduz o YAML

- **nomes de porta**: `interfaceNamePattern` quando existir, senão
  `physicalLabelPattern`. Expansão de padrões: `{n}` → 1..count;
  `{n+K}` → K+1..K+count (padrões de offset semântico, ex.: `ether{n+5}` continua
  em `ether6`); ordinal literal (`ether8`, `SFP+-1`) é preservado quando
  `count: 1`; sem `{n}` e com `count > 1` a numeração continua a partir do
  literal.
- **`heightU` fracionário**: o catálogo guarda o valor exato (`heightUExact`) e o
  rack usa `Math.ceil` (MX104 3.5U → 4U).
- **`vendorVerified`**: copiado exatamente do YAML — nunca promovido por
  inferência. `structureConfirmed` fica `true` quando o template é genérico ou
  quando há estrutura declarada (portas, slots ou módulos compatíveis).
- **`compatibleModuleKeys`** é a chave de ligação slot ↔ placa; o `catalogKey` da
  placa é gravado exatamente como declarado (`moduleKey`), sem namespace.
- **`sourceRefs`** viram `referenceUrl`/`referenceUrls` resolvidos pelo mapa
  `sources`.
- **Campos não representados** aparecem em `unsupportedFields` (nunca são
  descartados silenciosamente).
- **`policies`**, **`interfaceClassification`** e **`implementationNotes`** são
  documentação: validadas quanto à presença, mas não viram linhas de banco.

## Regras de conteúdo (não alterar sem fonte oficial)

- `vendorVerified: true` só quando modelo/SKU e a estrutura de conectores têm
  fonte oficial em `sources[]`; partes adiadas continuam declaradas como tal.
- `vendorVerified: false` mantém o modelo como placeholder: **nada** de portas,
  slots, alturas ou placas inventadas.
- Interface lógica (VLANIF, loopback, LAG, túnel, bridge, sub-interface,
  pseudowire, PPPoE, virtual) **nunca** é conector físico.
- Cage QSFP/QSFP28/QSFP56/QSFP-DD é **um** conector: as lanes de breakout são
  filhas lógicas e nunca geram conectores extras.

## Validação

- `apps/api/src/infrastructure/physical/physical-catalog-yaml.test.ts` valida o
  arquivo real (contagens, ausência de campos não representados, expansão de
  padrões, breakout, altura fracionária, política de falha).
- `apps/api/src/physical-dcim.test.ts` e `physical-sync-classification.test.ts`
  exercitam o catálogo via API (bootstrap idempotente, materialização, slots,
  placas, sync e reconciliação).
