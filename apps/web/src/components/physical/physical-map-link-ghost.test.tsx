/* @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhysicalInventory, PhysicalLldpSuggestion } from '@gmj/shared';
import { PhysicalRackCanvas } from './physical-rack-canvas';
import { buildPhysicalLldpGhosts } from './physical-lldp';
import { buildPhysicalMapLinkGhosts, type PhysicalMapLinkSource } from './physical-map-link';
import {
  PHYSICAL_TIMESTAMP,
  physicalAsset,
  physicalConnection,
  physicalInventory,
  physicalPort,
  physicalRack,
} from './physical-fixtures';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * Integração do fallback do mapa no rack: enlace do mapa com as duas pontas
 * mapeadas vira desenho discreto com badge `MAPA`, e a precedência
 * cabo > LLDP > mapa garante um único desenho por par físico.
 */

function mappedPort(id: string, assetId: string, name: string, interfaceName: string, ifIndex: number) {
  return physicalPort({
    id,
    assetId,
    name,
    label: name,
    type: 'QSFP',
    mappedInterfaceId: `iface-${id}`,
    mappedInterface: {
      id: `iface-${id}`,
      deviceId: `device-${assetId}`,
      name: interfaceName,
      ifIndex,
      alias: null,
      operStatus: 'UP',
    },
  });
}

function inventory(connection = false): PhysicalInventory {
  return physicalInventory({
    sites: [
      {
        id: 'site-1',
        name: 'POP Vista Alegre',
        code: 'VTA',
        description: '',
        racks: [
          physicalRack({
            id: 'rack-1',
            siteId: 'site-1',
            name: 'RACK-MPLS',
            assets: [
              physicalAsset({
                id: 'asset-a',
                name: 'BHE-VTA-S6750-MPLS-01',
                deviceId: 'device-asset-a',
                startU: 10,
                heightU: 1,
                ports: [mappedPort('port-a', 'asset-a', 'QSFP28-5', '100GE1/0/5', 5)],
              }),
              physicalAsset({
                id: 'asset-b',
                name: 'BHE-VTA-6730-MPLS-01',
                deviceId: 'device-asset-b',
                startU: 8,
                heightU: 1,
                ports: [mappedPort('port-b', 'asset-b', 'QSFP28-6', '100GE0/0/6', 6)],
              }),
            ],
          }),
        ],
        createdAt: PHYSICAL_TIMESTAMP,
        updatedAt: PHYSICAL_TIMESTAMP,
      },
    ],
    connections: connection
      ? [physicalConnection({ id: 'connection-1', portAId: 'port-a', portBId: 'port-b' })]
      : [],
    lldpSuggestions: [],
    lldpObservedAt: PHYSICAL_TIMESTAMP,
  });
}

const mapLink: PhysicalMapLinkSource = {
  id: 'link-1',
  sourceDeviceId: 'device-asset-a',
  sourceInterfaceId: 'iface-port-a',
  targetDeviceId: 'device-asset-b',
  targetInterfaceId: 'iface-port-b',
  label: 'CIR-MPLS-01',
  status: 'UP',
  discoverySource: 'MANUAL',
};

const readySuggestion: PhysicalLldpSuggestion = {
  adjacencyId: 'lldp-1',
  confidence: 'CONFIRMED',
  state: 'READY',
  local: {
    assetId: 'asset-a',
    assetName: 'BHE-VTA-S6750-MPLS-01',
    portId: 'port-a',
    portName: 'QSFP28-5',
    rackName: 'RACK-MPLS',
    siteName: 'POP Vista Alegre',
  },
  remote: {
    assetId: 'asset-b',
    assetName: 'BHE-VTA-6730-MPLS-01',
    portId: 'port-b',
    portName: 'QSFP28-6',
    rackName: 'RACK-MPLS',
    siteName: 'POP Vista Alegre',
  },
  localPortName: 'QSFP28-5',
  remoteHostname: 'BHE-VTA-6730-MPLS-01',
  remotePortName: 'QSFP28-6',
  observedAt: '2026-09-21T11:00:00.000Z',
  reason: 'Ambos os lados estão no inventário físico.',
};

describe('PhysicalRackCanvas · fallback do mapa', () => {
  let container: HTMLDivElement;
  let root: Root;

  function mount(options: {
    inventory: PhysicalInventory;
    lldpMode?: 'hidden' | 'related' | 'all';
  }) {
    const rack = options.inventory.sites[0]!.racks[0]!;
    const mapLinkGhosts = buildPhysicalMapLinkGhosts(options.inventory, [mapLink]);
    const lldpGhosts = buildPhysicalLldpGhosts(options.inventory);
    act(() => {
      root.render(
        <PhysicalRackCanvas
          rack={rack}
          connections={options.inventory.connections}
          lldpGhosts={lldpGhosts}
          mapLinkGhosts={mapLinkGhosts}
          lldpMode={options.lldpMode ?? 'all'}
          mode="all"
          selection={null}
          path={null}
          onSelectAsset={vi.fn()}
          onSelectPort={vi.fn()}
          onSelectConnection={vi.fn()}
          onSelectLldp={vi.fn()}
          onClear={vi.fn()}
        />,
      );
    });
    return { lldpGhosts, mapLinkGhosts };
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('duas interfaces mapeadas ligadas por NetworkLink geram o visual MAPA', () => {
    const { mapLinkGhosts } = mount({ inventory: inventory() });

    expect(mapLinkGhosts).toHaveLength(1);
    expect(container.querySelector('.physical-maplink-layer')).not.toBeNull();
    expect(container.querySelectorAll('.physical-maplink-ghost')).toHaveLength(1);
    expect(container.textContent).toContain('MAPA');
    // o fallback não é LLDP nem cabo
    expect(container.querySelector('.physical-lldp-ghost')).toBeNull();
    expect(container.querySelectorAll('.physical-cable')).toHaveLength(0);
    // o tooltip deixa explícito que não é cabo físico
    expect(container.querySelector('.physical-maplink-layer')?.textContent).toContain(
      'não é cabo físico confirmado',
    );
  });

  it('cabo confirmado no mesmo par: nenhum LLDP e nenhum MAPA são desenhados', () => {
    mount({ inventory: inventory(true) });

    expect(container.querySelectorAll('.physical-cable')).toHaveLength(1);
    expect(container.querySelector('.physical-maplink-ghost')).toBeNull();
    expect(container.querySelector('.physical-lldp-ghost')).toBeNull();
  });

  it('LLDP e MAPA no mesmo par: somente o LLDP é desenhado', () => {
    const withSuggestion = { ...inventory(), lldpSuggestions: [readySuggestion] };
    const { lldpGhosts } = mount({ inventory: withSuggestion });

    expect(lldpGhosts).toHaveLength(1);
    expect(container.querySelectorAll('.physical-lldp-ghost')).toHaveLength(1);
    expect(container.querySelector('.physical-maplink-ghost')).toBeNull();
  });

  it('modo oculto desliga também o fallback do mapa', () => {
    mount({ inventory: inventory(), lldpMode: 'hidden' });

    expect(container.querySelector('.physical-maplink-ghost')).toBeNull();
    expect(container.querySelector('.physical-lldp-ghost')).toBeNull();
  });

  it('modo relacionado só mostra o fallback do par tocado pela seleção', () => {
    mount({ inventory: inventory(), lldpMode: 'related' });

    expect(container.querySelector('.physical-maplink-ghost')).toBeNull();
  });
});
