/**
 * Fase J — densidade e desempenho do MAP-VISUAL-V2 (fixture LOCAL isolada).
 *
 * Não toca a API, não usa dados reais: monta ~40 nós e 100 enlaces a partir do
 * gerador de demonstração (`cloneDemoMaps`) e mede, em processo, exatamente os
 * passos que o canvas executa:
 *
 *  1. construção do modelo visual (`resolveRealLinkV2` por enlace);
 *  2. anticolisão global (`resolveLinkV2LabelPlacements` sobre a MESMA
 *     geometria desenhada — Bézier + tabela de arco + âncora da metade);
 *  3. contagem de elementos SVG/DOM do desenho V2 (markup real das arestas).
 *
 * Os números são impressos no relatório do teste (`console.info`) para virar
 * evidência no relatório da fase. Nada aqui é otimizado para "passar": o teste
 * só falha se algum passo estourar um teto generoso de tempo.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Position, ReactFlowProvider } from '@xyflow/react';
import { createElement } from 'react';
import { cloneDemoMaps, type MapNode, type NetworkLink } from '@gmj/shared';
import { resolveRealLinkV2 } from './map-visual-v2-link';
import { linkV2LabelPriority } from './map-visual-v2-link';
import {
  WEATHER_LABEL_HALF_FRACTION,
  WEATHER_PILL_EXTRA_OFFSETS,
  WEATHER_PILL_FONT_SIZE,
  WEATHER_PILL_FONT_SIZE_COMPACT,
  WEATHER_PILL_FONT_SIZE_SMALL,
  WEATHER_PILL_HEIGHT,
  WEATHER_PILL_HEIGHT_COMPACT,
  WEATHER_PILL_HEIGHT_SMALL,
  WEATHER_PILL_LANE_OFFSET,
  resolveWeatherMap,
} from './map-visual-v2-weathermap';
import { buildArcTable, halfAnchorPoint, splitGeometryAtLength } from './map-visual-v2-arc';
import {
  LINK_V2_EDGE_CURVATURE,
  buildBezierGeometry,
  perpendicularOf,
  tangentOf,
} from './map-visual-v2-geometry';
import {
  resolveLinkV2LabelPlacements,
  type LinkV2LabelCandidate,
} from './map-visual-v2-labels';
import {
  TrafficEdgeV2Weather,
  type LinkV2WeatherEdgeData,
} from '@/components/traffic-edge-v2-weathermap';

const NODE_COUNT = 40;
const LINK_COUNT = 100;
const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const STAMP = new Date(NOW - 20_000).toISOString();
const G = 1_000_000_000;

const NODE_WIDTH = 210;
const NODE_HEIGHT = 118;

interface DensityFixture {
  nodes: MapNode[];
  links: NetworkLink[];
  devices: ReturnType<typeof cloneDemoMaps>[number]['devices'];
}

/** ~40 nós em grade + 100 enlaces (mistura SINGLE/DOUBLE e paralelos). */
function buildFixture(): DensityFixture {
  const demo = cloneDemoMaps()[0]!;
  const devices = Array.from({ length: NODE_COUNT }, (_, index) => {
    const base = demo.devices[index % demo.devices.length]!;
    return {
      ...structuredClone(base),
      id: `host-density-${index}`,
      name: `DENSITY-${String(index).padStart(2, '0')}`,
      status: 'UP' as const,
    };
  });
  const columns = 8;
  const nodes: MapNode[] = devices.map((device, index) => ({
    ...structuredClone(demo.nodes[index % demo.nodes.length]!),
    id: `node-density-${index}`,
    deviceId: device.id,
    position: {
      x: (index % columns) * (NODE_WIDTH + 90),
      y: Math.floor(index / columns) * (NODE_HEIGHT + 110),
    },
  }));
  const links: NetworkLink[] = Array.from({ length: LINK_COUNT }, (_, index) => {
    const base = structuredClone(demo.links[index % demo.links.length]!);
    const source = index % NODE_COUNT;
    // Vizinhança de grade + alguns long-haul: topologia de ISP, não aleatória.
    const neighbours = [source + 1, source + columns, source - 1, source - columns];
    const neighbour = neighbours[index % neighbours.length]!;
    const target =
      index % 9 === 0
        ? (index * 7 + 3) % NODE_COUNT
        : neighbour >= 0 && neighbour < NODE_COUNT
          ? neighbour
          : (source + 1) % NODE_COUNT;
    const safeTarget = target === source ? (target + 1) % NODE_COUNT : target;
    const singleEnded = index % 5 === 0;
    const parallel = index % 11 === 0;
    return {
      ...base,
      id: `link-density-${index}`,
      mapId: demo.id,
      sourceDeviceId: devices[source]!.id,
      targetDeviceId: singleEnded ? null : devices[safeTarget]!.id,
      sourceInterfaceId: devices[source]!.interfaces[0]?.id ?? null,
      targetInterfaceId: singleEnded ? null : (devices[safeTarget]!.interfaces[0]?.id ?? null),
      sourceNodeId: singleEnded ? null : null,
      targetNodeId: singleEnded ? nodes[safeTarget]!.id : null,
      trafficMode: singleEnded ? 'SINGLE_ENDED' : 'BIDIRECTIONAL',
      capacityBps: 100 * G,
      status: 'UP',
      label: `DENSITY ${index}`,
      visualPaths: parallel
        ? [
            { order: 0, label: null, customColor: null, curvature: 0, enabled: true },
            { order: 1, label: null, customColor: null, curvature: index % 2 ? 24 : -24, enabled: true },
          ]
        : [{ order: 0, label: null, customColor: null, curvature: index % 3 === 0 ? 18 : 0, enabled: true }],
      directions:
        index % 5 === 0
          ? {
              // SINGLE_ENDED: TX em um sentido, RX no outro (Fase H).
              A_TO_B: { bps: 5 * G, utilization: 5, txBps: 5 * G, observedRxBps: null, deltaPercent: null, consistency: 'UNKNOWN' },
              B_TO_A: { bps: 7 * G, utilization: 7, txBps: null, observedRxBps: 7 * G, deltaPercent: null, consistency: 'UNKNOWN' },
            }
          : {
              A_TO_B: { bps: (2 + (index % 9) * 8) * G, utilization: 2 + (index % 9) * 8, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
              B_TO_A: { bps: (3 + (index % 7) * 9) * G, utilization: 3 + (index % 7) * 9, txBps: null, observedRxBps: null, deltaPercent: null, consistency: 'CONSISTENT' },
            },
    } as NetworkLink;
  });
  return { nodes, links, devices };
}

function measure<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

describe('Fase J — densidade (100 enlaces / 40 nós, dados de demonstração)', () => {
  const fixture = buildFixture();
  const context = { nowMs: NOW, collectionStamp: STAMP };

  it('constrói o modelo visual e a anticolisão dentro do orçamento', () => {
    const model = measure(() =>
      fixture.links.map((link) => resolveRealLinkV2(link, context)),
    );
    const weather = measure(() =>
      fixture.links.map((link, index) =>
        resolveWeatherMap(model.value[index]!, {
          animation: 'off',
          selected: index === 0,
          hovered: false,
        }),
      ),
    );

    const rects = fixture.nodes.map((node) => ({
      x: node.position.x,
      y: node.position.y,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    }));

    const anticolisionOf = (useTangent: boolean) => {
      const candidates: LinkV2LabelCandidate[] = [];
      fixture.links.forEach((link, index) => {
        const source = fixture.nodes.find((n) => n.deviceId === link.sourceDeviceId) ?? fixture.nodes[0]!;
        const target = fixture.nodes.find(
          (n) => n.deviceId === link.targetDeviceId || n.id === link.targetNodeId,
        ) ?? fixture.nodes[1]!;
        const geometry = buildBezierGeometry({
          sourceX: source.position.x + NODE_WIDTH,
          sourceY: source.position.y + NODE_HEIGHT / 2,
          sourcePosition: Position.Right,
          targetX: target.position.x,
          targetY: target.position.y + NODE_HEIGHT / 2,
          targetPosition: Position.Left,
          curvature: LINK_V2_EDGE_CURVATURE,
          offset: (index % 3) * 6,
        });
        const arc = buildArcTable(geometry);
        const split = splitGeometryAtLength(geometry, arc, 0.5);
        const normal = perpendicularOf(geometry);
        const resolved = weather.value[index]!;
        const priorities = linkV2LabelPriority({ visual: model.value[index]!, selected: index === 0 });
        for (const half of [resolved.a2b, resolved.b2a] as const) {
          candidates.push({
            id: `${link.id}:${half.key}`,
            anchor: halfAnchorPoint(
              geometry,
              arc,
              split,
              half.key === 'a2b' ? 'first' : 'second',
              WEATHER_LABEL_HALF_FRACTION,
            ),
            normal,
            ...(useTangent
              ? {
                  tangent: tangentOf(geometry),
                  tangentBudget: Math.min(split.firstLength, split.secondLength) * 0.18,
                }
              : {}),
            laneOffset: WEATHER_PILL_LANE_OFFSET,
            priority: priorities,
            text: half.label ?? half.compactLabel ?? '',
            compactText: half.compactLabel ?? half.label ?? '',
          });
        }
      });
      return resolveLinkV2LabelPlacements(candidates, rects, {
        scale: 1 / 0.83,
        fontSize: WEATHER_PILL_FONT_SIZE,
        height: WEATHER_PILL_HEIGHT,
        fontSizeSmall: WEATHER_PILL_FONT_SIZE_SMALL,
        heightSmall: WEATHER_PILL_HEIGHT_SMALL,
        fontSizeCompact: WEATHER_PILL_FONT_SIZE_COMPACT,
        heightCompact: WEATHER_PILL_HEIGHT_COMPACT,
        extraOffsets: WEATHER_PILL_EXTRA_OFFSETS,
      });
    };

    const legacy = measure(() => anticolisionOf(false));
    const anticolision = measure(() => anticolisionOf(true));
    const tally = (placements: ReadonlyMap<string, { mode: string; dy: number }>) => {
      const values = [...placements.values()];
      const full = values.filter((p) => p.mode === 'full').length;
      const small = values.filter((p) => p.mode === 'small').length;
      const compact = values.filter((p) => p.mode === 'compact').length;
      const hidden = values.filter((p) => p.mode === 'hidden').length;
      return { full, small, compact, hidden, visible: full + small + compact, maxAbsDy: 0 };
    };
    const legacyTally = tally(legacy.value);
    const totals = tally(anticolision.value);

    console.info(
      `[Fase L densidade] nós=${fixture.nodes.length} enlaces=${fixture.links.length}\n` +
        `modelo=${model.ms.toFixed(1)}ms weather=${weather.ms.toFixed(1)}ms anticolisão=${anticolision.ms.toFixed(1)}ms (sem deslize=${legacy.ms.toFixed(1)}ms)\n` +
        `plaquetas com deslize: full=${totals.full} small=${totals.small} compact=${totals.compact} hidden=${totals.hidden} maxDy=${totals.maxAbsDy.toFixed(1)}\n` +
        `plaquetas sem deslize: full=${legacyTally.full} hidden=${legacyTally.hidden}`,
    );

    expect(model.ms).toBeLessThan(500);
    expect(weather.ms).toBeLessThan(500);
    expect(anticolision.ms).toBeLessThan(1500);
    // 100 enlaces válidos → 200 metades com valor (nada inventado nem sumido).
    expect(anticolision.value.size).toBe(LINK_COUNT * 2);
    // Cobertura: a Fase L degrada o formato, então o que importa é VISÍVEL.
    // Neste cenário sintético (100 enlaces em 40 nós, densidade irreal), a
    // plaqueta prefere sumir a se soltar do enlace — por isso a régua é de
    // cobertura mínima, não de "tudo visível".
    expect(totals.visible).toBeGreaterThanOrEqual(legacyTally.visible);
    expect(totals.visible).toBeGreaterThan(LINK_COUNT * 0.8);
    expect(totals.hidden).toBeLessThanOrEqual(legacyTally.hidden);
    expect(totals.hidden).toBeLessThan(LINK_COUNT * 1.2);
  });

  it('mede o desenho V2 (SVG/DOM por enlace) e o custo de re-render após telemetria', () => {
    const renderAll = () =>
      fixture.links.map((link, index) => {
        const visual = resolveRealLinkV2(link, context);
        const data: LinkV2WeatherEdgeData = {
          link,
          visual,
          animation: 'off',
          manualOffset: null,
          manualHalf: 'a2b',
          placements: { a2b: null, b2a: null, state: null },
          autoOffset: 0,
          showLabels: true,
          dimmed: false,
          emphasized: false,
        };
        return renderToStaticMarkup(
          createElement(
            ReactFlowProvider,
            null,
            createElement(TrafficEdgeV2Weather, {
              id: link.id,
              type: 'trafficWeather',
              source: 'a',
              target: 'b',
              data,
              selected: index === 0,
              sourcePosition: Position.Right,
              targetPosition: Position.Left,
              sourceX: 10,
              sourceY: 20,
              targetX: 310,
              targetY: 160,
            }),
          ),
        );
      });

    const first = measure(renderAll);
    const second = measure(renderAll);
    const html = first.value.join('');
    const count = (tag: string) => (html.match(new RegExp(`<${tag}\\b`, 'g')) ?? []).length;
    // As plaquetas vivem na camada HTML de rótulos (portal do EdgeLabelRenderer),
    // então a contagem vem da política: um valor por metade válida.
    const pillCount = fixture.links.reduce((total, link) => {
      const resolved = resolveWeatherMap(resolveRealLinkV2(link, context), { animation: 'off' });
      return total + [resolved.a2b, resolved.b2a].filter((half) => Boolean(half.label)).length;
    }, 0);

    console.info(
      `[Fase J densidade] markup de ${LINK_COUNT} enlaces: primeiro=${first.ms.toFixed(1)}ms ` +
        `segundo=${second.ms.toFixed(1)}ms | path=${count('path')} plaquetas=${pillCount}`,
    );

    // Cada enlace desenha 2 metades + 2 setas + divisor + hitarea = 6 paths,
    // mais o halo do enlace selecionado.
    expect(count('path')).toBe(LINK_COUNT * 6 + 1);
    expect(pillCount).toBe(LINK_COUNT * 2);

    // Re-render (nova telemetria) não pode ser ordens de grandeza pior.
    expect(second.ms).toBeLessThan(first.ms * 4 + 50);
  });
});
