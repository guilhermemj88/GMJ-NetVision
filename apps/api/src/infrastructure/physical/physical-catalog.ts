import type {
  PhysicalCatalogEntry,
  PhysicalCatalogPort,
  PhysicalAssetKind,
  PhysicalPortType,
} from '@gmj/shared';

/**
 * Versioned equipment catalog.
 *
 * Rules used to build it:
 * - `vendorVerified: true` only when height and port counts/types came from the
 *   vendor product page (checked on 2026-09-21, see `referenceUrl`);
 * - `structureConfirmed: false` means the product identity is known but the
 *   chassis/port structure was NOT confirmed, so nothing is invented: the slot
 *   and port lists stay empty and the UI asks the operator to complete them;
 * - generic templates are definitional (a patch panel has channels; a 1U
 *   server is 1U) and never claim to be a vendor model.
 *
 * Interface names are a separate concern: templates expose structural names and
 * the exact interface names always come from the Device/Interface inventory (or
 * from manual completion). Nothing here guesses a RouterOS/VRP port name.
 */

/**
 * Expands compact port group specs.
 *
 * The displayed number restarts per group (Ethernet 1..13, then SFP+ 1..4),
 * while `order` keeps counting across groups because the persisted template
 * port has a unique `(templateId, side, sortOrder)` constraint.
 */
function ports(
  spec: Array<{ prefix: string; count: number; type: PhysicalPortType; side?: 'DEVICE' | 'FRONT' | 'REAR'; label?: string; startAt?: number }>,
): PhysicalCatalogPort[] {
  let order = 0;
  return spec.flatMap((group) =>
    Array.from({ length: group.count }, (_value, index) => {
      order += 1;
      return {
        name: `${group.prefix}${(group.startAt ?? 1) + index}`,
        label: group.label ?? '',
        order,
        side: group.side ?? 'DEVICE',
        type: group.type,
      };
    }),
  );
}

function channels(count: number): PhysicalCatalogPort[] {
  return Array.from({ length: count }, (_value, index) => {
    const order = index + 1;
    const name = String(order).padStart(2, '0');
    return [
      { name, label: `Canal ${name} frontal`, order: order * 2 - 1, side: 'FRONT' as const, type: 'RJ45' as const },
      { name, label: `Canal ${name} traseiro`, order: order * 2, side: 'REAR' as const, type: 'RJ45' as const },
    ];
  }).flat();
}

function generic(
  catalogKey: string,
  name: string,
  kind: PhysicalAssetKind,
  heightU: number,
  extra: Partial<PhysicalCatalogEntry> = {},
): PhysicalCatalogEntry {
  return {
    catalogKey,
    name,
    category: kind === 'POWER' ? 'POWER' : kind === 'SERVER' ? 'SERVER' : 'GENERIC',
    manufacturer: 'Genérico',
    family: '',
    model: '',
    kind,
    heightU,
    vendorVerified: false,
    structureConfirmed: true,
    description: 'Template genérico: defina quantidade e tipo de portas na criação.',
    referenceUrl: null,
    portSummary: null,
    ports: [],
    slots: [],
    modules: [],
    ...extra,
  };
}

function unconfirmed(
  catalogKey: string,
  name: string,
  category: PhysicalCatalogEntry['category'],
  manufacturer: string,
  family: string,
  model: string,
  kind: PhysicalAssetKind,
): PhysicalCatalogEntry {
  return {
    catalogKey,
    name,
    category,
    manufacturer,
    family,
    model,
    kind,
    // Placeholder only: `structureConfirmed: false` tells the UI/API that the
    // height was not confirmed and must be reviewed before use.
    heightU: 1,
    vendorVerified: false,
    structureConfirmed: false,
    description:
      'Identidade do modelo confirmada apenas pelo nome. Estrutura (altura, slots, portas) não confirmada em documentação oficial: complete manualmente antes de usar.',
    referenceUrl: null,
    portSummary: null,
    ports: [],
    slots: [],
    modules: [],
  };
}

export const PHYSICAL_CATALOG: readonly PhysicalCatalogEntry[] = [
  // ---------------------------------------------------------------- genéricos
  generic('generic-router-1u', 'Router genérico 1U', 'NETWORK', 1, { category: 'ROUTER' }),
  generic('generic-switch-1u', 'Switch genérico 1U', 'NETWORK', 1, { category: 'SWITCH' }),
  generic('generic-olt-1u', 'OLT genérica 1U', 'OLT', 1, { category: 'OLT' }),
  generic('generic-olt-chassis', 'OLT chassis genérica', 'OLT', 10, {
    category: 'OLT',
    description:
      'Chassis genérico para OLT modular: os slots são criados na criação e as placas/portas são definidas manualmente.',
  }),
  generic('generic-server-1u', 'Servidor 1U', 'SERVER', 1),
  generic('generic-server-2u', 'Servidor 2U', 'SERVER', 2),
  generic('generic-dio', 'DIO genérico', 'DIO', 1, {
    category: 'PASSIVE',
    description: 'DIO sem estrutura de fabricante presumida: informe os canais na criação (FRONT/REAR pareados).',
  }),
  generic('generic-patch-panel-24', 'Patch panel 24 portas', 'PATCH_PANEL', 1, {
    category: 'PASSIVE',
    portSummary: '24 canais RJ45 (FRONT/REAR pareados)',
    ports: channels(24),
  }),
  generic('generic-patch-panel-48', 'Patch panel 48 portas', 'PATCH_PANEL', 1, {
    category: 'PASSIVE',
    portSummary: '48 canais RJ45 (FRONT/REAR pareados)',
    ports: channels(48),
  }),
  generic('generic-pdu', 'Energia / PDU genérica', 'POWER', 1),
  {
    catalogKey: 'generic-chassis-8-slot',
    name: 'Chassis genérico modular (8 slots)',
    category: 'OLT',
    manufacturer: 'Genérico',
    family: '',
    model: '',
    kind: 'OLT',
    heightU: 6,
    vendorVerified: false,
    structureConfirmed: true,
    description:
      'Chassi modular genérico com 8 slots. As placas são genéricas: nenhuma estrutura de fabricante é presumida, use a placa correspondente ao equipamento real.',
    referenceUrl: null,
    portSummary: '8 slots + placa genérica 4x SFP+',
    ports: [],
    slots: Array.from({ length: 8 }, (_value, index) => ({
      index: index + 1,
      label: `Slot ${index + 1}`,
      description: '',
      moduleKeys: ['generic-lpu-4x-sfp'],
    })),
    modules: [
      {
        key: 'generic-lpu-4x-sfp',
        name: 'Placa genérica 4x SFP+',
        model: '',
        description: 'Placa genérica com 4 portas SFP+ (nomes reais vêm do device ou de ajuste manual).',
        slotsRequired: 1,
        ports: ports([{ prefix: 'SFP+ ', count: 4, type: 'SFP_PLUS', label: 'SFP+' }]),
      },
    ],
  },

  // ------------------------------------------------------- Huawei (routers)
  unconfirmed('huawei-ne8000-m4', 'Huawei NE8000 M4', 'ROUTER', 'Huawei', 'NE8000', 'M4', 'NETWORK'),
  unconfirmed('huawei-ne8000-m8', 'Huawei NE8000 M8', 'ROUTER', 'Huawei', 'NE8000', 'M8', 'NETWORK'),
  unconfirmed('huawei-ne40e', 'Huawei NE40E', 'ROUTER', 'Huawei', 'NE40E', '', 'NETWORK'),

  // ------------------------------------------------------- Huawei (switches)
  unconfirmed('huawei-s5700', 'Huawei S5700', 'SWITCH', 'Huawei', 'S5700', '', 'NETWORK'),
  unconfirmed('huawei-s5720', 'Huawei S5720', 'SWITCH', 'Huawei', 'S5720', '', 'NETWORK'),
  unconfirmed('huawei-s6720', 'Huawei S6720', 'SWITCH', 'Huawei', 'S6720', '', 'NETWORK'),
  unconfirmed('huawei-s6730', 'Huawei S6730', 'SWITCH', 'Huawei', 'S6730', '', 'NETWORK'),
  unconfirmed('huawei-s6750', 'Huawei S6750', 'SWITCH', 'Huawei', 'S6750', '', 'NETWORK'),

  // ------------------------------------------------------------- MikroTik CCR
  unconfirmed('mikrotik-ccr1009', 'MikroTik CCR1009', 'ROUTER', 'MikroTik', 'CCR', 'CCR1009', 'NETWORK'),
  unconfirmed('mikrotik-ccr1036', 'MikroTik CCR1036', 'ROUTER', 'MikroTik', 'CCR', 'CCR1036', 'NETWORK'),
  unconfirmed('mikrotik-ccr1072', 'MikroTik CCR1072', 'ROUTER', 'MikroTik', 'CCR', 'CCR1072', 'NETWORK'),
  unconfirmed('mikrotik-ccr2004', 'MikroTik CCR2004', 'ROUTER', 'MikroTik', 'CCR', 'CCR2004', 'NETWORK'),
  {
    catalogKey: 'mikrotik-ccr2116-12g-4s-plus',
    name: 'MikroTik CCR2116-12G-4S+',
    category: 'ROUTER',
    manufacturer: 'MikroTik',
    family: 'CCR',
    model: 'CCR2116-12G-4S+',
    kind: 'NETWORK',
    heightU: 1,
    vendorVerified: true,
    structureConfirmed: true,
    description:
      'Roteador 16 núcleos em chassi 1U com fontes redundantes. Contagem e tipos de porta conforme a página oficial do produto; os nomes de interface devem vir do device (sync) ou de ajuste manual.',
    referenceUrl: 'https://mikrotik.com/product/ccr2116_12g_4splus',
    portSummary: '13x 1G RJ45 + 4x SFP+ 10G',
    ports: ports([
      { prefix: 'Ethernet ', count: 13, type: 'RJ45', label: '1G RJ45' },
      { prefix: 'SFP+ ', count: 4, type: 'SFP_PLUS', label: '10G SFP+' },
    ]),
    slots: [],
    modules: [],
  },
  unconfirmed('mikrotik-ccr2216', 'MikroTik CCR2216', 'ROUTER', 'MikroTik', 'CCR', 'CCR2216', 'NETWORK'),

  // ------------------------------------------------------------- MikroTik CRS
  {
    catalogKey: 'mikrotik-crs305-1g-4s-plus-in',
    name: 'MikroTik CRS305-1G-4S+IN',
    category: 'SWITCH',
    manufacturer: 'MikroTik',
    family: 'CRS',
    model: 'CRS305-1G-4S+IN',
    kind: 'NETWORK',
    heightU: 1,
    vendorVerified: true,
    structureConfirmed: true,
    description:
      'Switch compacto de mesa (141 x 115 x 28 mm) com 1 porta Gigabit Ethernet e 4 portas SFP+ 10G. Não é rackmount: use prateleira/bandeja ao montar em rack.',
    referenceUrl: 'https://mikrotik.com/product/crs305_1g_4s_in',
    portSummary: '1x 1G RJ45 + 4x SFP+ 10G',
    ports: ports([
      { prefix: 'Ethernet ', count: 1, type: 'RJ45', label: '1G RJ45' },
      { prefix: 'SFP+ ', count: 4, type: 'SFP_PLUS', label: '10G SFP+' },
    ]),
    slots: [],
    modules: [],
  },
  unconfirmed('mikrotik-crs309', 'MikroTik CRS309', 'SWITCH', 'MikroTik', 'CRS', 'CRS309', 'NETWORK'),
  unconfirmed('mikrotik-crs317', 'MikroTik CRS317', 'SWITCH', 'MikroTik', 'CRS', 'CRS317', 'NETWORK'),
  unconfirmed('mikrotik-crs326', 'MikroTik CRS326', 'SWITCH', 'MikroTik', 'CRS', 'CRS326', 'NETWORK'),
  {
    catalogKey: 'mikrotik-crs328-24p-4s-plus-rm',
    name: 'MikroTik CRS328-24P-4S+RM',
    category: 'SWITCH',
    manufacturer: 'MikroTik',
    family: 'CRS',
    model: 'CRS328-24P-4S+RM',
    kind: 'NETWORK',
    heightU: 1,
    vendorVerified: true,
    structureConfirmed: true,
    description:
      'Switch 1U com 24 portas Gigabit PoE-out e 4 portas SFP+. Contagem e tipos conforme página oficial do produto. PoE-out disponível nas portas Ethernet 1-24.',
    referenceUrl: 'https://mikrotik.com/product/crs328_24p_4s_rm',
    portSummary: '24x 1G RJ45 (PoE-out) + 4x SFP+ 10G',
    ports: ports([
      { prefix: 'Ethernet ', count: 24, type: 'RJ45', label: '1G RJ45 PoE-out' },
      { prefix: 'SFP+ ', count: 4, type: 'SFP_PLUS', label: '10G SFP+' },
    ]),
    slots: [],
    modules: [],
  },
  {
    catalogKey: 'mikrotik-crs354-48g-4s-plus-2q-plus-rm',
    name: 'MikroTik CRS354-48G-4S+2Q+RM',
    category: 'SWITCH',
    manufacturer: 'MikroTik',
    family: 'CRS',
    model: 'CRS354-48G-4S+2Q+RM',
    kind: 'NETWORK',
    heightU: 1,
    vendorVerified: true,
    structureConfirmed: true,
    description:
      'Switch 1U com 48 portas Gigabit, 4 portas SFP+ 10G e 2 portas QSFP+ 40G, além de 1 porta de gerência 10/100. Contagem e tipos conforme página oficial do produto.',
    referenceUrl: 'https://mikrotik.com/product/crs354_48g_4splus2qplusrm',
    portSummary: '48x 1G RJ45 + 4x SFP+ 10G + 2x QSFP+ 40G',
    ports: ports([
      { prefix: 'Ethernet ', count: 48, type: 'RJ45', label: '1G RJ45' },
      { prefix: 'SFP+ ', count: 4, type: 'SFP_PLUS', label: '10G SFP+' },
      { prefix: 'QSFP+ ', count: 2, type: 'QSFP', label: '40G QSFP+' },
      { prefix: 'Gerência ', count: 1, type: 'RJ45', label: '10/100 gerência' },
    ]),
    slots: [],
    modules: [],
  },

  // -------------------------------------------------------------- MikroTik RB
  unconfirmed('mikrotik-rb4011', 'MikroTik RB4011', 'ROUTER', 'MikroTik', 'RB', 'RB4011', 'NETWORK'),
  {
    catalogKey: 'mikrotik-rb5009ug-s-in',
    name: 'MikroTik RB5009UG+S+IN',
    category: 'ROUTER',
    manufacturer: 'MikroTik',
    family: 'RB',
    model: 'RB5009UG+S+IN',
    kind: 'NETWORK',
    heightU: 1,
    vendorVerified: true,
    structureConfirmed: true,
    description:
      'Roteador compacto de mesa (220 x 125 x 22 mm) com 9 portas cabeadas. Quatro unidades podem ser montadas em 1U com acessório próprio; o template assume 1U de bandeja.',
    referenceUrl: 'https://mikrotik.com/product/rb5009ug_s_in',
    portSummary: '7x 1G RJ45 + 1x 2.5G RJ45 + 1x SFP+ 10G',
    ports: ports([
      { prefix: 'Ethernet ', count: 7, type: 'RJ45', label: '1G RJ45' },
      { prefix: 'Ethernet ', count: 1, type: 'RJ45', label: '2.5G RJ45', startAt: 8 },
      { prefix: 'SFP+ ', count: 1, type: 'SFP_PLUS', label: '10G SFP+' },
    ]),
    slots: [],
    modules: [],
  },

  // ------------------------------------------------------------------ Datacom
  unconfirmed('datacom-dm4370', 'Datacom DM4370', 'SWITCH', 'Datacom', 'DM', 'DM4370', 'NETWORK'),

  // -------------------------------------------------------------- OLT Huawei
  unconfirmed('huawei-ma5683t', 'Huawei MA5683T', 'OLT', 'Huawei', 'MA5600T', 'MA5683T', 'OLT'),
  unconfirmed('huawei-ma5800-x2', 'Huawei MA5800-X2', 'OLT', 'Huawei', 'MA5800', 'MA5800-X2', 'OLT'),
  unconfirmed('huawei-ma5800-x7', 'Huawei MA5800-X7', 'OLT', 'Huawei', 'MA5800', 'MA5800-X7', 'OLT'),
  unconfirmed('huawei-ma5800-x15', 'Huawei MA5800-X15', 'OLT', 'Huawei', 'MA5800', 'MA5800-X15', 'OLT'),
  unconfirmed('huawei-ma5800-x17', 'Huawei MA5800-X17', 'OLT', 'Huawei', 'MA5800', 'MA5800-X17', 'OLT'),

  // ----------------------------------------------------------------- OLT ZTE
  unconfirmed('zte-c300', 'ZTE C300', 'OLT', 'ZTE', 'C300', 'C300', 'OLT'),
  unconfirmed('zte-c320', 'ZTE C320', 'OLT', 'ZTE', 'C320', 'C320', 'OLT'),

  // ------------------------------------------------------------- OLT FiberHome
  unconfirmed('fiberhome-an5516-01', 'FiberHome AN5516-01', 'OLT', 'FiberHome', 'AN5516', 'AN5516-01', 'OLT'),
];

export const PHYSICAL_CATALOG_BY_KEY: ReadonlyMap<string, PhysicalCatalogEntry> = new Map(
  PHYSICAL_CATALOG.map((entry) => [entry.catalogKey, entry]),
);
