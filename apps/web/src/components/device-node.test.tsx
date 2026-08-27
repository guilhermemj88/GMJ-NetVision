// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Device, MapNode } from '@gmj/shared';
import { DeviceNode, type DeviceFlowNode, type DeviceNodeData } from './device-node';
import type { NodeProps } from '@xyflow/react';

function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    id: 'dev-1',
    name: 'NE40-BRAS-01',
    hostname: 'NE40-BRAS-01',
    ip: '10.0.0.1',
    vendor: 'Huawei',
    model: 'NE40E-X8A',
    status: 'UP',
    deviceType: 'router',
    site: 'Bras',
    source: 'MANUAL',
    discoveryMethod: 'SNMP',
    uptimeSeconds: 0,
    pppSupported: true,
    pppOnline: 12_438,
    pppUpdatedAt: new Date().toISOString(),
    pppSource: 'SNMP_HUAWEI',
    updatedAt: '',
    interfaces: [],
    ...overrides,
  };
}

function makeNode(overrides: Partial<MapNode> = {}): MapNode {
  return {
    id: 'node-1',
    mapId: 'map-1',
    deviceId: 'dev-1',
    nodeKind: 'DEVICE',
    genericType: null,
    label: null,
    position: { x: 0, y: 0 },
    locked: false,
    positionSource: 'AUTO',
    pppDisplayMode: 'AUTO',
    pppPosition: 'BOTTOM',
    pppColor: null,
    pppFontSize: 14,
    ...overrides,
  };
}

function renderNode(device: Device, mapNode: MapNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const data: DeviceNodeData = {
    device,
    mapNode,
    editMode: false,
    showInterfaces: false,
    displayMode: 'ICON_2D',
    nodeScale: 100,
    labelScale: 100,
  };
  const props = {
    id: device.id,
    type: 'device',
    data,
    selected: false,
  } as unknown as NodeProps<DeviceFlowNode>;
  act(() => {
    root.render(
      <ReactFlowProvider>
        <DeviceNode {...props} />
      </ReactFlowProvider>,
    );
  });
  return { container, root };
}

describe('DeviceNode PPP label', () => {
  const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
  });

  afterEach(() => {
    for (const { root, container } of roots.splice(0)) {
      act(() => root.unmount());
      container.remove();
    }
  });

  function mount(device: Device, mapNode: MapNode) {
    const rendered = renderNode(device, mapNode);
    roots.push({ root: rendered.root, container: rendered.container });
    return rendered.container;
  }

  it('renders the pt-BR PPP label on the default BOTTOM position', () => {
    const container = mount(
      makeDevice({ pppOnline: 12_438 }),
      makeNode({ pppDisplayMode: 'SHOW' }),
    );
    const label = container.querySelector('.device-node__ppp');
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe('PPP 12.438');
    expect(label!.className).toContain('device-node__ppp--bottom');
  });

  it('applies a custom color and font size', () => {
    const container = mount(
      makeDevice({ pppOnline: 5 }),
      makeNode({ pppDisplayMode: 'SHOW', pppColor: '#ff0000', pppFontSize: 22 }),
    );
    const label = container.querySelector<HTMLElement>('.device-node__ppp');
    expect(label!.style.color).toBe('rgb(255, 0, 0)');
    expect(label!.style.fontSize).toBe('22px');
  });

  it('supports TOP, LEFT, RIGHT and CENTER positions', () => {
    for (const position of ['TOP', 'LEFT', 'RIGHT', 'CENTER'] as const) {
      const container = mount(
        makeDevice({ pppOnline: 5 }),
        makeNode({ pppDisplayMode: 'SHOW', pppPosition: position }),
      );
      expect(container.querySelector(`.device-node__ppp--${position.toLowerCase()}`)).not.toBeNull();
      act(() => roots.pop()!.root.unmount());
      container.remove();
    }
  });

  it('AUTO hides 0, 1 and 2 and shows 3+', () => {
    for (const online of [0, 1, 2]) {
      const container = mount(makeDevice({ pppOnline: online }), makeNode());
      expect(container.querySelector('.device-node__ppp')).toBeNull();
      act(() => roots.pop()!.root.unmount());
      container.remove();
    }
    const visible = mount(makeDevice({ pppOnline: 3 }), makeNode());
    expect(visible.querySelector('.device-node__ppp')).not.toBeNull();
  });

  it('HIDE never renders the PPP label', () => {
    const container = mount(
      makeDevice({ pppOnline: 9_000 }),
      makeNode({ pppDisplayMode: 'HIDE' }),
    );
    expect(container.querySelector('.device-node__ppp')).toBeNull();
  });

  it('adds the PPP line to the tooltip only when supported', () => {
    const supported = mount(makeDevice(), makeNode({ pppDisplayMode: 'HIDE' }));
    expect(supported.querySelector('.device-tooltip')!.textContent).toContain(
      'PPP online: 12.438',
    );
    const unsupported = mount(makeDevice({ pppSupported: false }), makeNode());
    expect(unsupported.querySelector('.device-tooltip')!.textContent).not.toContain('PPP online');
  });
});
