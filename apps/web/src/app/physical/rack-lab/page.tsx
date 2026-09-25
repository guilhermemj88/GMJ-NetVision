'use client';

import { useMemo, useState } from 'react';
import type {
  PhysicalCatalogPort,
  PhysicalConnectorKind,
  PhysicalEquipmentTemplate,
  PhysicalPortFunction,
  PhysicalPortType,
  PhysicalVisualPlacement,
} from '@gmj/shared';
import { PhysicalRackCanvas } from '@/components/physical/physical-rack-canvas';
import { FixedLibraryGallery } from '@/components/physical/fixed-library-gallery';
import type {
  PhysicalConnectionMode,
  PhysicalSelection,
  PhysicalVisualMode,
} from '@/components/physical/physical-types';
import { PhysicalVisualToggle } from '@/components/physical/physical-visual-toggle';
import {
  PHYSICAL_TIMESTAMP,
  catalogEntry,
  physicalAsset,
  physicalConnection,
  physicalModule,
  physicalPort,
  physicalRack,
  physicalSlot,
} from '@/components/physical/physical-fixtures';
import { modularChassisMap } from '@/components/physical/modular-chassis-map';
import { slotRoleLabel } from '@/components/physical/physical-catalog';
import {
  SLOT_LAB_CHASSIS,
  SLOT_LAB_MODULES,
  type SlotLabState,
  buildSlotLabAsset,
  buildSlotLabCatalog,
  clearModules,
  removeModule,
  slotLabFit,
  slotLabModuleKeys,
  slotLabPalette,
  slotLabPaletteItems,
  slotLabSlotInfo,
  slotLabSlots,
  slotLabUnsupported,
  tryInstallModule,
} from '@/components/physical/slot-lab';

/** Cores funcionais por categoria (paleta do protótipo de referência). */
const SLOT_LAB_CATEGORY_COLORS: Record<string, string> = {
  service: '#22b8e6',
  uplink: '#3b82f6',
  control: '#a855f7',
  fabric: '#818cf8',
  universal: '#f59e0b',
  power: '#22c55e',
  fan: '#94a3b8',
  blank: '#64748b',
};

/**
 * Bancada local de teste do módulo físico (chassi → slot → placa → porta → cabo).
 *
 * Só **fixture**: nada é lido nem gravado no inventário, no catálogo ou no banco.
 * Serve para conferir visualmente o encaixe da placa no slot do chassi por
 * imagem e a âncora do cabo saindo da porta da placa.
 */

const TIMESTAMP = PHYSICAL_TIMESTAMP;
const CABLE_ID = 'lab-cable-01';
const OLT_ID = 'lab-olt';
const SWITCH_ID = 'lab-s6730-h48';
const F1A_ID = 'lab-f1a';
const S6750_ID = 'lab-s6750';
const MODULE_ID = 'lab-module-1';

/** Chassis disponíveis na bancada (fixture, nada é gravado). */
const CHASSIS_OPTIONS = [
  { key: 'huawei-ma5800-x2', name: 'MA5800-X2', heightU: 2, kind: 'OLT' },
  { key: 'huawei-ma5800-x7', name: 'MA5800-X7', heightU: 6, kind: 'OLT' },
  { key: 'huawei-ma5800-x15', name: 'MA5800-X15', heightU: 11, kind: 'OLT' },
  { key: 'huawei-ma5800-x17', name: 'MA5800-X17', heightU: 11, kind: 'OLT' },
  { key: 'huawei-ma5683t', name: 'MA5683T', heightU: 1, kind: 'OLT' },
  { key: 'huawei-ne8000-m4', name: 'NetEngine 8000 M4', heightU: 2, kind: 'ROUTER' },
  { key: 'huawei-ne8000-m8-dc', name: 'NetEngine 8000 M8 (DC)', heightU: 3, kind: 'ROUTER' },
  { key: 'huawei-ne8000-m8-ac', name: 'NetEngine 8000 M8 (AC)', heightU: 3, kind: 'ROUTER' },
  { key: 'huawei-ne40e-x3-dc', name: 'NE40E-X3 (DC)', heightU: 4, kind: 'ROUTER' },
  { key: 'huawei-ne40e-x3-ac', name: 'NE40E-X3 (AC)', heightU: 5, kind: 'ROUTER' },
  { key: 'huawei-ne40e-x3a', name: 'NE40E-X3A', heightU: 6, kind: 'ROUTER' },
  { key: 'huawei-ne40e-x8', name: 'NE40E-X8', heightU: 14, kind: 'ROUTER' },
  { key: 'huawei-ne40e-x8a', name: 'NE40E-X8A', heightU: 21, kind: 'ROUTER' },
  { key: 'huawei-ne40e-x16', name: 'NE40E-X16', heightU: 32, kind: 'ROUTER' },
  { key: 'huawei-ne40e-x16a', name: 'NE40E-X16A', heightU: 40, kind: 'ROUTER' },
] as const;

/** Chassi da bancada: identidade vinda da chave exata do catálogo (nada é inventado). */
function chassisTemplate(
  key: string,
  name: string,
  heightU: number,
): PhysicalEquipmentTemplate {
  const isRouter = key.includes('ne8000') || key.includes('ne40e');
  const family = key.includes('ma5683t')
    ? 'SmartAX'
    : key.includes('ne40e')
      ? 'NE40E'
      : key.includes('ne8000')
        ? 'NetEngine 8000'
        : 'MA5800';
  return {
    id: `template-${key}`,
    catalogKey: key,
    name,
    category: isRouter ? 'ROUTER' : 'OLT',
    manufacturer: 'Huawei',
    family,
    model: name,
    kind: isRouter ? 'NETWORK' : 'OLT',
    heightU,
    description: '',
    vendorVerified: key !== 'huawei-ma5683t',
    structureConfirmed: key !== 'huawei-ma5683t',
    referenceUrl: null,
    origin: 'SYSTEM',
    ports: [],
    slots: [],
    modules: [],
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

/** Switch/família fixa da bancada: mesmo layout declarado no catálogo. */
function fixedTemplate(spec: FixedDeviceSpec): PhysicalEquipmentTemplate {
  return {
    ...chassisTemplate(spec.catalogKey, spec.model, 1),
    id: `template-${spec.catalogKey}`,
    category: 'SWITCH',
    family: spec.family,
    kind: 'NETWORK',
    vendorVerified: spec.vendorVerified ?? true,
    structureConfirmed: spec.vendorVerified ?? true,
  };
}

/** Slots da bancada: vêm do próprio manifesto do chassi (ordinal + papel). */
function labSlots(chassisKey: string): Array<ReturnType<typeof physicalSlot>> {
  const map = modularChassisMap(chassisKey);
  if (!map) return [];
  return map.slots.map((mapped) =>
    physicalSlot({
      id: `${chassisKey}-slot-${mapped.ordinal}`,
      assetId: OLT_ID,
      index: mapped.ordinal,
      label: `Slot ${mapped.ordinal} · ${slotRoleLabel(mapped.role)}`,
    }),
  );
}

/** 16 portas GPON da placa (nomes estáveis do mapa: GPON-1..GPON-16). */
function boardPorts(slotId: string) {
  return Array.from({ length: 16 }, (_value, index) =>
    physicalPort({
      id: `lab-gpon-${index + 1}`,
      assetId: OLT_ID,
      slotId,
      moduleId: MODULE_ID,
      name: `GPON-${index + 1}`,
      label: `GPON-${index + 1}`,
      order: index + 1,
      side: 'DEVICE',
      // FIBER → receptáculo óptico (PON), nunca RJ45.
      type: 'FIBER',
      ...(index === 0 ? { state: 'CONNECTED' as const, connectionId: CABLE_ID } : {}),
    }),
  );
}

/** Placa GPFD da OLT (caso A: módulo com mapa próprio no catálogo). */
function boardModule(slotId: string): ReturnType<typeof physicalModule> {
  return physicalModule({
    id: MODULE_ID,
    assetId: OLT_ID,
    slotId,
    slotIndex: 1,
    name: 'GPFD 16 portas GPON',
    model: 'H802GPFD',
    ports: boardPorts(slotId),
  });
}

/**
 * Placa genérica para roteadores da bancada (caso B): módulo SEM mapa frontal
 * próprio — o canvas não inventa geometria e mostra a nota honesta.
 */
function genericBoard(slotId: string): ReturnType<typeof physicalModule> {
  return physicalModule({
    id: MODULE_ID,
    assetId: OLT_ID,
    slotId,
    slotIndex: 1,
    name: 'Placa de linha genérica',
    model: 'sem mapa frontal',
    ports: [],
  });
}

interface FixedGroupSpec {
  groupKey: string;
  count: number;
  connector: PhysicalConnectorKind;
  type: PhysicalPortType;
  portFunction: PhysicalPortFunction;
  /** Padrão do rótulo físico (`10GE-{n}`), como declarado no catálogo. */
  pattern: string;
  /** Primeiro número físico do grupo no painel (0 no F1A-8H20Q). */
  panelStart?: number;
  visual: PhysicalVisualPlacement;
}

interface FixedDeviceSpec {
  catalogKey: string;
  name: string;
  model: string;
  family: string;
  assetId: string;
  startU: number;
  panelHeight: number;
  /** Largura declarada do painel (default 100). */
  panelWidth?: number;
  /** `FRONT` só quando a bancada codifica o painel frontal oficial. */
  panelType?: 'FRONT' | 'LOGICAL';
  /** `false` para placeholders de família (desenho técnico não se aplica). */
  vendorVerified?: boolean;
  groups: FixedGroupSpec[];
}

/**
 * Equipamentos FIXOS da bancada (SKUs exatos + um placeholder de família).
 *
 * As coordenadas `visual` são as mesmas declaradas no catálogo
 * (`physical-catalog-v1.yaml`) — a bancada não inventa layout nem portas.
 * O placeholder `huawei-s6720-family` fica de fora da visão técnica de
 * propósito: sem painel exato, sem desenho inventado.
 */
const FIXED_DEVICES: FixedDeviceSpec[] = [
  {
    catalogKey: 'huawei-s6730-h24x6c',
    name: 'SW-DIST-S6730-24',
    model: 'S6730-H24X6C',
    family: 'S6730',
    assetId: 'lab-s6730-h24',
    startU: 32,
    panelHeight: 8,
    groups: [
      {
        groupKey: 'sfpplus-10g',
        count: 24,
        connector: 'SFP_PLUS',
        type: 'SFP_PLUS',
        portFunction: 'SERVICE',
        pattern: '10GE-{n}',
        visual: { row: 1, columns: 24, x: 3, y: 0.6, gapX: 0.6 },
      },
      {
        groupKey: 'qsfp28-uplink',
        count: 6,
        connector: 'QSFP28',
        type: 'QSFP',
        portFunction: 'UPLINK',
        pattern: 'QSFP28-{n}',
        visual: { row: 3, columns: 6, x: 38, y: 6.4, gapX: 0.6 },
      },
    ],
  },
  {
    catalogKey: 'huawei-s6730-h24x6c-v2',
    name: 'SW-DIST-S6730-24V2',
    model: 'S6730-H24X6C-V2',
    family: 'S6730',
    assetId: 'lab-s6730-h24-v2',
    startU: 33,
    panelHeight: 8,
    groups: [
      {
        groupKey: 'sfpplus-10g',
        count: 24,
        connector: 'SFP_PLUS',
        type: 'SFP_PLUS',
        portFunction: 'SERVICE',
        pattern: '10GE-{n}',
        visual: { row: 1, columns: 24, x: 3, y: 0.6, gapX: 0.6 },
      },
      {
        groupKey: 'qsfp28-uplink',
        count: 6,
        connector: 'QSFP28',
        type: 'QSFP',
        portFunction: 'UPLINK',
        pattern: 'QSFP28-{n}',
        visual: { row: 3, columns: 6, x: 38, y: 6.4, gapX: 0.6 },
      },
    ],
  },
  {
    catalogKey: 'huawei-s6730-h48x6c',
    name: 'SW-CORE-S6730-48',
    model: 'S6730-H48X6C',
    family: 'S6730',
    assetId: SWITCH_ID,
    startU: 34,
    panelHeight: 10,
    groups: [
      {
        groupKey: 'sfpplus-10g',
        count: 48,
        connector: 'SFP_PLUS',
        type: 'SFP_PLUS',
        portFunction: 'SERVICE',
        pattern: '10GE-{n}',
        visual: { row: 1, columns: 24, x: 3, y: 0.6, gapX: 0.6 },
      },
      {
        groupKey: 'qsfp28-uplink',
        count: 6,
        connector: 'QSFP28',
        type: 'QSFP',
        portFunction: 'UPLINK',
        pattern: 'QSFP28-{n}',
        visual: { row: 3, columns: 6, x: 38, y: 6.4, gapX: 0.6 },
      },
    ],
  },
  {
    catalogKey: 'huawei-s6730-h48x6c-v2',
    name: 'SW-CORE-S6730-48V2',
    model: 'S6730-H48X6C-V2',
    family: 'S6730',
    assetId: 'lab-s6730-h48-v2',
    startU: 35,
    panelHeight: 10,
    groups: [
      {
        groupKey: 'sfpplus-10g',
        count: 48,
        connector: 'SFP_PLUS',
        type: 'SFP_PLUS',
        portFunction: 'SERVICE',
        pattern: '10GE-{n}',
        visual: { row: 1, columns: 24, x: 3, y: 0.6, gapX: 0.6 },
      },
      {
        groupKey: 'qsfp28-uplink',
        count: 6,
        connector: 'QSFP28',
        type: 'QSFP',
        portFunction: 'UPLINK',
        pattern: 'QSFP28-{n}',
        visual: { row: 3, columns: 6, x: 38, y: 6.4, gapX: 0.6 },
      },
    ],
  },
  {
    catalogKey: 'huawei-ne8000-f1a-8h20q',
    name: 'BHE-VTA-F1A-BGP',
    model: 'F1A-8H20Q',
    family: 'NetEngine 8000',
    assetId: F1A_ID,
    startU: 36,
    // Painel frontal real: uma faixa de 28 colunas × 2 fileiras, 0-55.
    panelHeight: 7,
    panelWidth: 118,
    panelType: 'FRONT',
    groups: [
      {
        groupKey: 'sfpplus-10g',
        count: 28,
        connector: 'SFP_PLUS',
        type: 'SFP_PLUS',
        portFunction: 'SERVICE',
        pattern: '10GE-{n}',
        panelStart: 0,
        visual: { row: 1, x: 2, y: 0.6, gapX: 0.6, pairing: 'EVEN_ODD' },
      },
      {
        groupKey: 'sfp28-25g-a',
        count: 8,
        connector: 'SFP28',
        type: 'SFP_PLUS',
        portFunction: 'SERVICE',
        pattern: '25GE-{n}',
        panelStart: 28,
        visual: { row: 1, x: 55.4, y: 0.6, gapX: 0.6, pairing: 'EVEN_ODD' },
      },
      {
        groupKey: 'sfp28-25g-b',
        count: 12,
        connector: 'SFP28',
        type: 'SFP_PLUS',
        portFunction: 'SERVICE',
        pattern: '25GE-{n}',
        panelStart: 36,
        visual: { row: 1, x: 70.8, y: 0.6, gapX: 0.6, pairing: 'EVEN_ODD' },
      },
      {
        groupKey: 'qsfp28-100g',
        count: 8,
        connector: 'QSFP28',
        type: 'QSFP',
        portFunction: 'UPLINK',
        pattern: '100GE-{n}',
        panelStart: 48,
        visual: { row: 1, x: 93.8, y: 0.6, gapX: 0.6, pairing: 'EVEN_ODD' },
      },
    ],
  },
  {
    catalogKey: 'huawei-s6750-h48x8c',
    name: 'SW-AGG-S6750-48',
    model: 'S6750-H48X8C',
    family: 'S6750',
    assetId: S6750_ID,
    startU: 37,
    panelHeight: 10,
    groups: [
      {
        groupKey: 'sfp28-service',
        count: 48,
        connector: 'SFP28',
        type: 'SFP_PLUS',
        portFunction: 'SERVICE',
        pattern: 'SFP28-{n}',
        visual: { row: 1, columns: 24, x: 3, y: 0.6, gapX: 0.6 },
      },
      {
        groupKey: 'qsfp28-uplink',
        count: 8,
        connector: 'QSFP28',
        type: 'QSFP',
        portFunction: 'UPLINK',
        pattern: 'QSFP28-{n}',
        visual: { row: 3, columns: 8, x: 32, y: 6.4, gapX: 0.6 },
      },
    ],
  },
  {
    catalogKey: 'huawei-s6750-h48y8c',
    name: 'SW-AGG-S6750-48Y',
    model: 'S6750-H48Y8C',
    family: 'S6750',
    assetId: 'lab-s6750-h48y',
    startU: 38,
    panelHeight: 10,
    groups: [
      {
        groupKey: 'sfp28-service',
        count: 48,
        connector: 'SFP28',
        type: 'SFP_PLUS',
        portFunction: 'SERVICE',
        pattern: 'SFP28-{n}',
        visual: { row: 1, columns: 24, x: 3, y: 0.6, gapX: 0.6 },
      },
      {
        groupKey: 'qsfp28-uplink',
        count: 8,
        connector: 'QSFP28',
        type: 'QSFP',
        portFunction: 'UPLINK',
        pattern: 'QSFP28-{n}',
        visual: { row: 3, columns: 8, x: 32, y: 6.4, gapX: 0.6 },
      },
    ],
  },
  {
    catalogKey: 'huawei-s6750-h48y8c-b',
    name: 'SW-AGG-S6750-48YB',
    model: 'S6750-H48Y8C-B',
    family: 'S6750',
    assetId: 'lab-s6750-h48y-b',
    startU: 39,
    panelHeight: 10,
    groups: [
      {
        groupKey: 'sfp28-service',
        count: 48,
        connector: 'SFP28',
        type: 'SFP_PLUS',
        portFunction: 'SERVICE',
        pattern: 'SFP28-{n}',
        visual: { row: 1, columns: 24, x: 3, y: 0.6, gapX: 0.6 },
      },
      {
        groupKey: 'qsfp28-uplink',
        count: 8,
        connector: 'QSFP28',
        type: 'QSFP',
        portFunction: 'UPLINK',
        pattern: 'QSFP28-{n}',
        visual: { row: 3, columns: 8, x: 32, y: 6.4, gapX: 0.6 },
      },
    ],
  },
  {
    catalogKey: 'huawei-s6750-h36c',
    name: 'SW-SPINE-S6750-36',
    model: 'S6750-H36C',
    family: 'S6750',
    assetId: 'lab-s6750-h36c',
    startU: 40,
    panelHeight: 8,
    groups: [
      {
        groupKey: 'qsfp28-service',
        count: 32,
        connector: 'QSFP28',
        type: 'QSFP',
        portFunction: 'SERVICE',
        pattern: 'QSFP28-{n}',
        visual: { row: 1, columns: 16, x: 4, y: 0.6, gapX: 0.8 },
      },
      {
        groupKey: 'qsfp28-uplink',
        count: 4,
        connector: 'QSFP28',
        type: 'QSFP',
        portFunction: 'UPLINK',
        // Catálogo: uplinks com ordinal contínuo (33–36).
        pattern: 'QSFP28-{n+32}',
        visual: { row: 3, columns: 4, x: 58, y: 6.4, gapX: 0.8 },
      },
    ],
  },
  {
    catalogKey: 'huawei-s6720-family',
    name: 'SW-GENERIC-S6720',
    model: 'S6720 (família)',
    family: 'S6720',
    assetId: 'lab-s6720-family',
    startU: 41,
    panelHeight: 6,
    vendorVerified: false,
    groups: [],
  },
];

/** Nome da porta pelo padrão do catálogo (`10GE-{n}` ou ordinal contínuo `{n+32}`). */
function groupPortName(group: FixedGroupSpec, index: number): string {
  const start = group.panelStart ?? 1;
  const offset = /^(.+)\{n\+(\d+)\}$/.exec(group.pattern);
  if (offset) return `${offset[1]}${start + index - 1 + Number(offset[2])}`;
  return group.pattern.replace('{n}', String(start + index - 1));
}

function fixedPortNames(spec: FixedDeviceSpec): Array<{ group: FixedGroupSpec; name: string }> {
  const list: Array<{ group: FixedGroupSpec; name: string }> = [];
  for (const group of spec.groups) {
    for (let index = 1; index <= group.count; index += 1) {
      list.push({ group, name: groupPortName(group, index) });
    }
  }
  return list;
}

function fixedPorts(spec: FixedDeviceSpec) {
  return fixedPortNames(spec).map(({ group, name }, index) =>
    physicalPort({
      id: `${spec.assetId}-${name}`,
      assetId: spec.assetId,
      name,
      label: name,
      order: index + 1,
      side: 'DEVICE',
      type: group.type,
      ...(spec.assetId === SWITCH_ID && name === '10GE-1'
        ? { state: 'CONNECTED' as const, connectionId: CABLE_ID }
        : {}),
    }),
  );
}

function fixedCatalogEntry(spec: FixedDeviceSpec) {
  /**
   * Mesma regra do loader do catálogo (`physical-catalog-yaml.ts`): a numeração
   * física começa no início do GRUPO (`panelNumberStart + índice no grupo`) —
   * nunca no índice global do painel. Sem isso o F1A exibiria 32/34 no lugar de
   * 28/30 nas portas do bloco 28–35.
   */
  const ports: PhysicalCatalogPort[] = [];
  let order = 0;
  for (const group of spec.groups) {
    for (let index = 0; index < group.count; index += 1) {
      order += 1;
      const name = groupPortName(group, index + 1);
      ports.push({
        name,
        label: name,
        order,
        side: 'DEVICE',
        type: group.type,
        connector: group.connector,
        portFunction: group.portFunction,
        speeds: [],
        breakoutCapable: false,
        groupKey: group.groupKey,
        interfaceName: null,
        panelNumber: group.panelStart === undefined ? null : group.panelStart + index,
        notes: null,
        visual: group.visual,
      });
    }
  }
  return catalogEntry({
    catalogKey: spec.catalogKey,
    name: `Huawei ${spec.model}`,
    manufacturer: 'Huawei',
    family: spec.family,
    model: spec.model,
    kind: 'NETWORK',
    panelLayout: {
      type: spec.panelType ?? 'LOGICAL',
      width: spec.panelWidth ?? 100,
      height: spec.panelHeight,
    },
    ports,
  });
}

/**
 * Primeiro slot de serviço/linha do chassi (exceto MA5683T, que não tem
 * estrutura de slots confirmada no catálogo).
 */
function boardSlotOf(chassisKey: string): string | null {
  const map = modularChassisMap(chassisKey);
  const service = map?.slots.find((mapped) =>
    ['SERVICE_OR_UPLINK', 'SERVICE', 'LPU'].includes(mapped.role),
  );
  return service ? `${chassisKey}-slot-${service.ordinal}` : null;
}

/** Chassis X16/X16A são altos demais para dividir o rack com a galeria fixa. */
function labIncludesFixedGallery(heightU: number): boolean {
  return heightU <= 31;
}

function buildLabRack(chassisKey: string) {
  const option = CHASSIS_OPTIONS.find((item) => item.key === chassisKey)!;
  const slots = labSlots(chassisKey);
  const boardSlot = boardSlotOf(chassisKey);
  const board = boardSlot
    ? option.kind === 'ROUTER'
      ? genericBoard(boardSlot)
      : boardModule(boardSlot)
    : null;
  const showFixed = labIncludesFixedGallery(option.heightU);
  const chassisKind = option.kind === 'ROUTER' ? 'NETWORK' : 'OLT';
  return physicalRack({
    id: 'lab-rack-1',
    name: 'Rack LAB-01',
    units: 42,
    assets: [
      physicalAsset({
        id: OLT_ID,
        name: `${option.kind === 'ROUTER' ? 'Roteador' : 'OLT'} ${option.name}`,
        kind: chassisKind as 'OLT' | 'NETWORK',
        startU: 1,
        heightU: option.heightU,
        description: board
          ? option.kind === 'ROUTER'
            ? `Chassi ${option.name} com placa genérica sem mapa frontal (caso B)`
            : `Chassi ${option.name} com a placa GPFD no primeiro slot de serviço`
          : `Chassi ${option.name} sem placas (fixture)`,
        templateId: `template-${chassisKey}`,
        template: chassisTemplate(chassisKey, option.name, option.heightU),
        ports: [],
        modules: board ? [board] : [],
        slots: slots.map((slot) =>
          board && slot.id === boardSlot
            ? { ...slot, module: board }
            : slot,
        ),
      }),
      ...(showFixed
        ? FIXED_DEVICES.map((spec) =>
            physicalAsset({
              id: spec.assetId,
              name: spec.name,
              kind: 'NETWORK',
              startU: spec.startU,
              heightU: 1,
              description: `Fixture ${spec.model} — visão técnica (${spec.groups.reduce(
                (total, group) => total + group.count,
                0,
              )} portas)`,
              templateId: `template-${spec.catalogKey}`,
              template: fixedTemplate(spec),
              ports: fixedPorts(spec),
            }),
          )
        : []),
    ],
  });
}

/**
 * Pontas já resolvidas (o canvas ancora o cabo por `connection.a/b`): asset,
 * rack e nome da porta de cada lado. Sem isso o cabo não é desenhado.
 */
const labConnection = physicalConnection({
  id: CABLE_ID,
  label: 'CIR-LAB-01',
  medium: 'FIBER',
  portAId: 'lab-gpon-1',
  portBId: `${SWITCH_ID}-10GE-1`,
  notes: 'Cabo de teste: porta GPON-1 da placa no primeiro slot de serviço da OLT',
  a: {
    portId: 'lab-gpon-1',
    portName: 'GPON-1',
    side: 'DEVICE',
    assetId: OLT_ID,
    assetName: 'OLT LAB-01',
    rackId: 'lab-rack-1',
    rackName: 'Rack LAB-01',
    siteId: 'lab-site-1',
    siteName: 'POP LAB',
  },
  b: {
    portId: `${SWITCH_ID}-10GE-1`,
    portName: '10GE-1',
    side: 'DEVICE',
    assetId: SWITCH_ID,
    assetName: 'SW-CORE-S6730-48',
    rackId: 'lab-rack-1',
    rackName: 'Rack LAB-01',
    siteId: 'lab-site-1',
    siteName: 'POP LAB',
  },
});

/** Estilo só da bancada: deixa os hitboxes visíveis sem alterar o app. */
const labStyles = `
.is-lab-hitboxes .physical-image-panel__hitbox {
  border: 1px dashed rgba(139, 92, 246, 0.85);
  background: rgba(139, 92, 246, 0.10);
}
.is-lab-hitboxes .physical-modular-panel__slot {
  border: 1px dashed rgba(67, 197, 158, 0.85);
  background: rgba(67, 197, 158, 0.08);
}
.is-lab-hitboxes .physical-modular-panel__module-panel .physical-image-panel__hitbox {
  border-color: rgba(240, 178, 76, 0.95);
  background: rgba(240, 178, 76, 0.12);
}
`;

export default function PhysicalRackLabPage() {
  const [chassisKey, setChassisKey] = useState<string>(CHASSIS_OPTIONS[0].key);
  const [visualMode, setVisualMode] = useState<PhysicalVisualMode>('TECHNICAL');
  const [mode, setMode] = useState<PhysicalConnectionMode>('all');
  const [showHitboxes, setShowHitboxes] = useState(false);
  const [zoom, setZoom] = useState(0.75);
  const [selection, setSelection] = useState<PhysicalSelection>(null);
  // --- MODULAR SLOT LAB (estado local; nada é gravado) ---
  const [slotChassisKey, setSlotChassisKey] = useState<string>('huawei-ma5800-x7');
  const [slotOrdinal, setSlotOrdinal] = useState<number>(1);
  const [slotModuleKey, setSlotModuleKey] = useState<string>(SLOT_LAB_MODULES[0]!.key);
  const [slotState, setSlotState] = useState<SlotLabState>({});
  const [slotArmed, setSlotArmed] = useState<string | null>(null);
  const [slotMessage, setSlotMessage] = useState<string>('Bancada limpa: escolha o slot e insira um módulo.');
  const [debugSlots, setDebugSlots] = useState(false);
  const [debugBbox, setDebugBbox] = useState(false);
  const [debugAnchors, setDebugAnchors] = useState(false);
  const [debugModuleKeys, setDebugModuleKeys] = useState(false);

  const rack = useMemo(() => buildLabRack(chassisKey), [chassisKey]);
  const catalog = useMemo(() => FIXED_DEVICES.map(fixedCatalogEntry), []);
  const hasBoard = Boolean(boardSlotOf(chassisKey));
  const option = CHASSIS_OPTIONS.find((item) => item.key === chassisKey)!;
  const isOltBoard = option.kind === 'OLT' && hasBoard;
  const showFixed = labIncludesFixedGallery(option.heightU);

  const slotSlots = useMemo(() => slotLabSlots(slotChassisKey), [slotChassisKey]);
  const slotAsset = useMemo(() => buildSlotLabAsset(slotChassisKey, slotState), [slotChassisKey, slotState]);
  const slotCatalog = useMemo(
    () => buildSlotLabCatalog(slotChassisKey, slotState),
    [slotChassisKey, slotState],
  );
  const slotRack = useMemo(
    () => physicalRack({ id: 'lab-slot-rack', name: 'Slot Lab', units: 42, assets: [slotAsset] }),
    [slotAsset],
  );
  const slotAllowed = slotLabModuleKeys(slotChassisKey, slotOrdinal);
  const slotPalette = useMemo(() => slotLabPalette(slotChassisKey), [slotChassisKey]);
  const slotUnsupported = useMemo(() => slotLabUnsupported(slotChassisKey), [slotChassisKey]);
  const slotInfo = useMemo(
    () => slotLabSlotInfo(slotChassisKey, slotOrdinal, slotState),
    [slotChassisKey, slotOrdinal, slotState],
  );
  const slotArmedItem = useMemo(
    () => slotLabPaletteItems(slotChassisKey).find((item) => item.moduleKey === slotArmed) ?? null,
    [slotChassisKey, slotArmed],
  );

  /** `lab-slot-chassis-slot-3` → 3 (o slot id do catálogo é estável). */
  const ordinalOfSlotId = (slotId: string): number => {
    const match = /slot-(\d+)$/.exec(slotId);
    return match ? Number(match[1]) : Number.NaN;
  };

  /** Encaixa um módulo num slot pelo mesmo caminho da bancada (recusa com motivo). */
  const installIntoSlot = (ordinal: number, moduleKey: string) => {
    const result = tryInstallModule(slotState, slotChassisKey, ordinal, moduleKey);
    setSlotState(result.state);
    setSlotMessage(result.reason);
  };

  /** Clique no slot: encaixa o módulo armado ou só seleciona para o inspector. */
  const handleSlotClick = (slotId: string) => {
    const ordinal = ordinalOfSlotId(slotId);
    if (!Number.isFinite(ordinal)) return;
    setSlotOrdinal(ordinal);
    if (slotArmed) installIntoSlot(ordinal, slotArmed);
  };

  const removeFromSlot = (slotId: string) => {
    const ordinal = ordinalOfSlotId(slotId);
    if (!Number.isFinite(ordinal)) return;
    setSlotState((current) => removeModule(current, ordinal));
    setSlotMessage(`Slot ${ordinal} esvaziado.`);
  };

  const installSlotModule = () => {
    const result = tryInstallModule(slotState, slotChassisKey, slotOrdinal, slotModuleKey);
    setSlotState(result.state);
    setSlotMessage(result.reason);
  };

  const uninstallSlotModule = () => {
    setSlotState((current) => removeModule(current, slotOrdinal));
    setSlotMessage(`Slot ${slotOrdinal} esvaziado.`);
  };

  return (
    <main className={`physical-preview ${showHitboxes ? 'is-lab-hitboxes' : ''}`}>
      <style>{labStyles}</style>

      <section className="physical-preview__filters">
        <label>
          Chassi
          <select value={chassisKey} onChange={(event) => {
            setChassisKey(event.target.value);
            setSelection(null);
          }}>
            {CHASSIS_OPTIONS.map((item) => (
              <option key={item.key} value={item.key}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Cabos
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value as PhysicalConnectionMode)}
          >
            <option value="all">Todas</option>
            <option value="selected">Selecionado</option>
            <option value="hidden">Ocultas</option>
          </select>
        </label>
        <label className="physical-preview__debug">
          <input
            type="checkbox"
            checked={showHitboxes}
            onChange={(event) => setShowHitboxes(event.target.checked)}
          />
          Mostrar hitboxes
        </label>
        <label>
          Zoom
          <select value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
            <option value={0.45}>45%</option>
            <option value={0.55}>55%</option>
            <option value={0.75}>75%</option>
            <option value={1}>100%</option>
          </select>
        </label>
        <PhysicalVisualToggle mode={visualMode} onChange={setVisualMode} />
        <div className="physical-preview__filters-row">
          {isOltBoard ? (
            <button type="button" onClick={() => setSelection({ kind: 'port', id: 'lab-gpon-1' })}>
              Selecionar GPON-1 (placa)
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setSelection({ kind: 'port', id: `${SWITCH_ID}-10GE-1` })}
          >
            Selecionar 10GE-1 (S6730)
          </button>
          <button
            type="button"
            onClick={() => setSelection({ kind: 'port', id: `${F1A_ID}-100GE-48` })}
          >
            Selecionar 100GE-48 (F1A)
          </button>
          <button
            type="button"
            onClick={() => setSelection({ kind: 'port', id: 'lab-s6750-h36c-QSFP28-1' })}
          >
            Selecionar QSFP28-1 (S6750-H36C)
          </button>
          {isOltBoard ? (
            <button type="button" onClick={() => setSelection({ kind: 'connection', id: CABLE_ID })}>
              Selecionar cabo CIR-LAB-01
            </button>
          ) : null}
          <button type="button" onClick={() => setSelection(null)}>
            Limpar seleção
          </button>
        </div>
      </section>

      <p className="physical-preview__status">
        Bancada local (fixture, nada é gravado): <b>{option.name}</b> (altura {option.heightU}U,{' '}
        {modularChassisMap(chassisKey)?.slots.length ?? 0} baías mapeadas)
        {isOltBoard
          ? ' · GPFD 16 portas GPON (H802GPFD) no primeiro slot de serviço · GPON-1 ligada por CIR-LAB-01 à 10GE-1 do S6730-H48X6C'
          : option.kind === 'ROUTER'
            ? ' · placa genérica sem mapa frontal no primeiro slot de linha (caso B)'
            : ' · sem placa (MA5683T segue sem estrutura de slots no catálogo)'}
        {showFixed
          ? ' · galeria fixa: S6730 (H24/H48 ±V2), F1A-8H20Q, S6750 (H48X8C/H48Y8C±B/H36C) e placeholder S6720.'
          : ' · galeria fixa oculta neste chassi alto (X16/X16A).'}
      </p>

      <div style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
        <PhysicalRackCanvas
          rack={rack}
          connections={isOltBoard ? [labConnection] : []}
          mode={mode}
          selection={selection}
          path={null}
          visualMode={visualMode}
          catalog={catalog}
          onSelectAsset={() => setSelection(null)}
          onSelectPort={(id) => setSelection({ kind: 'port', id })}
          onSelectConnection={(id) => setSelection({ kind: 'connection', id })}
          onClear={() => setSelection(null)}
        />
      </div>

      {/* ============ BIBLIOTECA FIXA (catálogo real + perfil visual) ============
          Galeria dos SKUs migrados para a biblioteca visual (MagicPatterns),
          montada a partir do catálogo da API e renderizada pelo MESMO canvas do
          rack de produção. Toggles só de bancada (estado/cabo, LLDP, interface
          mapeada) para revisão visual. */}
      <FixedLibraryGallery />

      {/* ================= MODULAR SLOT LAB =================
          Bancada de encaixe: insere/remove módulos do catálogo nos slots do
          mapa, mostra incompatibilidade e os anchors reais. Só estado local. */}
      <section className="physical-preview__filters" data-lab="modular-slot-lab">
        <h2 className="physical-preview__section-title">MODULAR SLOT LAB</h2>
        <label>
          Chassi
          <select
            value={slotChassisKey}
            onChange={(event) => {
              setSlotChassisKey(event.target.value);
              setSlotState({});
              setSlotOrdinal(slotLabSlots(event.target.value)[0]?.ordinal ?? 1);
              setSlotMessage('Chassi trocado: bancada limpa.');
            }}
          >
            {SLOT_LAB_CHASSIS.map((chassis) => (
              <option key={chassis.catalogKey} value={chassis.catalogKey}>
                {chassis.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Slot
          <select
            value={slotOrdinal}
            onChange={(event) => setSlotOrdinal(Number(event.target.value))}
          >
            {slotSlots.map((slot) => (
              <option key={slot.ordinal} value={slot.ordinal}>
                {slot.label} · {slot.orientation === 'VERTICAL' ? 'vertical' : 'horizontal'}
                {slotState[slot.ordinal] ? ' · ocupado' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Módulo
          <select
            value={slotModuleKey}
            onChange={(event) => setSlotModuleKey(event.target.value)}
          >
            {SLOT_LAB_MODULES.map((module) => (
              <option key={module.key} value={module.key}>
                {module.name}
                {slotAllowed.includes(module.key) ? '' : ' — incompatível'}
              </option>
            ))}
          </select>
        </label>
        <div className="physical-preview__filters-row">
          <button type="button" onClick={installSlotModule}>
            Inserir módulo no slot {slotOrdinal}
          </button>
          <button type="button" onClick={uninstallSlotModule}>
            Remover módulo do slot {slotOrdinal}
          </button>
          <button
            type="button"
            onClick={() => {
              setSlotState(clearModules());
              setSlotMessage('Chassi esvaziado.');
            }}
          >
            Esvaziar chassi
          </button>
        </div>
        {/* Módulos do chassi agrupados por categoria (só os aceitos). */}
        <div className="slot-lab-palette" data-lab="module-palette">
          {slotPalette.map((group) => (
            <div key={group.category} className="slot-lab-palette__group">
              <h4>
                <i style={{ background: SLOT_LAB_CATEGORY_COLORS[group.category] ?? '#64748b' }} />
                {group.label}
                <small>{group.items.length}</small>
              </h4>
              <ul className="slot-lab-palette__list">
                {group.items.map((item) => (
                  <li key={item.moduleKey}>
                    <button
                      type="button"
                      className={`slot-lab-palette__item ${
                        slotArmed === item.moduleKey ? 'is-armed' : ''
                      }`}
                      aria-pressed={slotArmed === item.moduleKey}
                      title={`${item.name} — encaixa nos slots ${item.slotOrdinals.join(', ')} (moduleKeys do catálogo)`}
                      onClick={() => {
                        setSlotModuleKey(item.moduleKey);
                        setSlotArmed((current) =>
                          current === item.moduleKey ? null : item.moduleKey,
                        );
                      }}
                    >
                      <code>{item.partNumber}</code>
                      <small>slots {item.slotOrdinals.join(', ')}</small>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {slotUnsupported.length > 0 ? (
            <details className="slot-lab-palette__group" data-lab="unsupported-modules">
              <summary>
                Não suportados neste chassi ({slotUnsupported.length}) — use para testar o bloqueio
              </summary>
              <ul className="slot-lab-palette__list">
                {slotUnsupported.map((item) => (
                  <li key={item.moduleKey}>
                    <button
                      type="button"
                      className={`slot-lab-palette__item is-blocked ${
                        slotArmed === item.moduleKey ? 'is-armed' : ''
                      }`}
                      aria-pressed={slotArmed === item.moduleKey}
                      title="Nenhum slot deste chassi declara este módulo no catálogo"
                      onClick={() => {
                        setSlotModuleKey(item.moduleKey);
                        setSlotArmed((current) =>
                          current === item.moduleKey ? null : item.moduleKey,
                        );
                      }}
                    >
                      <code>{item.partNumber}</code>
                      <small>sem slot compatível</small>
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
        <div className="physical-preview__filters-row" data-lab="debug-toggles">
          <label className="physical-preview__debug">
            <input
              type="checkbox"
              checked={debugSlots}
              onChange={(event) => setDebugSlots(event.target.checked)}
            />
            Mostrar slots
          </label>
          <label className="physical-preview__debug">
            <input
              type="checkbox"
              checked={debugBbox}
              onChange={(event) => setDebugBbox(event.target.checked)}
            />
            Mostrar bbox
          </label>
          <label className="physical-preview__debug">
            <input
              type="checkbox"
              checked={debugAnchors}
              onChange={(event) => setDebugAnchors(event.target.checked)}
            />
            Mostrar port anchors
          </label>
          <label className="physical-preview__debug">
            <input
              type="checkbox"
              checked={debugModuleKeys}
              onChange={(event) => setDebugModuleKeys(event.target.checked)}
            />
            Mostrar moduleKeys
          </label>
          {slotArmed ? (
            <button type="button" onClick={() => setSlotArmed(null)}>
              Cancelar {slotArmedItem?.partNumber ?? slotArmed} (Esc)
            </button>
          ) : null}
        </div>
        <p className="physical-preview__status" data-lab="slot-lab-status">
          <b>{slotChassisKey}</b> · {slotSlots.length} slots (
          {slotSlots.filter((slot) => slot.orientation === 'VERTICAL').length} verticais) ·{' '}
          {Object.keys(slotState).length} módulo(s) instalado(s) · slot {slotOrdinal} aceita:{' '}
          {slotAllowed.length ? slotAllowed.join(', ') : 'nenhum moduleKey declarado'} ·{' '}
          {slotMessage}
        </p>
        <div className="slot-lab-inspector" data-lab="slot-inspector">
          <div className="slot-lab-inspector__card">
            <h4>{slotInfo?.label ?? `Slot ${slotOrdinal}`}</h4>
            <p>
              {slotInfo ? slotRoleLabel(slotInfo.role) : '—'} ·{' '}
              {slotInfo?.orientation === 'VERTICAL' ? 'vertical' : 'horizontal'}
            </p>
            <p>
              Ocupante:{' '}
              {slotInfo?.installedName ?? (slotInfo?.installedModuleKey || 'vazio')}
            </p>
            <code>
              {slotInfo?.moduleKeys.length
                ? slotInfo.moduleKeys.join(' · ')
                : 'sem moduleKeys declarados no catálogo'}
            </code>
          </div>
          <div
            className={`slot-lab-inspector__card ${
              slotArmedItem && !slotArmedItem.supported ? 'is-fit-bad' : ''
            }`}
          >
            <h4>
              {slotArmedItem
                ? `${slotArmedItem.partNumber} · ${slotArmedItem.name}`
                : 'Nenhum módulo armado'}
            </h4>
            {slotArmedItem ? (
              slotArmedItem.supported ? (
                <p>
                  Encaixa nos slots {slotArmedItem.slotOrdinals.join(', ')} — clique num slot para
                  instalar (substitui o que estiver lá).
                </p>
              ) : (
                <p>
                  Nenhum slot deste chassi declara este módulo: clique num slot para ver a recusa
                  com o motivo.
                </p>
              )
            ) : (
              <p>
                Clique num módulo da paleta e depois num slot — ou use os seletores e o botão
                Inserir.
              </p>
            )}
          </div>
        </div>
        <div style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
          <PhysicalRackCanvas
            rack={slotRack}
            connections={[]}
            mode={mode}
            selection={selection}
            path={null}
            visualMode={visualMode}
            catalog={[slotCatalog]}
            showSlots={debugSlots}
            showBbox={debugBbox}
            showAnchors={debugAnchors}
            showModuleKeys={debugModuleKeys}
            slotFit={(slotId) => {
              const ordinal = ordinalOfSlotId(slotId);
              if (!Number.isFinite(ordinal) || !slotArmed) return null;
              return slotLabFit(slotChassisKey, ordinal, slotArmed);
            }}
            onSelectSlot={handleSlotClick}
            onRemoveModule={removeFromSlot}
            onSelectAsset={() => setSelection(null)}
            onSelectPort={(id) => setSelection({ kind: 'port', id })}
            onSelectConnection={(id) => setSelection({ kind: 'connection', id })}
            onClear={() => setSelection(null)}
          />
        </div>
      </section>
    </main>
  );
}
