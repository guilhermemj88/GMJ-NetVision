import { renderToStaticMarkup } from 'react-dom/server';
import type { PhysicalPath } from '@gmj/shared';
import { describe, expect, it } from 'vitest';
import { PhysicalRackCanvas } from './physical-rack-canvas';
import {
  physicalAsset,
  physicalConnection,
  physicalModule,
  physicalPort,
  physicalRack,
  physicalSlot,
} from './physical-fixtures';

const rack = physicalRack({
  assets: [
    physicalAsset({
      id: 'asset-a',
      name: 'SW-01',
      startU: 10,
      heightU: 1,
      ports: [
        physicalPort({
          id: 'port-a',
          assetId: 'asset-a',
          name: 'GE1',
          connectionId: 'connection-1',
          state: 'CONNECTED',
        }),
      ],
    }),
    physicalAsset({
      id: 'asset-b',
      name: 'EDD-01',
      kind: 'GENERIC',
      startU: 2,
      heightU: 2,
      ports: [
        physicalPort({
          id: 'port-b',
          assetId: 'asset-b',
          name: 'LAN1',
          type: 'RJ45',
          connectionId: 'connection-1',
          state: 'CONNECTED',
        }),
      ],
    }),
  ],
});

const connection = physicalConnection({});

const noop = () => undefined;

describe('PhysicalRackCanvas', () => {
  it('renders rack units and equipment at proportional positions', () => {
    const html = renderToStaticMarkup(
      <PhysicalRackCanvas rack={rack} connections={[connection]} mode="hidden" selection={null} path={null}
        onSelectAsset={noop} onSelectPort={noop} onSelectConnection={noop} onClear={noop} />,
    );
    expect(html.match(/physical-u-row/g)).toHaveLength(12);
    expect(html).toContain('SW-01');
    expect(html).toContain('EDD-01');
    expect(html).toContain('state-connected');
    expect(html).toContain('top:60px');
    expect(html).toContain('height:58px');
    expect(html).not.toContain('physical-cable physical-cable--fiber');
  });

  it('renders only the selected physical path in selected mode', () => {
    const path: PhysicalPath = {
      originPortId: 'port-a', endpointPortId: 'port-b', loopDetected: false,
      steps: [
        { kind: 'PORT', portId: 'port-a', portName: 'GE1', side: 'DEVICE', assetId: 'asset-a', assetName: 'SW-01', rackName: 'Rack 01', siteName: 'POP Centro' },
        { kind: 'CABLE', connectionId: 'connection-1', medium: 'FIBER', label: 'CIR-01' },
        { kind: 'PORT', portId: 'port-b', portName: 'LAN1', side: 'DEVICE', assetId: 'asset-b', assetName: 'EDD-01', rackName: 'Rack 01', siteName: 'POP Centro' },
      ],
    };
    const html = renderToStaticMarkup(
      <PhysicalRackCanvas rack={rack} connections={[connection]} mode="selected"
        selection={{ kind: 'port', id: 'port-a' }} path={path}
        onSelectAsset={noop} onSelectPort={noop} onSelectConnection={noop} onClear={noop} />,
    );
    expect(html).toContain('physical-cable physical-cable--fiber is-selected');
    expect(html).toContain('aria-label="SW-01, porta GE1"');
    expect(html).toContain('aria-label="EDD-01, porta LAN1"');
  });

  it('renders chassis slots with installed boards and their ports', () => {
    const modular = physicalRack({
      assets: [
        physicalAsset({
          id: 'asset-olt',
          name: 'OLT-01',
          kind: 'OLT',
          startU: 5,
          heightU: 6,
          ports: [
            physicalPort({ id: 'port-plain', assetId: 'asset-olt', name: 'MGMT', state: 'MAPPED' }),
          ],
          slots: [
            physicalSlot({
              id: 'slot-1',
              assetId: 'asset-olt',
              index: 1,
              module: physicalModule({
                id: 'module-1',
                assetId: 'asset-olt',
                slotId: 'slot-1',
                name: 'Placa GPON 8 portas',
                model: 'H802GPBD',
                ports: [
                  physicalPort({
                    id: 'port-gpon-1',
                    assetId: 'asset-olt',
                    slotId: 'slot-1',
                    moduleId: 'module-1',
                    name: 'GPON0/1/0',
                    state: 'LLDP_DETECTED',
                    lldp: {
                      adjacencyId: 'l1', remoteHostname: 'SW-CORE', remotePortName: 'GE1/0/1',
                      confidence: 'CONFIRMED', resolved: true, ambiguous: false,
                      source: 'LLDP', observedAt: '2026-09-21T11:00:00.000Z',
                    },
                  }),
                ],
              }),
            }),
            physicalSlot({ id: 'slot-2', assetId: 'asset-olt', index: 2 }),
          ],
        }),
      ],
    });

    const html = renderToStaticMarkup(
      <PhysicalRackCanvas rack={modular} connections={[]} mode="hidden" selection={null} path={null}
        onSelectAsset={noop} onSelectPort={noop} onSelectConnection={noop} onClear={noop} />,
    );
    expect(html).toContain('physical-faceplate__slots');
    expect(html).toContain('H802GPBD');
    expect(html).toContain('aria-label="OLT-01 Placa GPON 8 portas, porta GPON0/1/0"');
    // module ports are drawn inside the slot, never in the flat port row
    expect(html).toContain('aria-label="OLT-01, porta MGMT"');
    expect(html).toContain('state-mapped');
    expect(html).toContain('state-lldp_detected');
    expect(html).toContain('physical-port__lldp');
  });
});
