/**
 * MAP-VISUAL-V2 — Fase E: modelo do enlace bidirecional (WeatherMap moderno).
 *
 * Cada enlace tem UMA trajetória e DUAS metades independentes:
 *  - a metade A→B representa o tráfego transmitido pela ponta A em direção à B;
 *  - a metade B→A representa o transmitido pela ponta B em direção à A;
 *  - cada metade tem cor (utilização daquele sentido), seta apontando para o
 *    centro e, opcionalmente, um stream animado.
 *
 * Este módulo é puro: recebe o `LinkV2Visual` já resolvido pelo adaptador real
 * (`map-visual-v2-link`) e devolve cores/tokens, textos e flags. Nada de React,
 * nada de DOM, nada de telemetria inventada: sentido sem amostra vira
 * `unknown`/`no-data`, nunca "normal".
 *
 * As cores são TOKENS CSS (`--wm-*`, definidos em globals.css a partir da
 * paleta do NetVision) para que traço, seta, rótulo e legenda nunca divirjam.
 */

import {
  LINK_V2_COLORS,
  LINK_V2_DASH,
  LINK_V2_ATTENTION_PERCENT,
  LINK_V2_CRITICAL_PERCENT,
  linkV2StrokeWidth,
  linkV2CapacityTier,
  type LinkV2State,
  type LinkV2Visual,
} from './map-visual-v2';

export type LinkV2AnimationMode = 'off' | 'smart' | 'always';
export type WeatherHalfKey = 'a2b' | 'b2a';

/** Estado de UMA metade do enlace (o que aquele sentido mostra). */
export type WeatherHalfState =
  | 'normal'
  | 'attention'
  | 'critical'
  | 'down'
  | 'no-data'
  | 'stale'
  | 'inconsistent'
  /** Sentido sem amostra aproveitável (avaliação parcial). */
  | 'unknown';

export const WEATHER_HALF_COLOR_VAR: Record<WeatherHalfState, string> = {
  normal: 'var(--wm-util-normal)',
  attention: 'var(--wm-util-attention)',
  critical: 'var(--wm-util-critical)',
  down: 'var(--wm-state-down)',
  'no-data': 'var(--wm-state-no-data)',
  stale: 'var(--wm-state-stale)',
  inconsistent: 'var(--wm-state-inconsistent)',
  unknown: 'var(--wm-state-unknown)',
};

/** Estados cuja linha é tracejada (nunca "contínuo saudável"). */
const DASHED_HALF_STATES: readonly WeatherHalfState[] = [
  'down',
  'no-data',
  'stale',
  'inconsistent',
  'unknown',
];

/** Unidades decimais de bits/s — nunca bytes, nunca "G"/"M" solto. */
export const LINK_V2_BPS_UNITS = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'] as const;

/**
 * Formata taxa em unidades COMPLETAS com decimais enxutos:
 * 38 Gbps · 3.2 Gbps · 650 Mbps · 845 Kbps · 27.4 Gbps · 2.5 Tbps.
 *
 * Regra de casas: >= 100 → 0; >= 10 → 1; abaixo → 2 (zeros à direita caem).
 * Se o arredondamento cruzar 1000, sobe de unidade (999.999.999 bps = 1 Gbps),
 * então tráfego baixo nunca vira "0" numa unidade maior.
 */
export function formatLinkV2TrafficBps(bps: number | null | undefined): string | null {
  if (bps === null || bps === undefined || !Number.isFinite(bps) || bps < 0) return null;
  let unitIndex = 0;
  let value = bps;
  while (value >= 1000 && unitIndex < LINK_V2_BPS_UNITS.length - 1) {
    value /= 1000;
    unitIndex += 1;
  }
  const decimalsFor = (candidate: number) => (candidate >= 100 ? 0 : candidate >= 10 ? 1 : 2);
  // Três passos cobrem qualquer promoção de unidade (999.999 bps → Mbps → Gbps).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rounded = Number(value.toFixed(decimalsFor(value)));
    if (rounded >= 1000 && unitIndex < LINK_V2_BPS_UNITS.length - 1) {
      value /= 1000;
      unitIndex += 1;
      continue;
    }
    const trimmed = value
      .toFixed(decimalsFor(value))
      .replace(/\.0+$/, '')
      .replace(/(\.\d*?)0+$/, '$1');
    return `${trimmed} ${LINK_V2_BPS_UNITS[unitIndex]}`;
  }
  return `${value.toFixed(0)} ${LINK_V2_BPS_UNITS[unitIndex]}`;
}

export function formatLinkV2Percent(percent: number | null | undefined): string | null {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return null;
  return `${Math.round(percent)}%`;
}

export interface WeatherHalf {
  key: WeatherHalfKey;
  state: WeatherHalfState;
  /** Token CSS da cor do sentido. */
  color: string;
  /** Taxa observada no sentido (bps) — null quando não há amostra. */
  bps: number | null;
  percent: number | null;
  /** "38 Gbps · 94%" (null quando não existe valor confiável a mostrar). */
  label: string | null;
  /** "94%" ou o estado curto ("sem dados"). */
  compactLabel: string | null;
  /** Existe amostra aproveitável neste sentido. */
  valid: boolean;
  arrow: boolean;
  animated: boolean;
  dashed: boolean;
  /** Sentido do fluxo na animação, relativo à parametrização A→B da curva. */
  streamDirection: 'forward' | 'reverse';
  reason: string;
}

export interface WeatherLabelContext {
  showAll: boolean;
  selected: boolean;
  hovered: boolean;
  adjacentToSelectedNode: boolean;
}

export type WeatherLabelMode = 'full' | 'compact' | 'hidden';

export interface WeatherMapResolution {
  /** Estado do enlace (operação prevalece sobre utilização). */
  state: LinkV2State;
  reason: string;
  a2b: WeatherHalf;
  b2a: WeatherHalf;
  /** Rótulo único para estados sem direção (DOWN / SEM DADOS / antigo). */
  stateLabel: string | null;
  stateColor: string;
  partial: boolean;
  stale: boolean;
  utilizationPercent: number | null;
  strokeWidth: number;
  capacityTierLabel: string;
  labelRecommended: boolean;
  animated: boolean;
}

function bandState(percent: number | null): WeatherHalfState {
  if (percent === null || !Number.isFinite(percent)) return 'unknown';
  if (percent >= LINK_V2_CRITICAL_PERCENT) return 'critical';
  if (percent >= LINK_V2_ATTENTION_PERCENT) return 'attention';
  return 'normal';
}

/** Animação inteligente: foco do operador ou sentido em atenção/crítico. */
export function shouldAnimateHalf(
  state: WeatherHalfState,
  mode: LinkV2AnimationMode,
  context: { selected: boolean; hovered: boolean },
): boolean {
  if (mode === 'off') return false;
  if (state !== 'normal' && state !== 'attention' && state !== 'critical') return false;
  if (mode === 'always') return true;
  return context.selected || context.hovered || state === 'attention' || state === 'critical';
}

/** Fração do ARCO da metade onde fica o rótulo (meio de cada metade). */
export const WEATHER_LABEL_HALF_FRACTION = 0.5;
/** Fração do ARCO da metade onde fica a seta (perto do centro, sem encostar). */
export const WEATHER_ARROW_HALF_FRACTION = 0.72;

/** Tracejado de cada estado de metade — herdado da paleta de estados da V2. */
export function weatherHalfDash(half: Pick<WeatherHalf, 'state'>): string | undefined {
  switch (half.state) {
    case 'down':
      return LINK_V2_DASH.down;
    case 'inconsistent':
      return LINK_V2_DASH.inconsistent;
    case 'stale':
      return LINK_V2_DASH.stale;
    case 'no-data':
      return LINK_V2_DASH['no-data'];
    case 'unknown':
      // Sentido sem amostra: tracejado bem discreto, sem sugerir tráfego.
      return '2 7';
    default:
      return undefined;
  }
}

function buildHalf({
  key,
  state,
  bps,
  percent,
  reason,
  valid,
  arrow,
  animated,
  suffix,
  emptyLabel,
}: {
  key: WeatherHalfKey;
  state: WeatherHalfState;
  bps: number | null;
  percent: number | null;
  reason: string;
  valid: boolean;
  arrow: boolean;
  animated: boolean;
  suffix?: string | null;
  emptyLabel?: string | null;
}): WeatherHalf {
  const trafficText = formatLinkV2TrafficBps(bps);
  const percentText = formatLinkV2Percent(percent);
  const core = trafficText && percentText ? `${trafficText} · ${percentText}` : (trafficText ?? percentText);
  const label = core ? (suffix ? `${core} · ${suffix}` : core) : null;
  return {
    key,
    state,
    color: WEATHER_HALF_COLOR_VAR[state],
    bps,
    percent,
    label: label ?? emptyLabel ?? null,
    compactLabel: percentText ?? (trafficText ? trafficText : (emptyLabel ?? null)),
    valid,
    arrow,
    animated,
    dashed: DASHED_HALF_STATES.includes(state),
    streamDirection: key === 'a2b' ? 'forward' : 'reverse',
    reason,
  };
}

export interface WeatherMapContext {
  selected?: boolean;
  hovered?: boolean;
  animation?: LinkV2AnimationMode;
}

/**
 * Resolve as duas metades a partir do visual já apurado com dados reais.
 *
 * Precedência (item 12 da especificação): DOWN operacional > ausência total de
 * amostra (sem dados) > amostra antiga (stale) > inconsistência > utilização
 * por sentido.
 */
export function resolveWeatherMap(
  visual: LinkV2Visual,
  context: WeatherMapContext = {},
): WeatherMapResolution {
  const mode = context.animation ?? 'smart';
  const interaction = { selected: Boolean(context.selected), hovered: Boolean(context.hovered) };
  const a = visual.aToB;
  const b = visual.bToA;

  const animate = (state: WeatherHalfState) => shouldAnimateHalf(state, mode, interaction);

  let a2b: WeatherHalf;
  let b2a: WeatherHalf;
  let stateLabel: string | null = null;

  if (visual.state === 'down') {
    stateLabel = 'DOWN';
    a2b = buildHalf({
      key: 'a2b',
      state: 'down',
      bps: null,
      percent: null,
      reason: visual.reason,
      valid: false,
      arrow: false,
      animated: false,
    });
    b2a = buildHalf({
      key: 'b2a',
      state: 'down',
      bps: null,
      percent: null,
      reason: visual.reason,
      valid: false,
      arrow: false,
      animated: false,
    });
  } else if (visual.state === 'no-data') {
    stateLabel = 'SEM DADOS';
    const reason = visual.reason;
    a2b = buildHalf({
      key: 'a2b',
      state: 'no-data',
      bps: null,
      percent: null,
      reason,
      valid: false,
      arrow: false,
      animated: false,
    });
    b2a = buildHalf({
      key: 'b2a',
      state: 'no-data',
      bps: null,
      percent: null,
      reason,
      valid: false,
      arrow: false,
      animated: false,
    });
  } else if (visual.state === 'stale') {
    stateLabel = 'DADOS ANTIGOS';
    a2b = buildHalf({
      key: 'a2b',
      state: 'stale',
      bps: a.hasSample ? a.bps : null,
      percent: a.hasSample ? a.utilizationPercent : null,
      reason: 'stale',
      valid: false,
      arrow: false,
      animated: false,
      suffix: 'antigo',
      emptyLabel: 'sem dados',
    });
    b2a = buildHalf({
      key: 'b2a',
      state: 'stale',
      bps: b.hasSample ? b.bps : null,
      percent: b.hasSample ? b.utilizationPercent : null,
      reason: 'stale',
      valid: false,
      arrow: false,
      animated: false,
      suffix: 'antigo',
      emptyLabel: 'sem dados',
    });
  } else {
    const halfOf = (
      key: WeatherHalfKey,
      direction: LinkV2Visual['aToB'],
    ): WeatherHalf => {
      if (!direction.hasSample) {
        return buildHalf({
          key,
          state: 'unknown',
          bps: null,
          percent: null,
          reason: 'no-sample-this-side',
          valid: false,
          arrow: false,
          animated: false,
          emptyLabel: 'sem dados',
        });
      }
      if (direction.stale) {
        return buildHalf({
          key,
          state: 'stale',
          bps: direction.bps,
          percent: direction.utilizationPercent,
          reason: 'stale-this-side',
          valid: false,
          arrow: false,
          animated: false,
          suffix: 'antigo',
        });
      }
      if (visual.state === 'inconsistent') {
        const value = direction.utilizationPercent;
        const suspect = visual.reason === 'over-capacity' || visual.reason === 'declared-inconsistent';
        const halfState: WeatherHalfState = 'inconsistent';
        return buildHalf({
          key,
          state: halfState,
          bps: direction.bps,
          percent: value,
          reason: visual.reason,
          valid: true,
          arrow: true,
          animated: animate(halfState),
          suffix: suspect ? 'inconsistente' : 'parcial',
        });
      }
      const percent = direction.utilizationPercent;
      const halfState = bandState(percent);
      return buildHalf({
        key,
        state: halfState,
        bps: direction.bps,
        percent,
        reason: 'utilization',
        valid: true,
        arrow: true,
        animated: animate(halfState),
        suffix: visual.partial ? 'parcial' : null,
      });
    };
    a2b = halfOf('a2b', a);
    b2a = halfOf('b2a', b);
  }

  return {
    state: visual.state,
    reason: visual.reason,
    a2b,
    b2a,
    stateLabel,
    stateColor: LINK_V2_COLORS[visual.state],
    partial: visual.partial,
    stale: visual.stale,
    utilizationPercent: visual.utilizationPercent,
    strokeWidth: linkV2StrokeWidth(
      Number.isFinite(visual.strokeWidth) ? visual.strokeWidth : null,
    ),
    capacityTierLabel: visual.capacityTierLabel,
    labelRecommended: visual.labelRecommended,
    animated: a2b.animated || b2a.animated,
  };
}

/**
 * Largura usada no mapa: a MESMA nas duas metades (a espessura representa
 * capacidade do enlace, nunca o tráfego de um sentido — item 9).
 */
export function weatherStrokeWidth(capacityBps: number | null): number {
  return linkV2StrokeWidth(capacityBps);
}

/** Legenda/tooltip do enlace: estado + capacidade real. */
export function weatherCapacityLabel(capacityBps: number | null): string {
  return linkV2CapacityTier(capacityBps)?.label ?? 'capacidade desconhecida';
}

/**
 * Rótulo por metade (item 10): em foco mostra os dois sentidos; fora de foco só
 * aparece o lado em atenção/crítico/inconsistente — enlace saudável abaixo de
 * 50% fica sem valor permanente, mas mantém as setas.
 */
export function weatherHalfLabelMode(
  half: WeatherHalf,
  context: WeatherLabelContext,
): WeatherLabelMode {
  if (!half.label && !half.compactLabel) return 'hidden';
  if (context.showAll || context.selected || context.hovered || context.adjacentToSelectedNode) {
    return 'full';
  }
  if (half.state === 'attention' || half.state === 'critical' || half.state === 'inconsistent') {
    return 'full';
  }
  if (half.state === 'stale') return 'compact';
  return 'hidden';
}

/** Estados sem direção mostram um rótulo único (DOWN / SEM DADOS / antigo). */
export function weatherStateLabelMode(
  resolution: WeatherMapResolution,
  context: WeatherLabelContext,
): WeatherLabelMode {
  if (!resolution.stateLabel) return 'hidden';
  return context.showAll || context.selected || context.hovered || context.adjacentToSelectedNode
    ? 'full'
    : 'full';
}

export function weatherHalfText(half: WeatherHalf, mode: WeatherLabelMode): string | null {
  if (mode === 'hidden') return null;
  return mode === 'full' ? (half.label ?? half.compactLabel) : (half.compactLabel ?? half.label);
}

/** Linhas tracejadas do estado global (quando o enlace todo está fora de banda). */
export function weatherStateDash(resolution: WeatherMapResolution): string | undefined {
  return LINK_V2_DASH[resolution.state];
}

// --- Diferenciação dos sentidos e leitura do centro (Fase F) -----------------

/**
 * Vão explícito no centro do enlace, em pixels de TELA. É o que mostra onde a
 * metade A→B termina e a B→A começa sem colocar nada por cima do traçado.
 */
export const WEATHER_CENTER_GAP_PX = 12;
/** Fração máxima de cada metade consumida pelo vão (enlace curto não vira nada). */
export const WEATHER_CENTER_GAP_MAX_HALF_SHARE = 0.18;

/**
 * Vão central em unidades de FLUXO, limitado pela metade mais curta.
 * Devolve `fraction` (metade do vão, em fração do arco total) pronto para
 * `splitGeometryRange`.
 */
export function weatherCenterGap(
  zoom: number,
  halfLength: number,
): { units: number; fraction: number } {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const safeHalf = Number.isFinite(halfLength) && halfLength > 0 ? halfLength : 1;
  const raw = WEATHER_CENTER_GAP_PX / safeZoom;
  const units = Math.min(raw, safeHalf * 2 * WEATHER_CENTER_GAP_MAX_HALF_SHARE);
  return { units, fraction: units / 2 / safeHalf / 2 };
}

/**
 * Como cada metade se distingue quando a cor é a MESMA (itens 2 e 3 do pedido):
 *  - A→B: cor cheia e seta cheia (triângulo);
 *  - B→A: mesma cor porém esmaecida e seta vazada (chevron).
 * A espessura continua idêntica: ela representa capacidade, não sentido.
 */
export const WEATHER_B2A_STROKE_MIX_PERCENT = 72;
export type WeatherArrowShape = 'solid' | 'chevron';

export function weatherArrowShape(key: WeatherHalfKey): WeatherArrowShape {
  return key === 'a2b' ? 'solid' : 'chevron';
}

/** Cor efetiva do traço da metade (a B→A entra esmaecida sobre o fundo do mapa). */
export function weatherHalfStroke(colorToken: string, key: WeatherHalfKey): string {
  if (key === 'a2b') return colorToken;
  return `color-mix(in srgb, ${colorToken} ${WEATHER_B2A_STROKE_MIX_PERCENT}%, var(--wm-dim-mix))`;
}

/** Cor das setas (cheia para A→B, mais clara/vazada para B→A). */
export function weatherArrowTint(colorToken: string, key: WeatherHalfKey): string {
  return key === 'a2b' ? colorToken : `color-mix(in srgb, ${colorToken} 82%, #dce8ee)`;
}

/**
 * Setas móveis ("runners") ao longo de cada metade — item 4 do pedido.
 * Abaixo de `WEATHER_RUNNER_MIN_ZOOM` não vale a pena: o mapa está em visão
 * geral e o movimento vira ruído (mesma lógica dos rótulos).
 */
export const WEATHER_RUNNER_MIN_ZOOM = 0.45;
export const WEATHER_RUNNER_MAX = 3;
/** Abaixo disso (px de tela) a metade é curta demais para mostrar movimento. */
export const WEATHER_RUNNER_MIN_SCREEN_LENGTH = 34;

export function weatherRunnerCount(zoom: number, halfLength: number): number {
  if (!Number.isFinite(zoom) || zoom < WEATHER_RUNNER_MIN_ZOOM) return 0;
  if (!Number.isFinite(halfLength) || halfLength <= 0) return 0;
  const screenLength = halfLength * zoom;
  if (screenLength < WEATHER_RUNNER_MIN_SCREEN_LENGTH) return 0;
  if (screenLength < 90) return 1;
  if (zoom < 1.15) return 2;
  return WEATHER_RUNNER_MAX;
}

/**
 * Duração de UMA travessia da metade (segundos). Mantém a velocidade percebida
 * entre enlaces de tamanhos diferentes: 4 a 6 s por metade, conforme o item 11.
 */
export const WEATHER_RUNNER_TRAVEL_SECONDS = 5;

export function weatherRunnerDuration(halfLength: number, zoom: number): number {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const screenLength = Math.max(24, (Number.isFinite(halfLength) ? halfLength : 24) * safeZoom);
  const raw = (WEATHER_RUNNER_TRAVEL_SECONDS * screenLength) / 260;
  return Math.min(6.5, Math.max(2.6, raw));
}

/** Rótulo de animação exposto na barra superior do preview. */
export const LINK_V2_ANIMATION_LABELS: Record<LinkV2AnimationMode, string> = {
  off: 'Desligada',
  smart: 'Inteligente',
  always: 'Sempre ativa',
};

// --- Stream animado (microanimação discreta) --------------------------------

/** Período do stream como fração da metade (quantos "trens" cabem no trajeto). */
export const WEATHER_STREAM_PERIOD_RATIO = 1 / 6;
export const WEATHER_STREAM_PERIOD_MIN_PX = 22;
export const WEATHER_STREAM_PERIOD_MAX_PX = 68;
/** Tempo de travessia completa de uma metade (segundos) — item 11: 4 a 6 s. */
export const WEATHER_STREAM_TRAVEL_SECONDS = 5;

export interface WeatherStreamStyle {
  /** Período do padrão, em unidades de fluxo. */
  period: number;
  /** Duração de UM período na tela (s) — o loop do CSS é contínuo e sem salto. */
  durationSeconds: number;
  /** `stroke-dasharray` do segmento luminoso. */
  dashArray: string;
}

/**
 * Estilo do stream para uma metade.
 *
 * `zoom` compensa o padrão (igual à espessura): o trem de segmentos mantém o
 * tamanho na TELA. A duração é derivada de `WEATHER_STREAM_TRAVEL_SECONDS`, o
 * que deixa o movimento com a mesma velocidade percebida em qualquer zoom.
 */
export function weatherStreamStyle(halfLength: number, zoom: number): WeatherStreamStyle {
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const safeLength = Number.isFinite(halfLength) && halfLength > 1 ? halfLength : 1;
  const raw = safeLength * WEATHER_STREAM_PERIOD_RATIO;
  const min = WEATHER_STREAM_PERIOD_MIN_PX / safeZoom;
  const max = WEATHER_STREAM_PERIOD_MAX_PX / safeZoom;
  const period = Math.min(max, Math.max(min, raw));
  const durationSeconds = Math.min(
    3,
    Math.max(0.5, (WEATHER_STREAM_TRAVEL_SECONDS * period) / safeLength),
  );
  return {
    period,
    durationSeconds,
    dashArray: `${round(period * 0.32)} ${round(period * 0.68)}`,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
