// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Position } from '@xyflow/react';
import { cloneDemoMaps, defaultVisualPaths, type NetworkLink } from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateLink } from '@/lib/api';
import { useMapStore } from '@/store/map-store';
import { TrafficEdge } from './traffic-edge';

const viewport = vi.hoisted(() => ({ zoom: 1, x: 0, y: 0 }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@xyflow/react')>()),
  EdgeLabelRenderer: ({ children }: { children: ReactNode }) =>
    createPortal(children, document.body),
  useViewport: () => viewport,
  useReactFlow: () => ({
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({
      x: (x - viewport.x) / viewport.zoom,
      y: (y - viewport.y) / viewport.zoom,
    }),
  }),
}));
vi.mock('@/lib/api', () => ({ updateLink: vi.fn() }));

function Harness({ reversed = false, card = false }: { reversed?: boolean; card?: boolean }) {
  const { map, selection, editMode, readOnly } = useMapStore();
  const link = map!.links[0]!;
  return (
    <svg>
      {link.visualPaths.map(
        (visualPath, pathIndex) =>
          visualPath.enabled && (
            <TrafficEdge
              key={pathIndex}
              id={`${link.id}:${pathIndex}`}
              type="traffic"
              source="A"
              target="B"
              sourceX={reversed ? 300 : 0}
              sourceY={0}
              targetX={reversed ? 0 : 300}
              targetY={0}
              sourcePosition={reversed ? Position.Left : Position.Right}
              targetPosition={reversed ? Position.Right : Position.Left}
              selected={selection?.kind === 'link' && selection.id === link.id}
              data={{
                link,
                visualPath,
                pathIndex,
                editMode,
                readOnly,
                autoOffset: link.linkLayoutMode === 'AUTO' ? 18 : 0,
                showTraffic: true,
                showUtilization: true,
                showLabels: true,
                showTrafficAnimation: true,
                displayStyle: 'FLOW',
                metricDisplay: 'BOTH',
                related: true,
                emphasized: false,
                linkScale: 100,
                labelScale: 100,
                isPrimaryPath: pathIndex === 0,
                trafficLabelMode: card ? 'CARD' : 'INLINE',
              }}
            />
          ),
      )}
    </svg>
  );
}

describe('visual link curvature editing', () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  let link: NetworkLink;
  const showToast = vi.fn();
  const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.link-curvature-handle')];
  const current = () => useMapStore.getState().map!.links[0]!;
  const pointer = async (
    button: HTMLButtonElement,
    type: string,
    x = 150,
    y = 13.5,
    pointerId = 1,
  ) => {
    await act(async () => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
      });
      Object.defineProperty(event, 'pointerId', { value: pointerId });
      button.dispatchEvent(event);
    });
  };
  const render = async (props = {}) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Harness {...props} />
        </QueryClientProvider>,
      ),
    );

  beforeEach(async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    Object.assign(viewport, { x: 0, y: 0, zoom: 1 });
    vi.clearAllMocks();
    Object.defineProperties(HTMLElement.prototype, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: () => true },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    const map = cloneDemoMaps()[0]!;
    link = { ...map.links[0]!, visualPaths: defaultVisualPaths(1), linkLayoutMode: 'AUTO' };
    map.links = [link];
    useMapStore.setState({
      map,
      activeMapId: map.id,
      selection: { kind: 'link', id: link.id },
      editMode: true,
      readOnly: false,
      linkGeometryDrafts: {},
      showToast,
    });
    vi.mocked(updateLink).mockImplementation(async (_mapId, _linkId, geometry) => ({
      ...current(),
      ...geometry,
    }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(['map', map.id], map);
    await render();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    useMapStore.setState({
      map: null,
      selection: null,
      linkGeometryDrafts: {},
      editMode: false,
      readOnly: false,
    });
  });

  it('shows a handle only for a selected link in editMode and never in readOnly/public view', async () => {
    expect(buttons()).toHaveLength(1);
    for (const state of [
      { editMode: false },
      { editMode: true, selection: null },
      { selection: { kind: 'link' as const, id: link.id }, readOnly: true },
    ]) {
      await act(async () => useMapStore.setState(state));
      expect(buttons()).toHaveLength(0);
    }
    await act(async () => useMapStore.getState().setPublicMap(useMapStore.getState().map!));
    expect(buttons()).toHaveLength(0);
  });

  it('previews AUTO to MANUAL locally and moves the handle, labels, lanes and hitbox before one PATCH', async () => {
    const button = buttons()[0]!;
    const originalPath = container.querySelector('.traffic-edge--base')!.getAttribute('d');
    const originalLabelY = container
      .querySelector('.traffic-edge__inline-label')!
      .getAttribute('y');
    await pointer(button, 'pointerdown');
    expect(button.setPointerCapture).toHaveBeenCalledWith(1);
    await pointer(button, 'pointermove', 150, 81);
    expect(current().linkLayoutMode).toBe('MANUAL');
    expect(current().visualPaths[0]!.curvature).toBeCloseTo(120);
    const path = container.querySelector('.traffic-edge--base')!.getAttribute('d');
    expect(path).not.toBe(originalPath);
    expect(container.querySelector('.traffic-edge__hitarea')!.getAttribute('d')).toBe(path);
    expect(container.querySelector('.traffic-edge--flow')!.getAttribute('d')).toBe(path);
    expect(container.querySelector('.traffic-edge__inline-label')!.getAttribute('y')).not.toBe(
      originalLabelY,
    );
    expect(button.style.transform).toContain('81px');
    expect(updateLink).not.toHaveBeenCalled();
    await pointer(button, 'pointermove', 150, 90);
    await pointer(button, 'pointerup', 150, 90);
    await pointer(button, 'pointerup', 150, 90);
    expect(updateLink).toHaveBeenCalledTimes(1);
    expect(updateLink).toHaveBeenCalledWith(
      link.mapId,
      link.id,
      expect.objectContaining({ linkLayoutMode: 'MANUAL', visualPaths: current().visualPaths }),
    );
    expect(useMapStore.getState().linkGeometryDrafts).toEqual({});
  });

  it('allows crossing to the opposite side and preserves reversed link orientation', async () => {
    await render({ reversed: true });
    const button = buttons()[0]!;
    await pointer(button, 'pointerdown', 150, -13.5);
    await pointer(button, 'pointermove', 150, 54);
    expect(current().visualPaths[0]!.curvature).toBeCloseTo(-80);
    expect(button.style.transform).toContain('54px');
    await pointer(button, 'pointerup', 150, 54);
    expect(updateLink).toHaveBeenCalledTimes(1);
  });

  it.each([0.25, 2.5])(
    'uses canvas coordinates with zoom %s and a translated viewport',
    async (zoom) => {
      Object.assign(viewport, { zoom, x: 100, y: -50 });
      await render();
      const button = buttons()[0]!;
      expect(button.style.transform).toContain(`scale(${1 / zoom})`);
      await pointer(button, 'pointerdown', 100 + 150 * zoom, -50 + 13.5 * zoom);
      await pointer(button, 'pointermove', 100 + 150 * zoom, -50 + 81 * zoom);
      expect(current().visualPaths[0]!.curvature).toBeCloseTo(120);
      await pointer(button, 'pointercancel');
    },
  );

  it('edits each enabled path independently while preserving disabled path indices and metadata', async () => {
    await act(async () =>
      useMapStore.getState().replaceLink({
        ...link,
        visualPaths: defaultVisualPaths(3).map((path, index) => ({
          ...path,
          curvature: index * 30,
          label: `Route ${index}`,
          enabled: index !== 1,
          customColor: '#abcdef',
        })),
      }),
    );
    expect(buttons()).toHaveLength(2);
    const button = buttons()[1]!;
    expect(button.getAttribute('aria-label')).toContain('caminho 3: Route 2');
    await pointer(button, 'pointerdown', 150, 54);
    await pointer(button, 'pointermove', 150, 121.5);
    expect(current().visualPaths.map((path) => path.curvature)).toEqual([20, 50, 180]);
    expect(current().visualPaths[1]).toMatchObject({
      enabled: false,
      label: 'Route 1',
      customColor: '#abcdef',
    });
    await pointer(button, 'pointerup', 150, 121.5);
    expect(updateLink).toHaveBeenCalledTimes(1);
  });

  it.each(['pointercancel', 'lostpointercapture'])(
    'rolls back on %s without persisting',
    async (event) => {
      const button = buttons()[0]!;
      await pointer(button, 'pointerdown');
      await pointer(button, 'pointermove', 150, 100);
      await pointer(button, event);
      expect(current().visualPaths).toEqual(link.visualPaths);
      expect(current().linkLayoutMode).toBe('AUTO');
      expect(updateLink).not.toHaveBeenCalled();
    },
  );

  it('does not save clicks, tangential movement, or unrelated pointer events', async () => {
    const button = buttons()[0]!;
    await pointer(button, 'pointerdown');
    await pointer(button, 'pointermove', 150, 100, 2);
    await pointer(button, 'pointermove', 200, 13.5);
    await pointer(button, 'pointerup', 200, 13.5);
    expect(updateLink).not.toHaveBeenCalled();
    expect(current().linkLayoutMode).toBe('AUTO');
  });

  it('protects the draft from map refreshes and cancels it when edit mode ends', async () => {
    const originalMap = structuredClone(useMapStore.getState().map!);
    const button = buttons()[0]!;
    await pointer(button, 'pointerdown');
    await pointer(button, 'pointermove', 150, 81);
    await act(async () => useMapStore.getState().setMap(originalMap));
    expect(current().visualPaths[0]!.curvature).toBeCloseTo(120);
    await act(async () => useMapStore.setState({ editMode: false }));
    expect(current().visualPaths).toEqual(link.visualPaths);
    expect(updateLink).not.toHaveBeenCalled();
  });

  it('restores the saved curve and reports failure when the PATCH fails', async () => {
    vi.mocked(updateLink).mockRejectedValueOnce(new Error('offline'));
    const button = buttons()[0]!;
    await pointer(button, 'pointerdown');
    await pointer(button, 'pointermove', 150, 81);
    await pointer(button, 'pointerup', 150, 81);
    expect(current().visualPaths).toEqual(link.visualPaths);
    expect(current().linkLayoutMode).toBe('AUTO');
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Não foi possível salvar'));
  });

  it('does not restore a private draft over a newly loaded public map', async () => {
    const publicMap = structuredClone(useMapStore.getState().map!);
    publicMap.links[0]!.visualPaths[0]!.curvature = 50;
    const button = buttons()[0]!;
    await pointer(button, 'pointerdown');
    await pointer(button, 'pointermove', 150, 81);
    await act(async () => useMapStore.getState().setPublicMap(publicMap));
    expect(buttons()).toHaveLength(0);
    expect(current().visualPaths[0]!.curvature).toBe(50);
    expect(useMapStore.getState().linkGeometryDrafts).toEqual({});
    expect(updateLink).not.toHaveBeenCalled();
  });

  it('blocks another drag while saving and completes persistence after deselection', async () => {
    let finish!: (link: NetworkLink) => void;
    vi.mocked(updateLink).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const button = buttons()[0]!;
    await pointer(button, 'pointerdown');
    await pointer(button, 'pointermove', 150, 81);
    await pointer(button, 'pointerup', 150, 81);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    await pointer(button, 'pointerdown', 150, 81);
    await pointer(button, 'pointermove', 150, 120);
    expect(current().visualPaths[0]!.curvature).toBeCloseTo(120);
    const saved = structuredClone(current());
    await act(async () => useMapStore.setState({ selection: null }));
    await act(async () => finish(saved));
    expect(current().visualPaths).toEqual(saved.visualPaths);
    expect(useMapStore.getState().linkGeometryDrafts).toEqual({});
    expect(updateLink).toHaveBeenCalledTimes(1);
  });

  it('moves CARD labels with the curve', async () => {
    await render({ card: true });
    const card = document.querySelector<HTMLElement>('.edge-metric')!;
    const initial = card.style.transform;
    const button = buttons()[0]!;
    await pointer(button, 'pointerdown');
    await pointer(button, 'pointermove', 150, 81);
    expect(card.style.transform).not.toBe(initial);
    expect(card.style.transform).toContain('81px');
  });
});
