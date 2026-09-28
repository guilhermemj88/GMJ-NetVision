// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { Position, ReactFlowProvider } from '@xyflow/react';
import { aggregateLinkMetrics, cloneDemoMaps, type NetworkLink } from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getTrafficLabelOffsets,
  setTrafficLabelOffset,
  trafficLabelOffset,
  trafficLabelOffsetsKey,
} from '@/lib/traffic-label-offsets';
import { TrafficEdge, type TrafficEdgeData } from './traffic-edge';

const MAP_ID = 'map-labels';

function buildLink(): NetworkLink {
  const base = cloneDemoMaps()[0]!.links[0]!;
  const real = {
    ...cloneDemoMaps()[0]!.devices[0]!.interfaces[0]!,
    operStatus: 'UP' as const,
    telemetryAvailable: true,
    rxBps: 2_000,
    txBps: 3_000,
  };
  const config = {
    ...base,
    capacityBps: 100_000_000_000,
    aggregationMode: 'NONE' as const,
    metricSources: [],
    sourceDeviceId: real.deviceId,
    targetDeviceId: null,
    sourceNodeId: null,
    targetNodeId: 'carrier',
    sourceInterfaceId: real.id,
    targetInterfaceId: null,
  };
  return { ...config, ...aggregateLinkMetrics(config, () => real) };
}

function edgeData(overrides: Partial<TrafficEdgeData> = {}): TrafficEdgeData {
  return {
    link: buildLink(),
    showTraffic: true,
    showUtilization: true,
    showLabels: true,
    showTrafficAnimation: true,
    displayStyle: 'FLOW',
    metricDisplay: 'BOTH',
    trafficLabelMode: 'INLINE',
    related: true,
    emphasized: false,
    linkScale: 100,
    labelScale: 100,
    labelMapId: MAP_ID,
    ...overrides,
  };
}

/** Renderiza a aresta em DOM real (permite eventos de ponteiro). */
function mountEdge(overrides: Partial<TrafficEdgeData> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const data = edgeData(overrides);
  act(() => {
    root.render(
      <ReactFlowProvider>
        <svg>
          <TrafficEdge
            id={data.link.id}
            type="traffic"
            source="source"
            target="target"
            data={data}
            selected={false}
            sourceX={10}
            sourceY={20}
            targetX={310}
            targetY={160}
            sourcePosition={Position.Right}
            targetPosition={Position.Left}
          />
        </svg>
      </ReactFlowProvider>,
    );
  });
  return { container, root, data };
}

/** Posição renderizada de uma lane, em unidades de fluxo. */
function lanePosition(container: HTMLElement, lane: 'A_TO_B' | 'B_TO_A') {
  const node = container.querySelector(`text[data-flow-direction="${lane}"]`);
  if (!node) throw new Error(`label ${lane} nao encontrada`);
  return { x: Number(node.getAttribute('x')), y: Number(node.getAttribute('y')) };
}

function pointer(type: string, clientX: number, clientY: number) {
  return new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true });
}

describe('TrafficEdge · ajuste visual das labels', () => {
  const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

  beforeEach(() => {
    window.localStorage.clear();
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    for (const { root, container } of roots.splice(0)) {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('fora do modo Ajustar labels a label continua sem ponteiro', () => {
    const rendered = mountEdge({ labelAdjust: false });
    roots.push(rendered);
    const label = rendered.container.querySelector('text[data-flow-direction="A_TO_B"]')!;

    expect(label.getAttribute('class')).not.toContain('is-adjustable');
    expect(label.getAttribute('data-label-adjustable')).toBeNull();

    act(() => {
      label.dispatchEvent(pointer('pointerdown', 100, 100));
      label.dispatchEvent(pointer('pointermove', 160, 140));
      label.dispatchEvent(pointer('pointerup', 160, 140));
    });
    // Arrasto acidental não persiste nada.
    expect(window.localStorage.getItem(trafficLabelOffsetsKey(MAP_ID))).toBeNull();
  });

  it('no modo Ajustar labels arrasta a lane e persiste o offset só dela', () => {
    const rendered = mountEdge({ labelAdjust: true });
    roots.push(rendered);
    const label = rendered.container.querySelector('text[data-flow-direction="A_TO_B"]')!;
    expect(label.getAttribute('class')).toContain('is-adjustable');
    const before = lanePosition(rendered.container, 'A_TO_B');

    act(() => {
      label.dispatchEvent(pointer('pointerdown', 100, 100));
      label.dispatchEvent(pointer('pointermove', 130, 120));
    });
    const during = lanePosition(rendered.container, 'A_TO_B');
    expect(during.x).toBeCloseTo(before.x + 30, 1);
    expect(during.y).toBeCloseTo(before.y + 20, 1);

    act(() => {
      label.dispatchEvent(pointer('pointerup', 130, 120));
    });

    const offsets = getTrafficLabelOffsets(MAP_ID);
    expect(trafficLabelOffset(offsets, rendered.data.link.id, 'a')).toEqual({ dx: 30, dy: 20 });
    // A direção reversa fica intacta.
    expect(trafficLabelOffset(offsets, rendered.data.link.id, 'b')).toBeNull();
  });

  it('duplo clique devolve apenas aquela direção', () => {
    const link = buildLink();
    // Estado salvo como no uso real: as duas lanes deslocadas neste mapa.
    setTrafficLabelOffset(MAP_ID, link.id, 'a', { dx: 40, dy: 40 });
    setTrafficLabelOffset(MAP_ID, link.id, 'b', { dx: -20, dy: 10 });
    const rendered = mountEdge({
      labelAdjust: true,
      link,
      labelOffsets: getTrafficLabelOffsets(MAP_ID),
    });
    roots.push(rendered);
    const label = rendered.container.querySelector('text[data-flow-direction="A_TO_B"]')!;
    expect(label.getAttribute('data-label-offset')).toBe('40,40');

    act(() => {
      label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    });

    const offsets = getTrafficLabelOffsets(MAP_ID);
    expect(trafficLabelOffset(offsets, rendered.data.link.id, 'a')).toBeNull();
    expect(trafficLabelOffset(offsets, rendered.data.link.id, 'b')).toEqual({ dx: -20, dy: 10 });
  });

  it('aplica o offset salvo na posição do texto', () => {
    const link = buildLink();
    const without = renderToStaticMarkup(
      <ReactFlowProvider>
        <TrafficEdge
          id={link.id}
          type="traffic"
          source="s"
          target="t"
          data={edgeData({ link })}
          selected={false}
          sourceX={10}
          sourceY={20}
          targetX={310}
          targetY={160}
          sourcePosition={Position.Right}
          targetPosition={Position.Left}
        />
      </ReactFlowProvider>,
    );
    const withOffset = renderToStaticMarkup(
      <ReactFlowProvider>
        <TrafficEdge
          id={link.id}
          type="traffic"
          source="s"
          target="t"
          data={edgeData({ link, labelOffsets: { [link.id]: { a: { dx: 25, dy: -15 } } } })}
          selected={false}
          sourceX={10}
          sourceY={20}
          targetX={310}
          targetY={160}
          sourcePosition={Position.Right}
          targetPosition={Position.Left}
        />
      </ReactFlowProvider>,
    );
    const read = (html: string) => {
      const tag = html.match(/<text[^>]*data-flow-direction="A_TO_B"[^>]*>/)?.[0] ?? '';
      return {
        x: Number(tag.match(/x="([-0-9.]+)"/)?.[1]),
        y: Number(tag.match(/y="([-0-9.]+)"/)?.[1]),
        offset: tag.match(/data-label-offset="([^"]+)"/)?.[1] ?? null,
      };
    };
    const base = read(without);
    const moved = read(withOffset);

    expect(moved.x).toBeCloseTo(base.x + 25, 1);
    expect(moved.y).toBeCloseTo(base.y - 15, 1);
    expect(moved.offset).toBe('25,-15');
    expect(base.offset).toBeNull();
  });
});
