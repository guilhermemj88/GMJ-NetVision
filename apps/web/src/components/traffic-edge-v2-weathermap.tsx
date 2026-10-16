'use client';

/**
 * MAP-VISUAL-V2 — Fase E: renderer do enlace bidirecional (WeatherMap moderno).
 *
 * Uma única trajetória por enlace (mesma Bézier da V1) dividida em DUAS METADES
 * pelo comprimento do arco:
 *
 *   ponta A ──▶━━━━━━━━━━●━━━━━━━━◀── ponta B
 *      metade A→B      centro      metade B→A
 *
 * Cada metade tem cor de utilização própria, seta apontando para o centro
 * (tangente local) e, quando a animação permite, um trem de segmentos luminosos
 * percorrendo o sentido do tráfego. A espessura é a MESMA nas duas metades:
 * ela representa a capacidade do enlace, não o tráfego momentâneo.
 *
 * O traço visível usa exatamente a mesma curva da área de clique (o
 * `traffic-edge__hitarea` continua com o caminho completo), então seleção,
 * hover, ContextDrawer, MAP-LINK-GRAPHS e offsets manuais seguem iguais.
 */

import { memo, useMemo, useState } from 'react';
import { EdgeLabelRenderer, useStore, type Edge, type EdgeProps } from '@xyflow/react';
import type { LinkVisualPath, NetworkLink } from '@gmj/shared';
import {
  linkV2ArrowScale,
  linkV2ScreenStrokeWidth,
  resolveLinkV2EdgeStroke,
  type LinkV2Visual,
} from '@/lib/map-visual-v2';
import {
  LINK_V2_EDGE_CURVATURE,
  buildBezierGeometry,
  perpendicularOf,
  type BezierGeometry,
} from '@/lib/map-visual-v2-geometry';
import {
  buildArcTable,
  halfAnchorPoint,
  halfArrowPlacement,
  splitGeometryAtLength,
  type ArcTable,
  type SplitGeometry,
} from '@/lib/map-visual-v2-arc';
import { LINK_V2_LABEL_LIFT, type LinkV2LabelPlacement } from '@/lib/map-visual-v2-labels';
import type { ManualLabelOffset } from '@/lib/map-visual-v2-offsets';
import { PATH_OFFSET_SCALE } from '@/lib/link-curvature';
import {
  WEATHER_ARROW_HALF_FRACTION,
  WEATHER_LABEL_HALF_FRACTION,
  resolveWeatherMap,
  weatherHalfDash,
  weatherHalfLabelMode,
  weatherHalfText,
  weatherStateLabelMode,
  weatherStreamStyle,
  type LinkV2AnimationMode,
  type WeatherHalf,
  type WeatherHalfKey,
} from '@/lib/map-visual-v2-weathermap';

const STATE_OPACITY: Record<LinkV2Visual['state'], number> = {
  normal: 0.95,
  attention: 0.95,
  critical: 1,
  down: 1,
  inconsistent: 1,
  'no-data': 0.75,
  stale: 0.7,
};

export interface LinkV2WeatherPlacements {
  a2b: LinkV2LabelPlacement | null;
  b2a: LinkV2LabelPlacement | null;
  state: LinkV2LabelPlacement | null;
}

export interface LinkV2WeatherEdgeData extends Record<string, unknown> {
  link: NetworkLink;
  /** Estado/cores/rótulo do enlace, já apurados com a telemetria real. */
  visual: LinkV2Visual;
  animation: LinkV2AnimationMode;
  /** Offset manual da V1 (mesmo contrato) — vence a anticolisão. */
  manualOffset: ManualLabelOffset | null;
  /** Metade que recebe o offset manual (a direção configurada na V1). */
  manualHalf: WeatherHalfKey;
  placements: LinkV2WeatherPlacements;
  visualPath?: LinkVisualPath;
  autoOffset?: number;
  showLabels: boolean;
  dimmed?: boolean;
  emphasized?: boolean;
}

export type LinkV2WeatherFlowEdge = Edge<LinkV2WeatherEdgeData, 'trafficWeather'>;

/** Nome da metade no vocabulário do arco (o `first` percorre A→B). */
function arcHalfOf(key: WeatherHalfKey): 'first' | 'second' {
  return key === 'a2b' ? 'first' : 'second';
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

interface HalfRender {
  key: WeatherHalfKey;
  half: WeatherHalf;
  geometry: BezierGeometry;
  length: number;
}

function LinkV2WeatherEdgeContent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<LinkV2WeatherFlowEdge> & { data: LinkV2WeatherEdgeData }) {
  const [hovered, setHovered] = useState(false);
  const zoom = useStore((state) => state.transform[2]);

  const { link, visual, animation, manualOffset, manualHalf, placements, visualPath, autoOffset = 0 } =
    data;

  const geometry = useMemo(
    () =>
      buildBezierGeometry({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
        curvature: LINK_V2_EDGE_CURVATURE,
        offset: autoOffset + (visualPath?.curvature ?? 0) * PATH_OFFSET_SCALE,
      }),
    [
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
      autoOffset,
      visualPath?.curvature,
    ],
  );

  const arc: ArcTable = useMemo(() => buildArcTable(geometry), [geometry]);
  const split: SplitGeometry = useMemo(
    () => splitGeometryAtLength(geometry, arc, 0.5),
    [geometry, arc],
  );

  const weather = useMemo(
    () => resolveWeatherMap(visual, { animation, selected: Boolean(selected), hovered }),
    [visual, animation, selected, hovered],
  );

  const edgeStroke = resolveLinkV2EdgeStroke({
    mode: 'zoom',
    capacityBps: link.capacityBps,
    dash: undefined,
    zoom,
  });
  const arrowScale = linkV2ArrowScale('zoom', linkV2ScreenStrokeWidth(link.capacityBps), zoom);

  const opacity = data.dimmed ? 0.22 : data.emphasized ? 1 : STATE_OPACITY[visual.state];

  const halves: HalfRender[] = [
    { key: 'a2b', half: weather.a2b, geometry: split.first, length: split.firstLength },
    { key: 'b2a', half: weather.b2a, geometry: split.second, length: split.secondLength },
  ];

  const normal = perpendicularOf(geometry);
  const fallbackShift = {
    dx: normal.x * LINK_V2_LABEL_LIFT / Math.max(0.25, zoom),
    dy: normal.y * LINK_V2_LABEL_LIFT / Math.max(0.25, zoom),
  };

  const labelsAllowed = data.showLabels || Boolean(selected) || hovered;
  const labelContext = {
    // `showLabels` é a preferência do mapa (ligar/desligar rótulos), não um
    // "mostrar todos os valores": a política por metade continua valendo.
    showAll: false,
    selected: Boolean(selected),
    hovered,
    adjacentToSelectedNode: Boolean(data.emphasized),
  };

  const labelFor = (key: WeatherHalfKey, half: WeatherHalf) => {
    if (data.dimmed || !labelsAllowed) return null;
    const manual = manualOffset && manualHalf === key ? manualOffset : null;
    const mode = manual ? 'full' : weatherHalfLabelMode(half, labelContext);
    const text = weatherHalfText(half, mode);
    if (!text) return null;
    const placement = manual ? { mode: 'full' as const, ...manual } : placements[key];
    const visualMode = placement && placement.mode !== 'hidden' ? placement.mode : mode;
    const finalText = visualMode === 'full' ? (half.label ?? text) : (half.compactLabel ?? text);
    const anchor = halfAnchorPoint(
      geometry,
      arc,
      split,
      arcHalfOf(key),
      WEATHER_LABEL_HALF_FRACTION,
    );
    const shift = placement ?? fallbackShift;
    return (
      <div
        className={`traffic-edge-v2__label traffic-edge-v2__label--half traffic-edge-v2__label--${visualMode} traffic-edge-v2__label--${half.state} traffic-edge-v2__label--${key} ${selected ? 'is-selected' : ''} ${manual ? 'is-manual' : ''} nodrag nopan`}
        data-testid="traffic-edge-v2-half-label"
        data-half={key}
        data-state={half.state}
        data-manual={manual ? 'true' : 'false'}
        title={
          manual
            ? 'Rótulo em posição manual (offset preservado da V1)'
            : `${half.reason} · sentido ${key === 'a2b' ? 'A→B' : 'B→A'}`
        }
        style={{ transform: `translate(-50%, -50%) translate(${anchor.x + shift.dx}px, ${anchor.y + shift.dy}px)` }}
      >
        {finalText}
      </div>
    );
  };

  const stateLabelMode = weatherStateLabelMode(weather, labelContext);
  const stateText =
    stateLabelMode === 'hidden' || !weather.stateLabel || data.dimmed ? null : weather.stateLabel;
  const statePlacement = placements.state;
  const midpoint = halfAnchorPoint(geometry, arc, split, 'first', 1);

  return (
    <>
      {selected && (
        <path
          d={geometry.path}
          className="traffic-edge-v2__halo"
          style={{
            stroke: weather.stateColor,
            strokeWidth: edgeStroke.strokeWidth + 5 / Math.max(0.25, zoom),
          }}
        />
      )}
      {halves.map(({ key, half, geometry: halfGeometry, length }) => {
        const dash = weatherHalfDash(half);
        const stream = half.animated ? weatherStreamStyle(length, zoom) : null;
        const arrow = half.arrow
          ? halfArrowPlacement(
              geometry,
              arc,
              split,
              arcHalfOf(key),
              WEATHER_ARROW_HALF_FRACTION,
            )
          : null;
        return (
          <g key={key} className={`traffic-edge-v2__half-group traffic-edge-v2__half-group--${key}`}>
            <path
              d={halfGeometry.path}
              className={`traffic-edge-v2__half traffic-edge-v2__half--${key} ${half.dashed ? 'is-dashed' : ''}`}
              data-testid="traffic-edge-v2-half"
              data-link={link.id}
              data-half={key}
              data-state={half.state}
              data-valid={half.valid ? 'true' : 'false'}
              vectorEffect={edgeStroke.nonScaling ? 'non-scaling-stroke' : undefined}
              style={{
                stroke: half.color,
                strokeWidth: edgeStroke.strokeWidth,
                strokeDasharray: dash,
                opacity,
              }}
            />
            {stream && (
              <path
                d={halfGeometry.path}
                className={`traffic-edge-v2__stream traffic-edge-v2__stream--${half.streamDirection}`}
                data-testid="traffic-edge-v2-stream"
                data-half={key}
                style={
                  {
                    // Segmentos um pouco mais claros que o traço: é o que faz o
                    // fluxo ser percebido sem brilho nem partícula grande.
                    stroke: `color-mix(in srgb, ${half.color} 58%, #eaf6fb)`,
                    strokeWidth: round2(
                      Math.min(edgeStroke.strokeWidth * 1.28, edgeStroke.strokeWidth + 1.4),
                    ),
                    strokeDasharray: stream.dashArray,
                    opacity: Math.min(1, opacity + 0.1),
                    '--wm-period': `${stream.period}px`,
                    '--wm-duration': `${stream.durationSeconds}s`,
                  } as React.CSSProperties
                }
              />
            )}
            {arrow && (
              <path
                d="M-5,-4.6 L7,0 L-5,4.6 Z"
                className={`traffic-edge-v2__arrow traffic-edge-v2__arrow--${key}`}
                data-testid="traffic-edge-v2-arrow"
                data-half={key}
                transform={`translate(${arrow.x},${arrow.y}) rotate(${arrow.angleDeg}) scale(${arrowScale})`}
                fill={half.color}
                opacity={opacity}
              />
            )}
          </g>
        );
      })}
      {/* Área de clique igual à da V1: o evento sobe para o React Flow. */}
      <path
        id={id}
        d={geometry.path}
        className="traffic-edge__hitarea"
        data-testid="traffic-edge-v2-hitarea"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      {(weather.a2b.label || weather.b2a.label || stateText) && (
        <EdgeLabelRenderer>
          {labelFor('a2b', weather.a2b)}
          {labelFor('b2a', weather.b2a)}
          {stateText && (
            <div
              className={`traffic-edge-v2__label traffic-edge-v2__label--state traffic-edge-v2__label--${weather.state} ${selected ? 'is-selected' : ''} nodrag nopan`}
              data-testid="traffic-edge-v2-state-label"
              data-state={weather.state}
              title={visual.reason}
              style={{
                transform: `translate(-50%, -50%) translate(${midpoint.x + (statePlacement?.dx ?? fallbackShift.dx)}px, ${midpoint.y + (statePlacement?.dy ?? fallbackShift.dy)}px)`,
              }}
            >
              {stateText}
            </div>
          )}
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const TrafficEdgeV2Weather = memo(function TrafficEdgeV2Weather(
  props: EdgeProps<LinkV2WeatherFlowEdge>,
) {
  return props.data ? <LinkV2WeatherEdgeContent {...props} data={props.data} /> : null;
});
