/* @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicalRackCanvas } from './physical-rack-canvas';
import { buildPhysicalLldpGhosts, PhysicalLldpGhost } from './physical-lldp';
import type { PhysicalSelection } from './physical-types';
import {
  physicalAsset,
  physicalConnection,
  physicalInventory,
  physicalPort,
  physicalRack,
} from './physical-fixtures';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const rack = physicalRack({
  assets: [
    physicalAsset({
      id: 'asset-a',
      name: 'SW-01',
      startU: 10,
      heightU: 1,
      ports: [
        physicalPort({ id: 'port-a', assetId: 'asset-a', name: 'GE1', connectionId: 'connection-1', state: 'CONNECTED' }),
        physicalPort({ id: 'port-a2', assetId: 'asset-a', name: 'GE2', order: 2, state: 'LLDP_DETECTED' }),
      ],
    }),
    physicalAsset({
      id: 'asset-b',
      name: 'EDD-01',
      kind: 'GENERIC',
      startU: 2,
      heightU: 2,
      ports: [
        physicalPort({ id: 'port-b', assetId: 'asset-b', name: 'LAN1', type: 'RJ45', connectionId: 'connection-1', state: 'CONNECTED' }),
        physicalPort({ id: 'port-b2', assetId: 'asset-b', name: 'LAN2', type: 'RJ45', order: 2, state: 'LLDP_DETECTED' }),
      ],
    }),
  ],
});

const connection = physicalConnection({ id: 'connection-1', portAId: 'port-a', portBId: 'port-b' });

const ghost: PhysicalLldpGhost = {
  /**
   * O par do ghost é DIFERENTE do par do cabo (`port-a|port-b`): a precedência
   * cabo > LLDP nunca deixa as duas evidências disputarem o mesmo par.
   */
  key: 'port-a2|port-b2',
  adjacencyId: 'lldp-1',
  adjacencyIds: ['lldp-1'],
  state: 'READY',
  confidence: 'CONFIRMED',
  observedAt: '2026-09-21T11:00:00.000Z',
  reason: 'Ambos os lados estão no inventário físico.',
  localPortName: 'GE2',
  remoteHostname: 'EDD-01',
  remotePortName: 'LAN2',
  from: { siteId: 'site-1', siteName: 'POP Centro', rackId: 'rack-1', rackName: 'Rack 01', assetId: 'asset-a', assetName: 'SW-01', portId: 'port-a2', portName: 'GE2' },
  to: { siteId: 'site-1', siteName: 'POP Centro', rackId: 'rack-1', rackName: 'Rack 01', assetId: 'asset-b', assetName: 'EDD-01', portId: 'port-b2', portName: 'LAN2' },
  external: false,
  conflict: 'NONE',
  conflictDetail: '',
  confirmable: true,
};

describe('PhysicalRackCanvas · clique no ghost LLDP', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onSelectLldp: ReturnType<typeof vi.fn>;
  let onSelectConnection: ReturnType<typeof vi.fn>;

  function mount(selection: PhysicalSelection = null) {
    act(() => {
      root.render(
        <PhysicalRackCanvas
          rack={rack}
          connections={[connection]}
          lldpGhosts={[ghost]}
          lldpMode="all"
          mode="all"
          selection={selection}
          path={null}
          onSelectAsset={vi.fn()}
          onSelectPort={vi.fn()}
          onSelectConnection={onSelectConnection}
          onSelectLldp={onSelectLldp}
          onClear={vi.fn()}
        />,
      );
    });
  }

  function click(selector: string) {
    const element = container.querySelector(selector);
    if (!element) throw new Error(`elemento ausente: ${selector}`);
    act(() => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onSelectLldp = vi.fn();
    onSelectConnection = vi.fn();
    mount();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('seleciona a sugestão LLDP e nunca o cabo confirmado', () => {
    expect(container.querySelector('.physical-lldp-ghost')).not.toBeNull();
    expect(container.querySelector('.physical-cable')).not.toBeNull();

    click('.physical-lldp-hit');

    expect(onSelectLldp).toHaveBeenCalledWith('lldp-1');
    expect(onSelectConnection).not.toHaveBeenCalled();
  });

  it('o cabo confirmado continua selecionável de forma independente', () => {
    click('.physical-cable-hit');

    expect(onSelectConnection).toHaveBeenCalledWith('connection-1');
    expect(onSelectLldp).not.toHaveBeenCalled();
  });

  it('sugestão selecionada destaca as duas portas sem virar cabo', () => {
    mount({ kind: 'lldp', id: 'lldp-1' });

    expect(container.querySelector('.physical-lldp-ghost.is-selected')).not.toBeNull();
    // Continua havendo exatamente um cabo real (o par do fixture).
    expect(container.querySelectorAll('.physical-cable').length).toBe(1);
  });

  it('READY real (S6750 ↔ 6730) no mesmo rack aparece no modo "todas" com o nome CLI', () => {
    const withPorts = (assetId: string, portId: string, cage: string, interfaceName: string) =>
      physicalAsset({
        id: assetId,
        name: assetId,
        rackId: 'rack-1',
        ports: [
          physicalPort({
            id: portId,
            assetId,
            name: cage,
            label: cage,
            state: 'LLDP_DETECTED',
            mappedInterfaceId: `iface-${portId}`,
            mappedInterface: {
              id: `iface-${portId}`,
              deviceId: `device-${assetId}`,
              name: interfaceName,
              ifIndex: 5,
              alias: null,
              operStatus: 'UP',
            },
          }),
        ],
      });
    const inventory = physicalInventory({
      sites: [
        {
          id: 'site-1',
          name: 'BHE-VTA',
          code: 'VTA',
          description: '',
          racks: [
            physicalRack({
              id: 'rack-1',
              siteId: 'site-1',
              name: 'RACK-MPLS',
              assets: [
                withPorts('asset-a', 'port-a', 'QSFP28-5', '100GE1/0/5'),
                withPorts('asset-b', 'port-b', 'QSFP28-6', '100GE0/0/6'),
              ],
            }),
          ],
          createdAt: '2026-09-21T12:00:00.000Z',
          updatedAt: '2026-09-21T12:00:00.000Z',
        },
      ],
      lldpSuggestions: [
        {
          adjacencyId: 'lldp-real-1',
          confidence: 'CONFIRMED',
          state: 'READY',
          local: {
            assetId: 'asset-a',
            assetName: 'asset-a',
            portId: 'port-a',
            portName: 'QSFP28-5',
            rackName: 'RACK-MPLS',
            siteName: 'BHE-VTA',
          },
          remote: {
            assetId: 'asset-b',
            assetName: 'asset-b',
            portId: 'port-b',
            portName: 'QSFP28-6',
            rackName: 'RACK-MPLS',
            siteName: 'BHE-VTA',
          },
          localPortName: '100GE1/0/5',
          remoteHostname: 'asset-b',
          remotePortName: '100GE0/0/6',
          observedAt: '2026-09-21T11:00:00.000Z',
          reason: 'Ambos os lados estão no inventário físico.',
        },
      ],
      lldpObservedAt: '2026-09-21T11:00:00.000Z',
    });
    const ghosts = buildPhysicalLldpGhosts(inventory);
    expect(ghosts).toHaveLength(1);
    // A apresentação usa o nome CLI da interface, nunca o rótulo do cage.
    expect(ghosts[0]!.from?.portName).toBe('100GE1/0/5');
    expect(ghosts[0]!.to?.portName).toBe('100GE0/0/6');

    act(() => {
      root.render(
        <PhysicalRackCanvas
          rack={inventory.sites[0]!.racks[0]!}
          connections={[]}
          lldpGhosts={ghosts}
          lldpMode="all"
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

    expect(container.querySelectorAll('.physical-lldp-ghost')).toHaveLength(1);
    expect(container.textContent).toContain('100GE1/0/5');
  });
});
