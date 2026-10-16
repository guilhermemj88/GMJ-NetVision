'use client';

/**
 * MAP-VISUAL-V2 — Fase G: renderer do enlace bidirecional (WeatherMap moderno).
 *
 * Uma única trajetória por enlace (mesma Bézier da V1) dividida em DUAS METADES
 * pelo comprimento do arco:
 *
 *   ponta A ──▶━━━━━━━━━━│━━━━━━━━◀── ponta B
 *      metade A→B    divisor    metade B→A
 *
 * A COR do traço e das setas depende do ESTILO escolhido no preview (Fase M):
 *  - DIRECIONAL (padrão): cor FIXA POR DIREÇÃO (A→B ciano, B→A violeta), sem
 *    reagir à utilização; só estados anômalos trocam para o token de estado;
 *  - OPERACIONAL: a utilização de CADA METADE manda na linha, na seta e na borda
 *    da plaqueta (mesma cor), mantendo os estados anômalos nas suas cores.
 * Em ambos os modos o desenho é estático: nenhuma animação é executada.
 *
 * A PLAQUETA com velocidade e percentual fica EMBUTIDA sobre o traçado (fundo
 * opaco interrompe a linha, sem atravessar os caracteres) e é o ÚNICO elemento
 * que muda de cor conforme a utilização: direção abaixo de 50%, âmbar de 50% a
 * 79% e coral a partir de 80%. Os valores são permanentes, sem depender de hover.
 *
 * A espessura é a MESMA nas duas metades: representa a capacidade do enlace.
 *
 * O traço visível usa exatamente a mesma curva da área de clique (o
 * `traffic-edge__hitarea` continua com o caminho completo), então seleção, hover,
 * ContextDrawer, MAP-LINK-GRAPHS e offsets manuais seguem iguais.
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
  type BezierGeometry,
} from '@/lib/map-visual-v2-geometry';
import {
  buildArcTable,
  halfAnchorPoint,
  halfArrowPlacement,
  pointAtPathLength,
  splitGeometryAtLength,
  splitGeometryRange,
  type ArcTable,
  type SplitGeometry,
} from '@/lib/map-visual-v2-arc';
import type { LinkV2LabelPlacement } from '@/lib/map-visual-v2-labels';
import type { ManualLabelOffset } from '@/lib/map-visual-v2-offsets';
import { PATH_OFFSET_SCALE } from '@/lib/link-curvature';
import {
  WEATHER_ARROW_HALF_FRACTION,
  WEATHER_CENTER_BAR_HALF_HEIGHT,
  WEATHER_LABEL_HALF_FRACTION,
  WEATHER_RUNNER_MAX,
  resolveWeatherMap,
  weatherArrowShape,
  weatherCenterGap,
  weatherHalfDash,
  weatherHalfLabelMode,
  weatherHalfStyle,
  weatherHalfText,
  weatherRunnerCount,
  weatherRunnerDuration,
  weatherStateLabelMode,
  weatherStateStyleColor,
  type LinkV2AnimationMode,
  type WeatherArrowShape,
  type WeatherHalf,
  type WeatherHalfKey,
} from '@/lib/map-visual-v2-weathermap';
import { useLinkV2StyleMode } from '@/lib/map-visual-v2-style';

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

interface HalfRender {
  key: WeatherHalfKey;
  half: WeatherHalf;
  geometry: BezierGeometry;
  length: number;
  /** Seta fixa junto ao centro (convergente). */
  arrowShape: WeatherArrowShape;
  /** Chevron aberto para B→A; triângulo cheio para A→B. */
  stroke: string;
  arrowFill: string;
}

/**
 * Setas móveis ("runners") de uma metade: pequenos glyphs posicionados por
 * `offset-path` e movidos por CSS puro (sem requestAnimationFrame por enlace).
 * O sentido B→A usa a mesma animação invertida, então as duas metades sempre
 * caminham para o centro.
 */
function HalfRunners({
  path,
  halfKey,
  shape,
  count,
  durationSeconds,
  color,
  zoom,
}: {
  path: string;
  halfKey: WeatherHalfKey;
  shape: WeatherArrowShape;
  count: number;
  durationSeconds: number;
  color: string;
  zoom: number;
}) {
  if (count <= 0) return null;
  const reverse = halfKey === 'b2a';
  return (
    <>
      {Array.from({ length: Math.min(WEATHER_RUNNER_MAX, count) }, (_, index) => (
        <span
          key={index}
          className={`traffic-edge-v2__runner traffic-edge-v2__runner--${halfKey}`}
          data-testid="traffic-edge-v2-runner"
          data-half={halfKey}
          data-shape={shape}
          aria-hidden="true"
          style={
            {
              offsetPath: `path("${path}")`,
              offsetRotate: reverse ? 'auto 180deg' : 'auto',
              animationName: reverse ? 'wm-runner-reverse' : 'wm-runner-forward',
              animationDuration: `${durationSeconds}s`,
              animationDelay: `${-(index * durationSeconds) / Math.max(1, count)}s`,
              // A camada de rótulos é escalada pelo zoom: o tamanho em unidades
              // de fluxo é dividido pelo zoom para ficar constante na tela.
              '--wm-runner-size': `${Math.round((9 / Math.max(0.25, zoom)) * 100) / 100}px`,
              '--wm-runner-color': color,
            } as React.CSSProperties
          }
        >
          {shape === 'solid' ? (
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2,1.4 L8.4,5 L2,8.6 Z" />
            </svg>
          ) : (
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path
                d="M2.4,1.6 L8.2,5 L2.4,8.4"
                fill="none"
                strokeWidth="2.1"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </span>
      ))}
    </>
  );
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
  /**
   * Fase M: estilo dos enlaces vindo da preferência da ABA (preview). A troca
   * re-renderiza apenas as cores — posições, geometria, anticolisão, seleção,
   * zoom e pan não passam por aqui.
   */
  const styleMode = useLinkV2StyleMode();

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

  /**
   * Vão central + metades já recortadas: o encontro dos sentidos fica explícito
   * (cada metade para antes do centro e o losango marca o ponto de divisão).
   */
  const center = useMemo(() => {
    const gap = weatherCenterGap(zoom, Math.min(split.firstLength, split.secondLength));
    const a = splitGeometryRange(geometry, arc, 0, 0.5 - gap.fraction);
    const b = splitGeometryRange(geometry, arc, 0.5 + gap.fraction, 1);
    return {
      gapUnits: gap.units,
      a,
      b,
      point: pointAtPathLength(geometry, arc, arc.total / 2),
      aLength: split.firstLength - gap.units / 2,
      bLength: split.secondLength - gap.units / 2,
    };
  }, [geometry, arc, split.firstLength, split.secondLength, zoom]);

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

  /**
   * Fase M: cores da metade conforme o estilo ativo. Em DIRECIONAL é
   * exatamente o que a Fase L usava (`half.color`/`half.pillColor`); em
   * OPERACIONAL a linha, a seta e a borda da plaqueta da MESMA metade
   * compartilham a cor da SUA utilização.
   */
  const styleA2b = weatherHalfStyle(weather.a2b, styleMode);
  const styleB2a = weatherHalfStyle(weather.b2a, styleMode);

  const halves: HalfRender[] = [
    {
      key: 'a2b',
      half: weather.a2b,
      geometry: center.a,
      length: center.aLength,
      arrowShape: weatherArrowShape('a2b'),
      stroke: styleA2b.stroke,
      arrowFill: styleA2b.stroke,
    },
    {
      key: 'b2a',
      half: weather.b2a,
      geometry: center.b,
      length: center.bLength,
      arrowShape: weatherArrowShape('b2a'),
      stroke: styleB2a.stroke,
      arrowFill: styleB2a.stroke,
    },
  ];

  // Fase G: sem colocação da anticolisão, a plaqueta fica SOBRE a linha.
  const fallbackShift = { dx: 0, dy: 0 };

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
    const mode = manual ? 'full' : weatherHalfLabelMode(half, labelContext, zoom);
    const text = weatherHalfText(half, mode);
    if (!text) return null;
    const placement = manual ? { mode: 'full' as const, ...manual } : placements[key];
    const visualMode = placement && placement.mode !== 'hidden' ? placement.mode : mode;
    /**
     * Fase L: `full` e `small` mostram o valor COMPLETO (unidade + %); só o
     * formato compacto perde o percentual — a unidade do tráfego permanece.
     */
    const finalText =
      visualMode === 'full' || visualMode === 'small'
        ? (half.label ?? text)
        : (half.compactLabel ?? text);
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
        className={`traffic-edge-v2__label traffic-edge-v2__label--pill traffic-edge-v2__label--half traffic-edge-v2__label--${visualMode} traffic-edge-v2__label--${half.state} traffic-edge-v2__label--${key} ${selected ? 'is-selected' : ''} ${manual ? 'is-manual' : ''} nodrag nopan`}
        data-testid="traffic-edge-v2-half-label"
        data-half={key}
        data-state={half.state}
        data-band={half.band ?? 'state'}
        data-link-style={styleMode}
        data-manual={manual ? 'true' : 'false'}
        title={
          manual
            ? 'Rótulo em posição manual (offset preservado da V1)'
            : `${half.reason} · sentido ${key === 'a2b' ? 'A→B' : 'B→A'}`
        }
        style={
          {
            // Utilização manda APENAS nesta cor: no modo direcional a borda é a
            // cor da direção abaixo de 50% (âmbar/coral nas outras faixas); no
            // modo operacional é a cor da utilização DESTA metade.
            '--wm-pill': weatherHalfStyle(half, styleMode).pillBorder,
            transform: `translate(-50%, -50%) translate(${anchor.x + shift.dx}px, ${anchor.y + shift.dy}px)`,
          } as React.CSSProperties
        }
      >
        {finalText}
      </div>
    );
  };

  const stateLabelMode = weatherStateLabelMode(weather);
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
            stroke: 'var(--wm-halo)',
            strokeWidth: edgeStroke.strokeWidth + 5 / Math.max(0.25, zoom),
          }}
        />
      )}
      {halves.map(({ key, half, geometry: halfGeometry, arrowShape, stroke, arrowFill }) => {
        const dash = weatherHalfDash(half);
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
              data-band={half.band ?? 'state'}
              data-link-style={styleMode}
              data-direction={key}
              vectorEffect={edgeStroke.nonScaling ? 'non-scaling-stroke' : undefined}
              style={{
                stroke,
                strokeWidth: edgeStroke.strokeWidth,
                strokeDasharray: dash,
                opacity,
              }}
            />
            {arrow && arrowShape === 'solid' && (
              <path
                d="M-5,-4.6 L7,0 L-5,4.6 Z"
                className={`traffic-edge-v2__arrow traffic-edge-v2__arrow--${key}`}
                data-testid="traffic-edge-v2-arrow"
                data-half={key}
                data-shape="solid"
                data-link-style={styleMode}
                transform={`translate(${arrow.x},${arrow.y}) rotate(${arrow.angleDeg}) scale(${arrowScale})`}
                fill={arrowFill}
                opacity={opacity}
              />
            )}
            {arrow && arrowShape === 'chevron' && (
              <path
                d="M-3.6,-5.2 L6,0 L-3.6,5.2"
                className={`traffic-edge-v2__arrow traffic-edge-v2__arrow--${key} traffic-edge-v2__arrow--chevron`}
                data-testid="traffic-edge-v2-arrow"
                data-half={key}
                data-shape="chevron"
                data-link-style={styleMode}
                transform={`translate(${arrow.x},${arrow.y}) rotate(${arrow.angleDeg}) scale(${arrowScale})`}
                fill="none"
                stroke={arrowFill}
                strokeWidth={2.4}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={opacity}
              />
            )}
          </g>
        );
      })}
      {/* Divisor central (→│←): mostra onde A→B termina e B→A começa. */}
      <path
        d={`M0,${-WEATHER_CENTER_BAR_HALF_HEIGHT} L0,${WEATHER_CENTER_BAR_HALF_HEIGHT}`}
        className="traffic-edge-v2__center"
        data-testid="traffic-edge-v2-center"
        transform={`translate(${center.point.x},${center.point.y}) scale(${Math.min(2.4, Math.max(0.85, 1 / Math.max(0.4, zoom)))})`}
        opacity={Math.min(0.95, opacity + 0.05)}
      />
      {/* Área de clique igual à da V1: o evento sobe para o React Flow. */}
      <path
        id={id}
        d={geometry.path}
        className="traffic-edge__hitarea"
        data-testid="traffic-edge-v2-hitarea"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      {/* Setas móveis: ficam na camada HTML (posicionadas por offset-path nas
          mesmas coordenadas de fluxo dos rótulos). */}
      {halves.some(({ half }) => half.animated) && (
        <EdgeLabelRenderer>
          {halves.map(({ key, half, geometry: halfGeometry, length, arrowShape, arrowFill }) => (
            <HalfRunners
              key={`runner-${key}`}
              path={halfGeometry.path}
              halfKey={key}
              shape={arrowShape}
              count={half.animated ? weatherRunnerCount(zoom, length) : 0}
              durationSeconds={weatherRunnerDuration(length, zoom)}
              color={arrowFill}
              zoom={zoom}
            />
          ))}
        </EdgeLabelRenderer>
      )}
      {(weather.a2b.label || weather.b2a.label || stateText) && (
        <EdgeLabelRenderer>
          {labelFor('a2b', weather.a2b)}
          {labelFor('b2a', weather.b2a)}
          {stateText && (
            <div
              className={`traffic-edge-v2__label traffic-edge-v2__label--pill traffic-edge-v2__label--state traffic-edge-v2__label--${weather.state} ${selected ? 'is-selected' : ''} nodrag nopan`}
              data-testid="traffic-edge-v2-state-label"
              data-state={weather.state}
              data-link-style={styleMode}
              title={visual.reason}
              style={
                {
                  '--wm-pill': weatherStateStyleColor(weather.state, styleMode),
                  transform: `translate(-50%, -50%) translate(${midpoint.x + (statePlacement?.dx ?? fallbackShift.dx)}px, ${midpoint.y + (statePlacement?.dy ?? fallbackShift.dy)}px)`,
                } as React.CSSProperties
              }
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
