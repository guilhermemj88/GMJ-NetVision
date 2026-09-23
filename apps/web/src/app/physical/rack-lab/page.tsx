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
  { key: 'huawei-ma5800-x2', name: 'MA5800-X2', heightU: 2 },
  { key: 'huawei-ma5800-x7', name: 'MA5800-X7', heightU: 6 },
  { key: 'huawei-ma5800-x15', name: 'MA5800-X15', heightU: 11 },
  { key: 'huawei-ma5800-x17', name: 'MA5800-X17', heightU: 11 },
  { key: 'huawei-ma5683t', name: 'MA5683T', heightU: 1 },
] as const;

/** Chassi MA5800-X2 (2U) com 3 baías mapeadas — o mesmo mapa do catálogo. */
function chassisTemplate(
  key: string,
  name: string,
  heightU: number,
): PhysicalEquipmentTemplate {
  return {
    id: `template-${key}`,
    catalogKey: key,
    name,
    category: 'OLT',
    manufacturer: 'Huawei',
    family: key.includes('ma5683t') ? 'SmartAX' : 'MA5800',
    model: name,
    kind: 'OLT',
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
      type: 'SFP',
      ...(index === 0 ? { state: 'CONNECTED' as const, connectionId: CABLE_ID } : {}),
    }),
  );
}

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

interface FixedGroupSpec {
  groupKey: string;
  count: number;
  connector: PhysicalConnectorKind;
  type: PhysicalPortType;
  portFunction: PhysicalPortFunction;
  /** Padrão do rótulo físico (`10GE-{n}`), como declarado no catálogo. */
  pattern: string;
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
  groups: FixedGroupSpec[];
}

/**
 * Equipamentos FIXOS com visão técnica nesta fase (fixture).
 *
 * As coordenadas `visual` são as mesmas declaradas no catálogo (`physical-catalog-v1.yaml`)
 * para cada modelo — a bancada não inventa layout nem portas.
 */
const FIXED_DEVICES: FixedDeviceSpec[] = [
  {
    catalogKey: 'huawei-s6730-h48x6c',
    name: 'SW-CORE-S6730-48',
    model: 'S6730-H48X6C',
    family: 'S6730',
    assetId: SWITCH_ID,
    startU: 38,
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
    startU: 39,
    panelHeight: 14,
    groups: [
      {
        groupKey: '100ge-cages',
        count: 8,
        connector: 'QSFP28',
        type: 'QSFP',
        portFunction: 'UPLINK',
        pattern: '100GE-{n}',
        visual: { row: 1, columns: 8, x: 25, y: 0.6, gapX: 0.8 },
      },
      {
        groupKey: '25ge-cages',
        count: 20,
        connector: 'SFP28',
        type: 'SFP_PLUS',
        portFunction: 'SERVICE',
        pattern: '25GE-{n}',
        visual: { row: 2, columns: 10, x: 14, y: 4.4, gapX: 0.6 },
      },
      {
        groupKey: '10ge-cages',
        count: 28,
        connector: 'SFP_PLUS',
        type: 'SFP_PLUS',
        portFunction: 'SERVICE',
        pattern: '10GE-{n}',
        visual: { row: 4, columns: 14, x: 7, y: 8.2, gapX: 0.6 },
      },
    ],
  },
  {
    catalogKey: 'huawei-s6750-h48x8c',
    name: 'SW-AGG-S6750-48',
    model: 'S6750-H48X8C',
    family: 'S6750',
    assetId: S6750_ID,
    startU: 40,
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
];

function fixedPortNames(spec: FixedDeviceSpec): Array<{ group: FixedGroupSpec; name: string }> {
  const list: Array<{ group: FixedGroupSpec; name: string }> = [];
  for (const group of spec.groups) {
    for (let index = 1; index <= group.count; index += 1) {
      list.push({ group, name: group.pattern.replace('{n}', String(index)) });
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
  const ports: PhysicalCatalogPort[] = fixedPortNames(spec).map(({ group, name }, index) => ({
    name,
    label: name,
    order: index + 1,
    side: 'DEVICE',
    type: group.type,
    connector: group.connector,
    portFunction: group.portFunction,
    speeds: [],
    breakoutCapable: false,
    groupKey: group.groupKey,
    interfaceName: null,
    notes: null,
    visual: group.visual,
  }));
  return catalogEntry({
    catalogKey: spec.catalogKey,
    name: `Huawei ${spec.model}`,
    manufacturer: 'Huawei',
    family: spec.family,
    model: spec.model,
    kind: 'NETWORK',
    panelLayout: { type: 'LOGICAL', width: 100, height: spec.panelHeight },
    ports,
  });
}

/** Placa instalada no primeiro slot de serviço do chassi (exceto MA5683T). */
function boardSlotOf(chassisKey: string): string | null {
  const map = modularChassisMap(chassisKey);
  const service = map?.slots.find((mapped) => mapped.role === 'SERVICE_OR_UPLINK');
  return service ? `${chassisKey}-slot-${service.ordinal}` : null;
}

function buildLabRack(chassisKey: string) {
  const option = CHASSIS_OPTIONS.find((item) => item.key === chassisKey)!;
  const slots = labSlots(chassisKey);
  const boardSlot = boardSlotOf(chassisKey);
  const board = boardSlot ? boardModule(boardSlot) : null;
  return physicalRack({
    id: 'lab-rack-1',
    name: 'Rack LAB-01',
    units: 42,
    assets: [
      physicalAsset({
        id: OLT_ID,
        name: `OLT ${option.name}`,
        kind: 'OLT',
        startU: 20,
        heightU: option.heightU,
        description: board
          ? `Chassi ${option.name} com a placa GPFD no primeiro slot de serviço`
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
      ...FIXED_DEVICES.map((spec) =>
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
      ),
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
  const [visualMode, setVisualMode] = useState<PhysicalVisualMode>('REAL');
  const [mode, setMode] = useState<PhysicalConnectionMode>('all');
  const [showHitboxes, setShowHitboxes] = useState(false);
  const [zoom, setZoom] = useState(0.75);
  const [selection, setSelection] = useState<PhysicalSelection>(null);

  const rack = useMemo(() => buildLabRack(chassisKey), [chassisKey]);
  const catalog = useMemo(() => FIXED_DEVICES.map(fixedCatalogEntry), []);
  const hasBoard = Boolean(boardSlotOf(chassisKey));
  const option = CHASSIS_OPTIONS.find((item) => item.key === chassisKey)!;

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
          {hasBoard ? (
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
            onClick={() => setSelection({ kind: 'port', id: `${F1A_ID}-100GE-1` })}
          >
            Selecionar 100GE-1 (F1A)
          </button>
          <button
            type="button"
            onClick={() => setSelection({ kind: 'port', id: `${S6750_ID}-SFP28-1` })}
          >
            Selecionar SFP28-1 (S6750)
          </button>
          <button type="button" onClick={() => setSelection({ kind: 'connection', id: CABLE_ID })}>
            Selecionar cabo CIR-LAB-01
          </button>
          <button type="button" onClick={() => setSelection(null)}>
            Limpar seleção
          </button>
        </div>
      </section>

      <p className="physical-preview__status">
        Bancada local (fixture, nada é gravado): <b>{option.name}</b> (altura {option.heightU}U,{' '}
        {modularChassisMap(chassisKey)?.slots.length ?? 0} baías mapeadas)
        {hasBoard
          ? ' · GPFD 16 portas GPON (H802GPFD) no primeiro slot de serviço · GPON-1 ligada por CIR-LAB-01 à 10GE-1 do S6730-H48X6C'
          : ' · sem placa (MA5683T segue sem estrutura de slots no catálogo)'}
        {' · '}fixos com visão técnica: <b>S6730-H48X6C</b>, <b>F1A-8H20Q</b> e <b>S6750-H48X8C</b>.
      </p>

      <div style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
        <PhysicalRackCanvas
          rack={rack}
          connections={[labConnection]}
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
    </main>
  );
}
