import { renderToStaticMarkup } from 'react-dom/server';
import type { PhysicalConnection, PhysicalPath, PhysicalRack } from '@gmj/shared';
import { describe, expect, it } from 'vitest';
import { PhysicalRackCanvas } from './physical-rack-canvas';

const timestamp = '2026-09-21T12:00:00.000Z';
const rack: PhysicalRack = {
  id: 'rack-1',
  siteId: 'site-1',
  name: 'Rack 01',
  units: 12,
  description: '',
  createdAt: timestamp,
  updatedAt: timestamp,
  assets: [
    {
      id: 'asset-a', rackId: 'rack-1', deviceId: null, templateId: null,
      name: 'SW-01', kind: 'NETWORK', startU: 10, heightU: 1, description: '',
      device: null, template: null, createdAt: timestamp, updatedAt: timestamp,
      ports: [{ id: 'port-a', assetId: 'asset-a', name: 'GE1', label: '', order: 1,
        side: 'DEVICE', type: 'SFP', notes: '', pairedPortId: null, templatePortId: null,
        mappedInterfaceId: null, mappedInterface: null, connectionId: 'connection-1',
        createdAt: timestamp, updatedAt: timestamp }],
    },
    {
      id: 'asset-b', rackId: 'rack-1', deviceId: null, templateId: null,
      name: 'EDD-01', kind: 'GENERIC', startU: 2, heightU: 2, description: '',
      device: null, template: null, createdAt: timestamp, updatedAt: timestamp,
      ports: [{ id: 'port-b', assetId: 'asset-b', name: 'LAN1', label: '', order: 1,
        side: 'DEVICE', type: 'RJ45', notes: '', pairedPortId: null, templatePortId: null,
        mappedInterfaceId: null, mappedInterface: null, connectionId: 'connection-1',
        createdAt: timestamp, updatedAt: timestamp }],
    },
  ],
};

const connection: PhysicalConnection = {
  id: 'connection-1', portAId: 'port-a', portBId: 'port-b', medium: 'FIBER', label: 'CIR-01',
  notes: '', lengthMeters: null, createdAt: timestamp, updatedAt: timestamp,
  a: { portId: 'port-a', portName: 'GE1', side: 'DEVICE', assetId: 'asset-a', assetName: 'SW-01', rackId: 'rack-1', rackName: 'Rack 01', siteId: 'site-1', siteName: 'POP Centro' },
  b: { portId: 'port-b', portName: 'LAN1', side: 'DEVICE', assetId: 'asset-b', assetName: 'EDD-01', rackId: 'rack-1', rackName: 'Rack 01', siteId: 'site-1', siteName: 'POP Centro' },
};

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
});
