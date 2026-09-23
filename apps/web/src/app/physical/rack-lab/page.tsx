'use client';

import { useMemo, useState } from 'react';
import type { PhysicalEquipmentTemplate } from '@gmj/shared';
import { PhysicalRackCanvas } from '@/components/physical/physical-rack-canvas';
import type { PhysicalConnectionMode, PhysicalSelection } from '@/components/physical/physical-types';
import {
  PHYSICAL_TIMESTAMP,
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
const SWITCH_ID = 'lab-switch';
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

/** Switch com painel por imagem (S6730-H24X6C) para a outra ponta do cabo. */
function switchTemplate(): PhysicalEquipmentTemplate {
  return {
    ...chassisTemplate('huawei-s6730-h24x6c', 'S6730-H24X6C', 1),
    id: 'template-huawei-s6730-h24x6c',
    category: 'SWITCH',
    family: 'S6730',
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

function switchPorts() {
  const sfpPlus = Array.from({ length: 4 }, (_value, index) =>
    physicalPort({
      id: `lab-sw-${index + 1}`,
      assetId: SWITCH_ID,
      name: `10GE-${index + 1}`,
      label: `10GE-${index + 1}`,
      order: index + 1,
      side: 'DEVICE',
      type: 'SFP_PLUS',
      ...(index === 0 ? { state: 'CONNECTED' as const, connectionId: CABLE_ID } : {}),
    }),
  );
  const qsfp = [
    physicalPort({
      id: 'lab-sw-qsfp-1',
      assetId: SWITCH_ID,
      name: 'QSFP28-1',
      label: 'QSFP28-1',
      order: 5,
      side: 'DEVICE',
      type: 'QSFP',
    }),
  ];
  return [...sfpPlus, ...qsfp];
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
      physicalAsset({
        id: SWITCH_ID,
        name: 'SW-CORE LAB-01',
        kind: 'NETWORK',
        startU: 34,
        heightU: 1,
        description: 'Switch com painel por imagem (outra ponta do cabo)',
        templateId: 'template-huawei-s6730-h24x6c',
        template: switchTemplate(),
        ports: switchPorts(),
      }),
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
  portBId: 'lab-sw-1',
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
    portId: 'lab-sw-1',
    portName: '10GE-1',
    side: 'DEVICE',
    assetId: SWITCH_ID,
    assetName: 'SW-CORE LAB-01',
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
  const [mode, setMode] = useState<PhysicalConnectionMode>('all');
  const [showHitboxes, setShowHitboxes] = useState(false);
  const [zoom, setZoom] = useState(0.75);
  const [selection, setSelection] = useState<PhysicalSelection>(null);

  const rack = useMemo(() => buildLabRack(chassisKey), [chassisKey]);
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
        <div className="physical-preview__filters-row">
          {hasBoard ? (
            <button type="button" onClick={() => setSelection({ kind: 'port', id: 'lab-gpon-1' })}>
              Selecionar GPON-1 (placa)
            </button>
          ) : null}
          <button type="button" onClick={() => setSelection({ kind: 'port', id: 'lab-sw-1' })}>
            Selecionar 10GE-1 (switch)
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
        Bancada local (fixture, nada é gravado): <b>{option.name}</b> (altura {option.heightU}U, imagem
        com {modularChassisMap(chassisKey)?.slots.length ?? 0} baías mapeadas)
        {hasBoard
          ? ' · <b>GPFD 16 portas GPON</b> (H802GPFD) no primeiro slot de serviço · porta <b>GPON-1</b> ligada por <b>CIR-LAB-01</b> à <b>10GE-1</b> do S6730-H24X6C'
          : ' · sem placa (MA5683T segue sem estrutura de slots no catálogo)'}
        .
      </p>

      <div style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
        <PhysicalRackCanvas
          rack={rack}
          connections={[labConnection]}
          mode={mode}
          selection={selection}
          path={null}
          catalog={[]}
          onSelectAsset={() => setSelection(null)}
          onSelectPort={(id) => setSelection({ kind: 'port', id })}
          onSelectConnection={(id) => setSelection({ kind: 'connection', id })}
          onClear={() => setSelection(null)}
        />
      </div>
    </main>
  );
}
