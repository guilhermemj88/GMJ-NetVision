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

function renderNode(
  device: Device,
  mapNode: MapNode,
  alarmCount = 0,
  dataOverrides: Partial<DeviceNodeData> = {},
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const data: DeviceNodeData = {
    device,
    mapNode,
    editMode: false,
    displayMode: 'ICON_2D',
    nodeScale: 100,
    labelScale: 100,
    alarmCount,
    ...dataOverrides,
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

describe('DeviceNode sem contagem de portas no canvas', () => {
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

  function mount(dataOverrides: Partial<DeviceNodeData>) {
    const device = makeDevice({
      interfaces: [
        { id: 'if-1' },
        { id: 'if-2' },
        { id: 'if-3' },
      ] as unknown as Device['interfaces'],
    });
    const rendered = renderNode(device, makeNode(), 0, dataOverrides);
    roots.push({ root: rendered.root, container: rendered.container });
    return rendered.container;
  }

  /**
   * A contagem de portas saiu do node (canvas operacional mais limpo). O dado
   * continua no inspetor; aqui garantimos que nenhum modo volte a exibi-la.
   */
  it('nao mostra a contagem de portas no node em nenhum modo', () => {
    for (const displayMode of ['ICON_2D', 'ICON_3D', 'CARD'] as const) {
      const container = mount({ displayMode });
      expect(container.textContent).not.toContain('portas');
      expect(container.querySelector('.device-node__port-count')).toBeNull();
      expect(container.querySelector('.device-node__ports')).toBeNull();
      act(() => roots.pop()!.root.unmount());
      container.remove();
    }
  });

  it('mantem nome, IP e site no card sem a contagem de portas', () => {
    const container = mount({ displayMode: 'CARD' });
    const copy = container.querySelector('.device-node__copy');
    expect(copy).not.toBeNull();
    expect(copy!.textContent).toContain('NE40-BRAS-01');
    expect(copy!.textContent).toContain('10.0.0.1');
    expect(copy!.textContent).toContain('Bras');
    expect(copy!.querySelectorAll('em')).toHaveLength(1);
  });
});

describe('DeviceNode alarm badge', () => {
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

  function mount(device: Device, mapNode: MapNode, alarmCount: number) {
    const rendered = renderNode(device, mapNode, alarmCount);
    roots.push({ root: rendered.root, container: rendered.container });
    return rendered.container;
  }

  it('hides the badge when there are no active alarms', () => {
    const container = mount(makeDevice(), makeNode(), 0);
    expect(container.querySelector('.device-node__alarm-badge')).toBeNull();
  });

  it('shows a small ⚠ N badge with the active alarm count', () => {
    const container = mount(makeDevice(), makeNode(), 3);
    const badge = container.querySelector('.device-node__alarm-badge');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('⚠ 3');
    expect(badge!.getAttribute('aria-label')).toBe('3 alarmes ativos');
  });
});

describe('DeviceNode — engine V2 (sem orb circular)', () => {
  const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    window.localStorage.clear();
  });

  afterEach(() => {
    for (const { root, container } of roots.splice(0)) {
      act(() => root.unmount());
      container.remove();
    }
    window.localStorage.clear();
  });

  function mountV2(
    device: Device,
    mapNode: MapNode,
    alarmCount = 0,
    dataOverrides: Partial<DeviceNodeData> = {},
  ) {
    const rendered = renderNode(device, mapNode, alarmCount, { glyphEngine: 'v2', ...dataOverrides });
    roots.push({ root: rendered.root, container: rendered.container });
    return rendered.container;
  }

  it('marca o no com device-node--v2 e desenha o glifo novo (sem icone antigo)', () => {
    const container = mountV2(makeDevice({ deviceType: 'switch' }), makeNode());
    const root = container.querySelector('.device-node')!;
    expect(root.className).toContain('device-node--v2');
    expect(container.querySelector('.device-node__glyph')).not.toBeNull();
    expect(container.querySelector('.device-node__svg')).toBeNull();
  });

  it('mantem a MESMA metrica de caixa do V1 (handles nao se movem)', () => {
    const v1 = renderNode(makeDevice({ deviceType: 'router' }), makeNode());
    const v1Classes = v1.container.querySelector('.device-node')!.className;
    const v2 = mountV2(makeDevice({ deviceType: 'router' }), makeNode());
    const v2Classes = v2.querySelector('.device-node')!.className;

    // Todas as classes de layout/tipo/status são as mesmas: o V2 só acrescenta a
    // sua marca, nunca muda a métrica que posiciona os handles.
    expect(v2Classes).toContain('device-node--v2');
    expect(v1Classes).not.toContain('device-node--v2');
    const withoutEngine = (value: string) => value.split(/\s+/).filter((token) => token !== 'device-node--v2').sort();
    expect(withoutEngine(v2Classes)).toEqual(withoutEngine(v1Classes));
    expect(v2Classes).toContain('device-node--icon_2d');
    expect(v2Classes).toContain('status-up');
    expect(v2.querySelectorAll('.react-flow__handle')).toHaveLength(4);
  });

  it('usa o glifo de dois chassis quando o tipo e CORE_SWITCH', () => {
    window.localStorage.setItem('gmj:device-icon:dev-1', 'CORE_SWITCH');
    const container = mountV2(makeDevice({ deviceType: 'switch' }), makeNode());
    const glyph = container.querySelector('.device-node__glyph');
    expect(glyph).not.toBeNull();
    expect(glyph!.getAttribute('data-glyph')).toBe('CORE_SWITCH');
  });

  it('cai no desenho V1 quando o tipo nao tem glifo V2', () => {
    window.localStorage.setItem('gmj:device-icon:dev-1', 'CARRIER');
    const container = mountV2(makeDevice({ deviceType: 'generic' }), makeNode());
    expect(container.querySelector('.device-node__glyph')).toBeNull();
    expect(container.querySelector('.device-node__svg')).not.toBeNull();
    expect(container.querySelector('.device-node')!.className).toContain('device-node--v2');
  });

  it('preserva status, alarme, nome e IP', () => {
    const rendered = renderNode(
      makeDevice({ status: 'WARNING', name: 'OLT-CENTRO-01', ip: '10.90.4.4' }),
      makeNode(),
      2,
      { glyphEngine: 'v2' },
    );
    roots.push({ root: rendered.root, container: rendered.container });
    const container = rendered.container;
    expect(container.querySelector('.status-pulse')).not.toBeNull();
    expect(container.querySelector('.device-node')!.className).toContain('status-warning');
    expect(container.querySelector('.device-node__alarm-badge')!.textContent).toContain('2');
    expect(container.querySelector('.device-node__copy strong')!.textContent).toBe('OLT-CENTRO-01');
    expect(container.querySelector('.device-node__copy span')!.textContent).toBe('10.90.4.4');
  });
});
