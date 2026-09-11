// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import {
  cloneDemoMaps,
  defaultVisualPaths,
  singleEndedMonitoredSide,
  type MapNode,
  type NetworkLink,
  type NetworkMap,
} from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMap, getMaps, updateLink, updateNetworkMap } from '@/lib/api';
import { useMapStore } from '@/store/map-store';
import { NetworkCanvas } from './network-canvas';

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getMap: vi.fn(),
  getMaps: vi.fn(),
  updateLink: vi.fn(),
  updateNetworkMap: vi.fn(),
}));

const NODE_WIDTH = 140;
const NODE_HEIGHT = 72;

const HANDLE_OFFSETS: Record<string, { x: number; y: number }> = {
  left: { x: 0, y: NODE_HEIGHT / 2 },
  right: { x: NODE_WIDTH, y: NODE_HEIGHT / 2 },
  top: { x: NODE_WIDTH / 2, y: 0 },
  bottom: { x: NODE_WIDTH / 2, y: NODE_HEIGHT },
};

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function pointerEvent(type: string, x: number, y: number, pointerId: number): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  return event;
}

/**
 * React Flow decides whether an edge can be rendered from the geometry it
 * measured in the DOM, so the harness must mirror a real browser: every node is
 * a NODE_WIDTH x NODE_HEIGHT box whose side handles sit on the box edges.
 */
function installLayoutShims() {
  class ResizeObserverStub {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      this.callback(
        [
          {
            target,
            contentRect: rect(0, 0, NODE_WIDTH, NODE_HEIGHT),
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          } as unknown as ResizeObserverEntry,
        ],
        this as unknown as ResizeObserver,
      );
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);

  // React Flow reads the viewport transform through DOMMatrixReadOnly, which
  // jsdom does not implement. An identity transform keeps flow === screen
  // coordinates, which is what the drag expectations below assume.
  class DOMMatrixReadOnlyStub {
    readonly m22 = 1;
    constructor(_transform?: string) {}
  }
  vi.stubGlobal('DOMMatrixReadOnly', DOMMatrixReadOnlyStub);

  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('react-flow__node') ? NODE_WIDTH : 0;
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains('react-flow__node') ? NODE_HEIGHT : 0;
    },
  });

  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect(
    this: Element,
  ): DOMRect {
    if (this.classList.contains('react-flow__handle')) {
      const side = this.getAttribute('data-handlepos') ?? 'left';
      const offset = HANDLE_OFFSETS[side] ?? HANDLE_OFFSETS.left!;
      return rect(offset.x, offset.y, 1, 1);
    }
    if (this.classList.contains('react-flow__node')) return rect(0, 0, NODE_WIDTH, NODE_HEIGHT);
    return rect(0, 0, 0, 0);
  };

  const captured = new WeakMap<Element, Set<number>>();
  const define = (name: string, value: unknown) =>
    Object.defineProperty(window.Element.prototype, name, { configurable: true, value });
  define('setPointerCapture', function setPointerCapture(this: Element, pointerId: number) {
    const ids = captured.get(this) ?? new Set<number>();
    ids.add(pointerId);
    captured.set(this, ids);
  });
  define('releasePointerCapture', function releasePointerCapture(this: Element, pointerId: number) {
    captured.get(this)?.delete(pointerId);
    this.dispatchEvent(pointerEvent('lostpointercapture', 0, 0, pointerId));
  });
  define('hasPointerCapture', function hasPointerCapture(this: Element, pointerId: number) {
    return captured.get(this)?.has(pointerId) ?? false;
  });
}

function installMatchMedia() {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    media: '',
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

function genericNode(
  id: string,
  label: string,
  position: { x: number; y: number },
  mapId: string,
): MapNode {
  return {
    id,
    mapId,
    deviceId: null,
    nodeKind: 'GENERIC',
    genericType: 'CARRIER',
    label,
    position,
    locked: false,
    positionSource: 'MANUAL',
    pppDisplayMode: 'AUTO',
    pppPosition: 'BOTTOM',
    pppColor: null,
    pppFontSize: 14,
  };
}

function linkFixture(base: NetworkLink, overrides: Partial<NetworkLink>): NetworkLink {
  return {
    ...base,
    visualPaths: defaultVisualPaths(1),
    linkLayoutMode: 'AUTO',
    metricSources: [],
    aggregationMode: 'NONE',
    ...overrides,
  };
}

const firstMap = () => cloneDemoMaps()[0]!;

/** DEVICE <-> DEVICE with telemetry on both ends. */
function deviceToDeviceMap(): { map: NetworkMap; link: NetworkLink } {
  const demo = firstMap();
  const link = linkFixture(demo.links[0]!, { trafficMode: 'BIDIRECTIONAL' });
  return { map: { ...demo, links: [link] }, link };
}

/** DEVICE <-> GENERIC with a single monitored side. */
function deviceToGenericMap(side: 'SOURCE' | 'TARGET'): {
  map: NetworkMap;
  link: NetworkLink;
} {
  const demo = firstMap();
  const device = demo.devices[0]!;
  const networkInterface = device.interfaces[0]!;
  const conceptualNode = genericNode('carrier-node', 'CARRIER', { x: 520, y: 260 }, demo.id);
  const link = linkFixture(demo.links[0]!, {
    trafficMode: 'SINGLE_ENDED',
    sourceDeviceId: side === 'SOURCE' ? device.id : null,
    sourceInterfaceId: side === 'SOURCE' ? networkInterface.id : null,
    sourceNodeId: side === 'TARGET' ? conceptualNode.id : null,
    targetDeviceId: side === 'TARGET' ? device.id : null,
    targetInterfaceId: side === 'TARGET' ? networkInterface.id : null,
    targetNodeId: side === 'SOURCE' ? conceptualNode.id : null,
  });
  return { map: { ...demo, links: [link], nodes: [...demo.nodes, conceptualNode] }, link };
}

interface Harness {
  container: HTMLDivElement;
  link: NetworkLink;
  edgeElement(): SVGGElement;
  pathData(): string;
  curvatureHandle(): HTMLButtonElement;
  selectLink(): Promise<void>;
  drag(options: {
    from: { x: number; y: number };
    to: Array<{ x: number; y: number }>;
    release?: 'pointerup' | 'pointercancel';
  }): Promise<void>;
  currentLink(): NetworkLink;
}

const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

async function mount(fixture: { map: NetworkMap; link: NetworkLink }): Promise<Harness> {
  const { map, link } = fixture;
  vi.mocked(getMaps).mockResolvedValue([
    {
      id: map.id,
      name: map.name,
      description: map.description,
      mode: map.mode,
      isDefault: true,
      nodeCount: map.nodes.length,
      linkCount: map.links.length,
      createdAt: map.createdAt,
      updatedAt: map.updatedAt,
    },
  ]);
  vi.mocked(getMap).mockImplementation(async () => structuredClone(map));
  vi.mocked(updateNetworkMap).mockResolvedValue(map);
  vi.mocked(updateLink).mockImplementation(async (_mapId, _linkId, input) => ({
    ...useMapStore.getState().map!.links[0]!,
    ...input,
  }));

  useMapStore.setState({
    map: null,
    activeMapId: map.id,
    selection: null,
    editMode: true,
    readOnly: false,
    linkGeometryDrafts: {},
    panel: null,
    toast: null,
  });

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  client.setQueryData(['map', map.id], map);
  roots.push({ root, container });

  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ReactFlowProvider>
          <NetworkCanvas />
        </ReactFlowProvider>
      </QueryClientProvider>,
    );
  });
  // let the catalog + map queries resolve and React Flow measure the nodes
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const findEdge = () => container.querySelector<SVGGElement>(`g[data-testid="rf__edge-${link.id}"]`);
  const findHandle = () => container.querySelector<HTMLButtonElement>('.link-curvature-handle');
  const findPath = () =>
    container.querySelector('.traffic-edge--base')?.getAttribute('d') ?? '';

  return {
    container,
    link,
    edgeElement() {
      const edge = findEdge();
      if (!edge) throw new Error(`edge ${link.id} is not rendered`);
      return edge;
    },
    pathData: findPath,
    curvatureHandle() {
      const handle = findHandle();
      if (!handle) throw new Error('curvature handle is not rendered');
      return handle;
    },
    async selectLink() {
      await act(async () => {
        findEdge()!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      });
    },
    async drag({ from, to, release = 'pointerup' }) {
      const handle = findHandle();
      if (!handle) throw new Error('curvature handle is not rendered');
      await act(async () => {
        handle.dispatchEvent(pointerEvent('pointerdown', from.x, from.y, 1));
      });
      for (const point of to) {
        await act(async () => {
          handle.dispatchEvent(pointerEvent('pointermove', point.x, point.y, 1));
        });
      }
      const last = to.at(-1) ?? from;
      await act(async () => {
        handle.dispatchEvent(pointerEvent(release, last.x, last.y, 1));
      });
    },
    currentLink() {
      return useMapStore.getState().map!.links[0]!;
    },
  };
}

describe('NetworkCanvas link rendering and editing', () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    installLayoutShims();
    installMatchMedia();
  });

  afterEach(async () => {
    for (const { root, container } of roots.splice(0)) {
      await act(async () => root.unmount());
      container.remove();
    }
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    useMapStore.setState({
      map: null,
      selection: null,
      editMode: false,
      readOnly: false,
      linkGeometryDrafts: {},
      toast: null,
    });
  });

  it.each([
    ['BIDIRECTIONAL DEVICE <-> DEVICE', deviceToDeviceMap()],
    ['SINGLE_ENDED DEVICE <-> GENERIC monitored on the SOURCE', deviceToGenericMap('SOURCE')],
    ['SINGLE_ENDED DEVICE <-> GENERIC monitored on the TARGET', deviceToGenericMap('TARGET')],
  ])('materializes the %s link with its persisted endpoints', async (_name, fixture) => {
    const harness = await mount(fixture);

    expect(harness.edgeElement().getAttribute('data-id')).toBe(fixture.link.id);
    expect(harness.container.querySelectorAll('.traffic-edge--base')).toHaveLength(1);
    expect(harness.currentLink()).toMatchObject({
      sourceDeviceId: fixture.link.sourceDeviceId,
      targetDeviceId: fixture.link.targetDeviceId,
      sourceInterfaceId: fixture.link.sourceInterfaceId,
      targetInterfaceId: fixture.link.targetInterfaceId,
      sourceNodeId: fixture.link.sourceNodeId,
      targetNodeId: fixture.link.targetNodeId,
      trafficMode: fixture.link.trafficMode,
      status: fixture.link.status,
    });
    if (fixture.link.trafficMode === 'SINGLE_ENDED') {
      expect(singleEndedMonitoredSide(harness.currentLink())).not.toBeNull();
    }
  });

  it('keeps the very same edge mounted while a geometry draft is applied and persisted', async () => {
    const harness = await mount(deviceToDeviceMap());
    await harness.selectLink();

    const edgeBefore = harness.edgeElement();
    const pathBefore = harness.pathData();
    const handle = harness.curvatureHandle();

    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', 0, 0, 1));
    });
    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointermove', 0, 40, 1));
    });

    // the draft is applied locally, previews the new curve and never drops the edge
    expect(useMapStore.getState().linkGeometryDrafts[harness.link.id]).toBeDefined();
    expect(harness.currentLink().linkLayoutMode).toBe('MANUAL');
    expect(harness.edgeElement()).toBe(edgeBefore);
    expect(harness.pathData()).not.toBe(pathBefore);

    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerup', 0, 80, 1));
    });

    // commit persists once, releases the draft and still renders the same edge
    expect(harness.edgeElement()).toBe(edgeBefore);
    expect(useMapStore.getState().linkGeometryDrafts).toEqual({});
    expect(updateLink).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateLink).mock.calls[0]![2]).toMatchObject({ linkLayoutMode: 'MANUAL' });
  });

  it('changes the curvature on drag and saves every endpoint and telemetry field', async () => {
    const fixture = deviceToDeviceMap();
    const harness = await mount(fixture);
    await harness.selectLink();

    const edgeBefore = harness.edgeElement();
    const pathBefore = harness.pathData();
    await harness.drag({
      from: { x: 0, y: 0 },
      to: [
        { x: 0, y: 40 },
        { x: 0, y: 80 },
      ],
    });

    const saved = harness.currentLink();
    expect(harness.pathData()).not.toBe(pathBefore);
    expect(harness.edgeElement()).toBe(edgeBefore);
    expect(Math.abs(saved.visualPaths[0]!.curvature)).toBeGreaterThan(1);
    expect(saved.linkLayoutMode).toBe('MANUAL');
    expect(saved).toMatchObject({
      id: fixture.link.id,
      sourceDeviceId: fixture.link.sourceDeviceId,
      targetDeviceId: fixture.link.targetDeviceId,
      sourceInterfaceId: fixture.link.sourceInterfaceId,
      targetInterfaceId: fixture.link.targetInterfaceId,
      trafficMode: fixture.link.trafficMode,
      metricSources: fixture.link.metricSources,
      aggregationMode: fixture.link.aggregationMode,
      label: fixture.link.label,
      capacityBps: fixture.link.capacityBps,
      status: fixture.link.status,
    });
    expect(updateLink).toHaveBeenCalledTimes(1);
  });

  it('rolls the geometry back on a cancelled drag without unmounting the link', async () => {
    const fixture = deviceToDeviceMap();
    const harness = await mount(fixture);
    await harness.selectLink();
    const edgeBefore = harness.edgeElement();
    const original = structuredClone(fixture.link);
    const handle = harness.curvatureHandle();

    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', 0, 0, 1));
    });
    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointermove', 0, 80, 1));
    });
    expect(harness.currentLink().linkLayoutMode).toBe('MANUAL');

    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointercancel', 0, 80, 1));
    });

    expect(harness.currentLink().visualPaths).toEqual(original.visualPaths);
    expect(harness.currentLink().linkLayoutMode).toBe('AUTO');
    expect(useMapStore.getState().linkGeometryDrafts).toEqual({});
    expect(updateLink).not.toHaveBeenCalled();
    expect(harness.edgeElement()).toBe(edgeBefore);
  });

  it('keeps rendering the same link after a property edit', async () => {
    const harness = await mount(deviceToDeviceMap());
    await harness.selectLink();
    const edgeBefore = harness.edgeElement();

    await act(async () => {
      useMapStore.getState().replaceLink({
        ...harness.currentLink(),
        label: 'Enlace renomeado',
        visualPaths: defaultVisualPaths(2).map((path, index) => ({
          ...path,
          curvature: index * 10,
        })),
      });
    });

    expect(harness.edgeElement()).toBe(edgeBefore);
    expect(harness.container.querySelectorAll('.traffic-edge--base')).toHaveLength(2);
    expect(harness.currentLink()).toMatchObject({
      label: 'Enlace renomeado',
      sourceDeviceId: harness.link.sourceDeviceId,
      targetDeviceId: harness.link.targetDeviceId,
    });
  });

  it('keeps rendering the link after the periodic map refetch replaces every object', async () => {
    const harness = await mount(deviceToDeviceMap());
    await harness.selectLink();
    const edgeBefore = harness.edgeElement();

    // a refetch hands us brand new node/device/link objects
    const refetched = structuredClone(useMapStore.getState().map!);
    await act(async () => {
      useMapStore.getState().setMap(refetched);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // the measured node geometry is carried over, so the edge never unmounts
    expect(harness.edgeElement()).toBe(edgeBefore);
    expect(harness.container.querySelectorAll('.react-flow__edge')).toHaveLength(1);
    expect(harness.container.querySelector('.traffic-edge--base')).not.toBeNull();
    expect(harness.currentLink()).toMatchObject({
      sourceDeviceId: harness.link.sourceDeviceId,
      targetDeviceId: harness.link.targetDeviceId,
    });
  });

  it('keeps the DEVICE <-> GENERIC endpoints after the geometry PATCH', async () => {
    const fixture = deviceToGenericMap('SOURCE');
    const harness = await mount(fixture);
    await harness.selectLink();

    await harness.drag({
      from: { x: 0, y: 0 },
      to: [{ x: 0, y: 60 }],
    });

    const saved = harness.currentLink();
    expect(saved.linkLayoutMode).toBe('MANUAL');
    expect(saved).toMatchObject({
      sourceDeviceId: fixture.link.sourceDeviceId,
      sourceInterfaceId: fixture.link.sourceInterfaceId,
      targetNodeId: fixture.link.targetNodeId,
      targetDeviceId: fixture.link.targetDeviceId,
      trafficMode: 'SINGLE_ENDED',
    });
    expect(singleEndedMonitoredSide(saved)).toBe('SOURCE');
    expect(harness.container.querySelector('.traffic-edge--base')).not.toBeNull();
  });
});
