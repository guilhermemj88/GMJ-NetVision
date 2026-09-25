/* @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicalRackCanvas } from './physical-rack-canvas';
import { PhysicalLldpGhost } from './physical-lldp';
import type { PhysicalSelection } from './physical-types';
import {
  physicalAsset,
  physicalConnection,
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
      ports: [physicalPort({ id: 'port-a', assetId: 'asset-a', name: 'GE1', connectionId: 'connection-1', state: 'CONNECTED' })],
    }),
    physicalAsset({
      id: 'asset-b',
      name: 'EDD-01',
      kind: 'GENERIC',
      startU: 2,
      heightU: 2,
      ports: [physicalPort({ id: 'port-b', assetId: 'asset-b', name: 'LAN1', type: 'RJ45', connectionId: 'connection-1', state: 'CONNECTED' })],
    }),
  ],
});

const connection = physicalConnection({ id: 'connection-1', portAId: 'port-a', portBId: 'port-b' });

const ghost: PhysicalLldpGhost = {
  key: 'port-a|port-b',
  adjacencyId: 'lldp-1',
  adjacencyIds: ['lldp-1'],
  state: 'READY',
  confidence: 'CONFIRMED',
  observedAt: '2026-09-21T11:00:00.000Z',
  reason: 'Ambos os lados estão no inventário físico.',
  localPortName: 'GE1',
  remoteHostname: 'EDD-01',
  remotePortName: 'LAN1',
  from: { siteId: 'site-1', siteName: 'POP Centro', rackId: 'rack-1', rackName: 'Rack 01', assetId: 'asset-a', assetName: 'SW-01', portId: 'port-a', portName: 'GE1' },
  to: { siteId: 'site-1', siteName: 'POP Centro', rackId: 'rack-1', rackName: 'Rack 01', assetId: 'asset-b', assetName: 'EDD-01', portId: 'port-b', portName: 'LAN1' },
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
});
