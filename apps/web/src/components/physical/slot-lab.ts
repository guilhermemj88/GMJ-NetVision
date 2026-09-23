import type {
  PhysicalAsset,
  PhysicalCatalogEntry,
  PhysicalCatalogModule,
  PhysicalCatalogPort,
  PhysicalConnectorKind,
  PhysicalEquipmentTemplate,
  PhysicalPort,
  PhysicalPortFunction,
  PhysicalPortType,
} from '@gmj/shared';
import { modularChassisMap, slotOrientation } from './modular-chassis-map';
import { slotRoleLabel } from './physical-catalog';
import type { SlotFitView } from './physical-modular-panel';
import {
  catalogEntry,
  physicalAsset,
  physicalModule,
  physicalPort,
  physicalSlot,
  physicalTemplate,
} from './physical-fixtures';

/**
 * **Slot Lab** (bancada de teste, nada persiste).
 *
 * Módulos de inserção visual no Rack Lab. As portas de cada módulo vêm dos
 * mapas de painel já existentes no NetVision
 * (`olt-module-front-panel-maps-v1.json`) e os `moduleKeys` de cada slot vêm do
 * catálogo — este arquivo **espelha** essas declarações para a bancada, sem
 * inventar compatibilidade.
 */

export const SLOT_LAB_ASSET_ID = 'lab-slot-chassis';

export interface SlotLabModulePort {
  name: string;
  connector: PhysicalConnectorKind | null;
  type: PhysicalPortType;
  portFunction: PhysicalPortFunction;
}

export interface SlotLabModuleSpec {
  key: string;
  name: string;
  model: string;
  partNumber: string;
  /** Papel visual do módulo (mesma taxonomia do catálogo). */
  role: string;
  ports: SlotLabModulePort[];
}

const pon = (prefix: string, count: number, connector: PhysicalConnectorKind): SlotLabModulePort[] =>
  Array.from({ length: count }, (_value, index) => ({
    name: `${prefix}-${index + 1}`,
    connector,
    type: 'FIBER' as PhysicalPortType,
    portFunction: 'PON' as PhysicalPortFunction,
  }));

/**
 * Módulos disponíveis na bancada (part numbers declarados nos mapas reais).
 * `huawei-pac600s12-cb` é fonte: não possui porta de serviço — só presença.
 */
export const SLOT_LAB_MODULES: readonly SlotLabModuleSpec[] = [
  {
    key: 'huawei-gpfd-16',
    name: 'GPFD 16 portas GPON',
    model: 'H802GPFD',
    partNumber: 'H802GPFD',
    role: 'SERVICE',
    ports: pon('GPON', 16, 'SFP'),
  },
  {
    key: 'huawei-xgspon-16',
    name: 'XGS-PON 16 portas',
    model: 'H803XGS',
    partNumber: 'H803XGS',
    role: 'SERVICE',
    ports: pon('XGSPON', 16, 'SFP_PLUS'),
  },
  {
    key: 'huawei-h901mpsc',
    name: 'H901MPSC (controle)',
    model: 'H901MPSC',
    partNumber: 'H901MPSC',
    role: 'CONTROL',
    ports: [
      { name: 'CONSOLE', connector: null, type: 'RJ45', portFunction: 'CONSOLE' },
      { name: 'MGMT', connector: null, type: 'RJ45', portFunction: 'MGMT' },
      { name: 'USB', connector: 'USB_MINI_B', type: 'OTHER', portFunction: 'MGMT' },
      { name: '10GE-1', connector: 'SFP_PLUS', type: 'SFP_PLUS', portFunction: 'UPLINK' },
      { name: '10GE-2', connector: 'SFP_PLUS', type: 'SFP_PLUS', portFunction: 'UPLINK' },
      { name: 'GE-1', connector: 'SFP', type: 'SFP', portFunction: 'SERVICE' },
      { name: 'GE-2', connector: 'SFP', type: 'SFP', portFunction: 'SERVICE' },
    ],
  },
  {
    key: 'huawei-h902mpla',
    name: 'H902MPLA (uplink)',
    model: 'H902MPLA',
    partNumber: 'H902MPLA',
    role: 'UPLINK',
    ports: Array.from({ length: 4 }, (_value, index) => ({
      name: `UPLINK-${index + 1}`,
      connector: 'OTHER' as PhysicalConnectorKind,
      type: 'OTHER' as PhysicalPortType,
      portFunction: 'UPLINK' as PhysicalPortFunction,
    })),
  },
  {
    key: 'huawei-pac600s12-cb',
    name: 'PAC600S12-CB (fonte)',
    model: 'PAC600S12-CB',
    partNumber: 'PAC600S12-CB',
    role: 'POWER',
    ports: [],
  },
];

/**
 * `moduleKeys` por papel do slot — espelho das declarações do catálogo
 * (`slotGroups[].moduleKeys` em `physical-catalog-v1.yaml`).
 */
const MODULE_KEYS_BY_ROLE: Record<string, readonly string[]> = {
  SERVICE_OR_UPLINK: ['huawei-gpfd-16', 'huawei-xgspon-16', 'huawei-h902mpla'],
  UNIVERSAL: ['huawei-h902mpla'],
  CONTROL: ['huawei-h901mpsc'],
  POWER: ['huawei-pac600s12-cb'],
  LPU: [],
};

export interface SlotLabChassisSpec {
  catalogKey: string;
  name: string;
  model: string;
  family: string;
  heightU: number;
  kind: 'NETWORK' | 'OLT';
}

/** Chassis da bancada (SKUs exatos do catálogo; altura vem do catálogo). */
export const SLOT_LAB_CHASSIS: readonly SlotLabChassisSpec[] = [
  {
    catalogKey: 'huawei-ne8000-m4',
    name: 'NetEngine 8000 M4',
    model: 'NetEngine 8000 M4',
    family: 'NetEngine 8000',
    heightU: 2,
    kind: 'NETWORK',
  },
  {
    catalogKey: 'huawei-ne8000-m8-dc',
    name: 'NetEngine 8000 M8 (DC)',
    model: 'NetEngine 8000 M8 (DC)',
    family: 'NetEngine 8000',
    heightU: 3,
    kind: 'NETWORK',
  },
  {
    catalogKey: 'huawei-ne8000-m8-ac',
    name: 'NetEngine 8000 M8 (AC)',
    model: 'NetEngine 8000 M8 (AC)',
    family: 'NetEngine 8000',
    heightU: 3,
    kind: 'NETWORK',
  },
  {
    catalogKey: 'huawei-ma5800-x2',
    name: 'MA5800-X2',
    model: 'MA5800-X2',
    family: 'MA5800',
    heightU: 2,
    kind: 'OLT',
  },
  {
    catalogKey: 'huawei-ma5800-x7',
    name: 'MA5800-X7',
    model: 'MA5800-X7',
    family: 'MA5800',
    heightU: 6,
    kind: 'OLT',
  },
  {
    catalogKey: 'huawei-ma5800-x15',
    name: 'MA5800-X15',
    model: 'MA5800-X15',
    family: 'MA5800',
    heightU: 11,
    kind: 'OLT',
  },
  {
    catalogKey: 'huawei-ma5800-x17',
    name: 'MA5800-X17',
    model: 'MA5800-X17',
    family: 'MA5800',
    heightU: 11,
    kind: 'OLT',
  },
];

export function slotLabChassis(catalogKey: string): SlotLabChassisSpec | null {
  return SLOT_LAB_CHASSIS.find((chassis) => chassis.catalogKey === catalogKey) ?? null;
}

export function slotLabModule(key: string): SlotLabModuleSpec | null {
  return SLOT_LAB_MODULES.find((module) => module.key === key) ?? null;
}

/** Slots do chassi no Slot Lab: bbox/ordinal do mapa, papel declarado. */
export function slotLabSlots(
  catalogKey: string,
): { ordinal: number; role: string; label: string; orientation: 'HORIZONTAL' | 'VERTICAL' }[] {
  const map = modularChassisMap(catalogKey);
  if (!map) return [];
  return map.slots.map((slot) => ({
    ordinal: slot.ordinal,
    role: slot.role,
    label: `Slot ${slot.ordinal} · ${slotRoleLabel(slot.role)}`,
    orientation: slotOrientation(slot.bbox),
  }));
}

/** `moduleKeys` aceitos por um slot (vazio = sem declaração no catálogo). */
export function slotLabModuleKeys(catalogKey: string, ordinal: number): string[] {
  const slot = slotLabSlots(catalogKey).find((candidate) => candidate.ordinal === ordinal);
  if (!slot) return [];
  return [...(MODULE_KEYS_BY_ROLE[slot.role] ?? [])];
}

/** Estado local do Slot Lab: ordinal → moduleKey instalado. */
export type SlotLabState = Readonly<Record<number, string>>;

export interface SlotLabInstallResult {
  ok: boolean;
  reason: string;
  state: SlotLabState;
}

/**
 * Tenta instalar um módulo. Incompatibilidade é **recusada**, não desenhada:
 * a resposta carrega o motivo para a bancada mostrar o porque.
 */
export function tryInstallModule(
  state: SlotLabState,
  catalogKey: string,
  ordinal: number,
  moduleKey: string,
): SlotLabInstallResult {
  const slot = slotLabSlots(catalogKey).find((candidate) => candidate.ordinal === ordinal);
  if (!slot) return { ok: false, reason: `Slot ${ordinal} não existe neste chassi.`, state };
  if (!slotLabModule(moduleKey)) {
    return { ok: false, reason: `Módulo ${moduleKey} desconhecido na bancada.`, state };
  }
  const allowed = slotLabModuleKeys(catalogKey, ordinal);
  if (!allowed.includes(moduleKey)) {
    return {
      ok: false,
      reason: allowed.length
        ? `Incompatível: o slot ${ordinal} aceita ${allowed.join(', ')}.`
        : `Slot ${ordinal} não declara módulos compatíveis no catálogo.`,
      state,
    };
  }
  return { ok: true, reason: `${moduleKey} instalado no slot ${ordinal}.`, state: { ...state, [ordinal]: moduleKey } };
}

export function removeModule(state: SlotLabState, ordinal: number): SlotLabState {
  const next: Record<number, string> = { ...state };
  delete next[ordinal];
  return next;
}

export function clearModules(): SlotLabState {
  return {};
}

/**
 * Categoria visual do módulo na bancada — mesma taxonomia do catálogo
 * (papel do slot). Serve só para a paleta/aparência, nunca para compatibilidade.
 */
const MODULE_CATEGORY: Record<string, string> = {
  'huawei-gpfd-16': 'service',
  'huawei-xgspon-16': 'service',
  'huawei-h902mpla': 'uplink',
  'huawei-h901mpsc': 'control',
  'huawei-pac600s12-cb': 'power',
};

export const SLOT_LAB_CATEGORY_LABELS: Record<string, string> = {
  service: 'Serviço / Line card',
  uplink: 'Uplink',
  control: 'Controle / Gerência',
  fabric: 'Switch fabric',
  power: 'Energia',
  fan: 'Ventilação',
  blank: 'Blank / Filler',
};

const CATEGORY_ORDER = ['service', 'uplink', 'control', 'fabric', 'power', 'fan', 'blank'];

export function slotLabModuleCategory(moduleKey: string): string {
  return MODULE_CATEGORY[moduleKey] ?? 'blank';
}

export interface SlotLabPaletteItem {
  moduleKey: string;
  name: string;
  partNumber: string;
  category: string;
  /** `true` quando algum slot deste chassi declara o moduleKey. */
  supported: boolean;
  /** Slots do chassi que aceitam o módulo (declarados no catálogo). */
  slotOrdinals: number[];
}

export interface SlotLabPaletteGroup {
  category: string;
  label: string;
  items: SlotLabPaletteItem[];
}

/** Itens da paleta com o que cada chassi aceita (moduleKeys do catálogo). */
export function slotLabPaletteItems(catalogKey: string): SlotLabPaletteItem[] {
  const slots = slotLabSlots(catalogKey);
  return SLOT_LAB_MODULES.map((spec) => {
    const slotOrdinals = slots
      .filter((slot) => slotLabModuleKeys(catalogKey, slot.ordinal).includes(spec.key))
      .map((slot) => slot.ordinal);
    return {
      moduleKey: spec.key,
      name: spec.name,
      partNumber: spec.partNumber,
      category: slotLabModuleCategory(spec.key),
      supported: slotOrdinals.length > 0,
      slotOrdinals,
    };
  });
}

/** Paleta agrupada por categoria (só os aceitos pelo chassi). */
export function slotLabPalette(catalogKey: string): SlotLabPaletteGroup[] {
  const items = slotLabPaletteItems(catalogKey).filter((item) => item.supported);
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: SLOT_LAB_CATEGORY_LABELS[category] ?? category,
    items: items.filter((item) => item.category === category),
  })).filter((group) => group.items.length > 0);
}

/** Módulos que nenhum slot deste chassi aceita (bloco "não suportados"). */
export function slotLabUnsupported(catalogKey: string): SlotLabPaletteItem[] {
  return slotLabPaletteItems(catalogKey).filter((item) => !item.supported);
}

/** Realce de encaixe do módulo armado, por slot (o LAB decide, o canvas desenha). */
export function slotLabFit(
  catalogKey: string,
  ordinal: number,
  armedModuleKey: string | null,
): SlotFitView | null {
  if (!armedModuleKey) return null;
  const allowed = slotLabModuleKeys(catalogKey, ordinal);
  if (allowed.includes(armedModuleKey)) return { tone: 'ok' };
  return {
    tone: 'bad',
    reason: allowed.length
      ? `aceita ${allowed.join(', ')}`
      : 'sem moduleKeys declarados no catálogo',
  };
}

/** Ficha do slot para o inspector da bancada. */
export interface SlotLabSlotInfo {
  ordinal: number;
  label: string;
  role: string;
  orientation: 'HORIZONTAL' | 'VERTICAL';
  moduleKeys: string[];
  installedModuleKey: string | null;
  installedName: string | null;
}

export function slotLabSlotInfo(
  catalogKey: string,
  ordinal: number,
  state: SlotLabState,
): SlotLabSlotInfo | null {
  const slot = slotLabSlots(catalogKey).find((candidate) => candidate.ordinal === ordinal);
  if (!slot) return null;
  const installedModuleKey = state[ordinal] ?? null;
  return {
    ordinal,
    label: slot.label,
    role: slot.role,
    orientation: slot.orientation,
    moduleKeys: slotLabModuleKeys(catalogKey, ordinal),
    installedModuleKey,
    installedName: installedModuleKey ? (slotLabModule(installedModuleKey)?.name ?? null) : null,
  };
}

function modulePorts(spec: SlotLabModuleSpec, slotId: string): PhysicalPort[] {
  return spec.ports.map((port, index) =>
    physicalPort({
      id: `${SLOT_LAB_ASSET_ID}-${slotId}-${port.name}`,
      assetId: SLOT_LAB_ASSET_ID,
      slotId,
      moduleId: `${SLOT_LAB_ASSET_ID}-${slotId}-module`,
      name: port.name,
      label: port.name,
      order: index + 1,
      side: 'DEVICE',
      type: port.type,
    }),
  );
}

/** Templates de placa da bancada: é o que liga o módulo ao desenho real. */
function moduleTemplates(): PhysicalEquipmentTemplate['modules'] {
  return SLOT_LAB_MODULES.map((spec) => ({
    id: spec.key,
    catalogKey: spec.key,
    name: spec.name,
    model: spec.model,
    description: '',
    slotsRequired: 1,
    ports: [],
  }));
}

/** Equipamento da bancada com os módulos instalados no estado atual. */
export function buildSlotLabAsset(chassisKey: string, state: SlotLabState): PhysicalAsset {
  const chassis = slotLabChassis(chassisKey);
  const slots = slotLabSlots(chassisKey);
  const modules = slots.flatMap((slot) => {
    const key = state[slot.ordinal];
    const spec = key ? slotLabModule(key) : null;
    if (!spec) return [];
    const slotId = `${SLOT_LAB_ASSET_ID}-slot-${slot.ordinal}`;
    return [
      physicalModule({
        id: `${SLOT_LAB_ASSET_ID}-${slotId}-module`,
        assetId: SLOT_LAB_ASSET_ID,
        slotId,
        slotIndex: slot.ordinal,
        moduleTemplateId: spec.key,
        name: spec.name,
        model: spec.model,
        ports: modulePorts(spec, slotId),
      }),
    ];
  });
  return physicalAsset({
    id: SLOT_LAB_ASSET_ID,
    name: chassis?.name ?? chassisKey,
    kind: chassis?.kind ?? 'NETWORK',
    startU: 1,
    heightU: chassis?.heightU ?? 2,
    description: 'Slot Lab (estado local, nada é gravado)',
    templateId: `template-${chassisKey}`,
    template: physicalTemplate({
      id: `template-${chassisKey}`,
      catalogKey: chassisKey,
      name: chassis?.name ?? chassisKey,
      category: chassis?.kind === 'OLT' ? 'OLT' : 'ROUTER',
      family: chassis?.family ?? '',
      model: chassis?.model ?? chassisKey,
      kind: chassis?.kind ?? 'NETWORK',
      heightU: chassis?.heightU ?? 2,
      vendorVerified: true,
      structureConfirmed: true,
      modules: moduleTemplates(),
    }),
    ports: modules.flatMap((module) => module.ports),
    modules,
    slots: slots.map((slot) => {
      const slotId = `${SLOT_LAB_ASSET_ID}-slot-${slot.ordinal}`;
      const module = modules.find((candidate) => candidate.slotId === slotId) ?? null;
      return physicalSlot({
        id: slotId,
        assetId: SLOT_LAB_ASSET_ID,
        index: slot.ordinal,
        label: slot.label,
        module,
      });
    }),
  });
}

/**
 * Entrada de catálogo da bancada: slots com os `moduleKeys` reais e os módulos
 * da bancada com as portas declaradas — é o que o canvas usa para resolver
 * conector, compatibilidade e o desenho da placa.
 */
export function buildSlotLabCatalog(chassisKey: string, state: SlotLabState): PhysicalCatalogEntry {
  const chassis = slotLabChassis(chassisKey);
  const slots = slotLabSlots(chassisKey);
  const catalogModules: PhysicalCatalogModule[] = SLOT_LAB_MODULES.map((spec) => ({
    key: spec.key,
    name: spec.name,
    model: spec.model,
    partNumber: spec.partNumber,
    description: '',
    slotsRequired: 1,
    vendorVerified: false,
    ports: spec.ports.map((port, index) => ({
      name: port.name,
      label: port.name,
      order: index + 1,
      side: 'DEVICE',
      type: port.type,
      connector: port.connector,
      portFunction: port.portFunction,
      speeds: [],
      breakoutCapable: false,
      groupKey: `${spec.key}-group`,
      interfaceName: null,
      notes: null,
      visual: null,
    })) satisfies PhysicalCatalogPort[],
  }));
  return catalogEntry({
    catalogKey: chassisKey,
    name: `Huawei ${chassis?.model ?? chassisKey}`,
    manufacturer: 'Huawei',
    family: chassis?.family ?? '',
    model: chassis?.model ?? chassisKey,
    kind: chassis?.kind ?? 'NETWORK',
    heightU: chassis?.heightU ?? 2,
    layoutType: 'MODULAR',
    slots: slots.map((slot) => ({
      index: slot.ordinal,
      label: slot.label,
      description: '',
      moduleKeys: slotLabModuleKeys(chassisKey, slot.ordinal),
      slotRole: slot.role,
      groupKey: null,
      capacityNote: null,
      visual: null,
    })),
    modules: catalogModules,
    // o catálogo real declara compatibilidade por slot; aqui só o instalado
    // precisa resolver o desenho, então os módulos ficam todos disponíveis.
    compatibleModuleKeys: [...new Set(Object.values(state))],
  });
}
