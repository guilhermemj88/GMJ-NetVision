/**
 * MAP-VISUAL-V2 — estados visuais dos enlaces (Fase B, laboratório isolado).
 *
 * Módulo puro: tokens + resolução de estado + formatação + política de rótulo.
 * Nada aqui é usado pelo mapa operacional nesta fase; a V1 continua sendo o
 * padrão do produto. Nenhuma API, banco ou polling é tocado.
 *
 * Limites de utilização da V2 (50/80) são os da especificação da fase e vivem
 * SÓ aqui. O restante do produto continua com DEFAULT_LINK_THRESHOLDS
 * (40/70/90) em @gmj/shared — divergência intencional e documentada.
 *
 * Frescor: as amostras de interface já carregam `telemetryUpdatedAt` (última
 * amostra efetiva). O SNMP polla a cada SNMP_POLL_INTERVAL_SECONDS (padrão 60s,
 * mínimo 15s). A hipótese inicial da V2 é declarar stale após TRÊS ciclos de
 * coleta — valor parametrizável e validável com a cadência real. Nenhuma
 * classificação de enlace real usa este número nesta fase.
 */

export type LinkV2State =
  | 'normal'
  | 'attention'
  | 'critical'
  | 'down'
  | 'no-data'
  | 'stale'
  | 'inconsistent';

export type LinkV2Direction = 'a2b' | 'b2a' | 'balanced' | 'unknown';

export const LINK_V2_ATTENTION_PERCENT = 50;
export const LINK_V2_CRITICAL_PERCENT = 80;
/** Diferença de utilização (pontos percentuais) que ainda conta como equilibrado. */
export const LINK_V2_BALANCE_TOLERANCE_PERCENT = 5;
/** Margem acima de 100% antes de tratar a amostra como inconsistente. */
export const LINK_V2_OVER_CAPACITY_TOLERANCE_PERCENT = 5;
export const SNMP_POLL_INTERVAL_SECONDS_DEFAULT = 60;
export const LINK_V2_STALE_POLL_CYCLES = 3;
export const LINK_V2_STALE_AFTER_MS =
  LINK_V2_STALE_POLL_CYCLES * SNMP_POLL_INTERVAL_SECONDS_DEFAULT * 1000;

export const LINK_V2_COLORS: Record<LinkV2State, string> = {
  normal: '#43c59e',
  attention: '#d9a24b',
  critical: '#d25e61',
  down: '#d25e61',
  'no-data': '#718894',
  stale: '#8a9fb0',
  inconsistent: '#a98bd6',
};

export const LINK_V2_DASH: Record<LinkV2State, string | undefined> = {
  normal: undefined,
  attention: undefined,
  critical: undefined,
  down: '7 5',
  'no-data': '2 7',
  stale: '3 6',
  inconsistent: '5 4',
};

export const LINK_V2_STATE_LABELS: Record<LinkV2State, string> = {
  normal: 'Normal',
  attention: 'Atenção',
  critical: 'Crítico',
  down: 'DOWN',
  'no-data': 'Sem dados',
  stale: 'Telemetria desatualizada',
  inconsistent: 'Estado parcial',
};

export interface LinkV2CapacityTier {
  /** Teto da faixa em bps (null = última faixa, sem teto). */
  maxBps: number | null;
  width: number;
  label: string;
}

export const LINK_V2_CAPACITY_TIERS: readonly LinkV2CapacityTier[] = [
  { maxBps: 1_000_000_000, width: 1.2, label: 'até 1 Gbps' },
  { maxBps: 10_000_000_000, width: 2.0, label: '1–10 Gbps' },
  { maxBps: 40_000_000_000, width: 3.0, label: '10–40 Gbps' },
  { maxBps: null, width: 4.5, label: 'acima de 40 Gbps' },
];

/**
 * Capacidade desconhecida NÃO recebe largura de classe conhecida: usa um valor
 * próprio (1.6), fora dos degraus 1.2/2.0/3.0/4.5.
 */
export const LINK_V2_UNKNOWN_CAPACITY_WIDTH = 1.6;

/**
 * Fase C — espessura compensada por zoom.
 *
 * A largura final é sempre em PIXELS DE TELA: o clamp garante que nenhum
 * enlace desapareça (mínimo) nem domine o mapa (máximo) em qualquer zoom.
 * `strokeWidth` no SVG é convertido para unidades de fluxo (dividindo pelo
 * zoom) quando o modo é 'zoom'; no modo 'non-scaling' o valor permanece a
 * largura-alvo e o `vector-effect` resolve no navegador.
 */
export const LINK_V2_SCREEN_MIN_PX = 1.2;
export const LINK_V2_SCREEN_MAX_PX = 4.5;

export type LinkV2StrokeMode = 'zoom' | 'non-scaling' | 'none';

export function linkV2ScreenStrokeWidth(capacityBps: number | null): number {
  const base = linkV2StrokeWidth(capacityBps);
  return Math.min(LINK_V2_SCREEN_MAX_PX, Math.max(LINK_V2_SCREEN_MIN_PX, base));
}

/** Escala padronizada de `stroke-dasharray` (mesmo padrão em qualquer zoom). */
export function scaleStrokeDasharray(
  dash: string | undefined,
  factor: number,
): string | undefined {
  if (!dash || !Number.isFinite(factor) || factor <= 0) return dash;
  const parts = dash
    .split(/[\s,]+/)
    .map((part) => Number(part))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (parts.length === 0) return dash;
  return parts.map((value) => String(Math.round(value * factor * 100) / 100)).join(' ');
}

export interface LinkV2EdgeStroke {
  strokeWidth: number;
  strokeDasharray: string | undefined;
  nonScaling: boolean;
}

export function resolveLinkV2EdgeStroke({
  mode,
  capacityBps,
  dash,
  zoom,
}: {
  mode: LinkV2StrokeMode;
  capacityBps: number | null;
  dash: string | undefined;
  zoom: number;
}): LinkV2EdgeStroke {
  const screenWidth = linkV2ScreenStrokeWidth(capacityBps);
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  if (mode === 'zoom') {
    return {
      strokeWidth: screenWidth / safeZoom,
      strokeDasharray: scaleStrokeDasharray(dash, 1 / safeZoom),
      nonScaling: false,
    };
  }
  return { strokeWidth: screenWidth, strokeDasharray: dash, nonScaling: mode === 'non-scaling' };
}

/**
 * Escala da seta. A seta desenhada tem 12 unidades de largura; a meta é
 * mantê-la legível na tela quando há compensação e deixá-la escalar com o
 * zoom apenas no modo 'none' (baseline da Fase B).
 */
export function linkV2ArrowScale(
  mode: LinkV2StrokeMode,
  screenWidth: number,
  zoom: number,
): number {
  if (mode === 'none') return 1;
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const raw = (8 + screenWidth) / 12 / safeZoom;
  return Math.min(5, Math.max(0.4, raw));
}

export function linkV2CapacityTier(capacityBps: number | null): LinkV2CapacityTier | null {
  if (capacityBps === null || !Number.isFinite(capacityBps) || capacityBps <= 0) return null;
  return (
    LINK_V2_CAPACITY_TIERS.find((tier) => tier.maxBps !== null && capacityBps <= tier.maxBps) ??
    LINK_V2_CAPACITY_TIERS[LINK_V2_CAPACITY_TIERS.length - 1] ??
    null
  );
}

export function linkV2StrokeWidth(capacityBps: number | null): number {
  return linkV2CapacityTier(capacityBps)?.width ?? LINK_V2_UNKNOWN_CAPACITY_WIDTH;
}

/** Formato curto para rótulo: "25G", "94G", "1.5G", "620M". */
export function formatCompactBps(bps: number | null): string {
  if (bps === null || !Number.isFinite(bps) || bps < 0) return '—';
  if (bps >= 1_000_000_000) {
    const gbps = bps / 1_000_000_000;
    return `${gbps >= 10 ? Math.round(gbps) : Math.round(gbps * 10) / 10}G`;
  }
  if (bps >= 1_000_000) {
    const mbps = bps / 1_000_000;
    return `${mbps >= 10 ? Math.round(mbps) : Math.round(mbps * 10) / 10}M`;
  }
  if (bps >= 1_000) return `${Math.round(bps / 1_000)}K`;
  return `${Math.round(bps)}`;
}

export interface LinkV2DirectionInput {
  /** Taxa observada no sentido (bps); null quando o sentido não tem telemetria. */
  bps: number | null;
  /** Carimbo da última amostra efetiva (ms epoch); null sem carimbo confiável. */
  sampledAtMs: number | null;
}

export interface LinkV2Input {
  operational: 'up' | 'down' | 'unknown';
  capacityBps: number | null;
  aToB: LinkV2DirectionInput;
  bToA: LinkV2DirectionInput;
  /** Inconsistência declarada pela origem dos dados (não inferida aqui). */
  inconsistent?: boolean;
  /** Alarmes associados ao enlace no mock — reforçam a recomendação de rótulo. */
  alarms?: number;
}

export interface LinkV2DirectionResolution {
  usable: boolean;
  stale: boolean;
  hasSample: boolean;
  bps: number | null;
  /** Utilização bruta em % (pode passar de 100 quando a amostra é estranha). */
  utilizationPercent: number | null;
}

export interface LinkV2ResolutionOptions {
  nowMs: number;
  staleAfterMs?: number;
}

export interface LinkV2Visual {
  state: LinkV2State;
  /** Motivo técnico do estado, para tooltip/depuração. */
  reason: string;
  color: string;
  strokeDasharray: string | undefined;
  strokeWidth: number;
  capacityTierLabel: string;
  utilizationPercent: number | null;
  dominantBps: number | null;
  direction: LinkV2Direction;
  /** Apenas um sentido tem avaliação válida. */
  partial: boolean;
  /** Alguma direção considerada tem amostra desatualizada. */
  stale: boolean;
  aToB: LinkV2DirectionResolution;
  bToA: LinkV2DirectionResolution;
  labelText: string;
  labelRecommended: boolean;
}

function resolveDirection(
  direction: LinkV2DirectionInput,
  capacityBps: number | null,
  nowMs: number,
  staleAfterMs: number,
): LinkV2DirectionResolution {
  const hasSample = direction.bps !== null && direction.sampledAtMs !== null;
  const stale = hasSample && nowMs - (direction.sampledAtMs as number) > staleAfterMs;
  const utilizationPercent =
    hasSample && capacityBps !== null && capacityBps > 0
      ? ((direction.bps as number) / capacityBps) * 100
      : null;
  return {
    usable: hasSample && !stale && utilizationPercent !== null,
    stale,
    hasSample,
    bps: direction.bps,
    utilizationPercent,
  };
}

export function resolveLinkV2Visual(
  input: LinkV2Input,
  options: LinkV2ResolutionOptions,
): LinkV2Visual {
  const staleAfterMs = options.staleAfterMs ?? LINK_V2_STALE_AFTER_MS;
  const aToB = resolveDirection(input.aToB, input.capacityBps, options.nowMs, staleAfterMs);
  const bToA = resolveDirection(input.bToA, input.capacityBps, options.nowMs, staleAfterMs);
  const usable = [aToB, bToA].filter((direction) => direction.usable);
  const anySample = aToB.hasSample || bToA.hasSample;
  const anyStale = aToB.stale || bToA.stale;
  const overCapacity = usable.some(
    (direction) =>
      (direction.utilizationPercent ?? 0) > 100 + LINK_V2_OVER_CAPACITY_TOLERANCE_PERCENT,
  );

  let state: LinkV2State;
  let reason: string;

  if (input.operational === 'down') {
    state = 'down';
    reason = 'operational-down';
  } else if (usable.length === 0) {
    if (input.capacityBps === null) {
      state = 'no-data';
      reason = 'capacity-unknown';
    } else if (anySample) {
      state = 'stale';
      reason = 'stale';
    } else {
      state = 'no-data';
      reason = 'no-samples';
    }
  } else if (input.inconsistent || overCapacity || input.operational === 'unknown') {
    state = 'inconsistent';
    reason = input.inconsistent
      ? 'declared-inconsistent'
      : overCapacity
        ? 'over-capacity'
        : 'operational-unknown';
  } else {
    const utilization = Math.min(
      100,
      Math.max(aToB.utilizationPercent ?? 0, bToA.utilizationPercent ?? 0),
    );
    state =
      utilization >= LINK_V2_CRITICAL_PERCENT
        ? 'critical'
        : utilization >= LINK_V2_ATTENTION_PERCENT
          ? 'attention'
          : 'normal';
    reason = 'utilization';
  }

  // Valores usados no rótulo: direções utilizáveis; no estado STALE, aceita a
  // última amostra conhecida (marcada como antiga); em INCONSISTENTE, mostra o
  // número suspeito sem escondê-lo.
  const valueOf = (
    direction: LinkV2DirectionResolution,
    fallbackToStaleSample: boolean,
  ): number | null => {
    if (direction.usable) return direction.utilizationPercent;
    if (fallbackToStaleSample && (state === 'stale' || state === 'inconsistent') && direction.hasSample)
      return direction.utilizationPercent;
    return null;
  };
  const aValue = valueOf(aToB, true);
  const bValue = valueOf(bToA, true);
  const evaluatedCount = (aValue === null ? 0 : 1) + (bValue === null ? 0 : 1);
  /** Avaliação parcial: só um sentido tem amostra aproveitável. */
  const partial = state !== 'down' && state !== 'no-data' && evaluatedCount === 1;

  let utilizationPercent: number | null = null;
  let dominantBps: number | null = null;
  let direction: LinkV2Direction = 'unknown';

  if (evaluatedCount === 1) {
    const useA = aValue !== null;
    direction = useA ? 'a2b' : 'b2a';
    const raw = (aValue ?? bValue) as number;
    utilizationPercent = state === 'inconsistent' ? raw : Math.min(100, raw);
    dominantBps = useA ? aToB.bps : bToA.bps;
  } else if (evaluatedCount === 2) {
    const a = aValue as number;
    const b = bValue as number;
    const balanced =
      state !== 'inconsistent' && Math.abs(a - b) <= LINK_V2_BALANCE_TOLERANCE_PERCENT;
    if (balanced) {
      direction = 'balanced';
      utilizationPercent = Math.min(100, Math.max(a, b));
      dominantBps = Math.max(aToB.bps ?? 0, bToA.bps ?? 0);
    } else if (a >= b) {
      direction = 'a2b';
      utilizationPercent = state === 'inconsistent' ? a : Math.min(100, a);
      dominantBps = aToB.bps;
    } else {
      direction = 'b2a';
      utilizationPercent = state === 'inconsistent' ? b : Math.min(100, b);
      dominantBps = bToA.bps;
    }
  }

  const percentText = utilizationPercent === null ? null : `${Math.round(utilizationPercent)}%`;
  const trafficText = formatCompactBps(dominantBps);

  let labelText: string;
  switch (state) {
    case 'down':
      labelText = 'DOWN';
      break;
    case 'no-data':
      labelText = reason === 'capacity-unknown' ? 'sem capacidade' : 'sem telemetria';
      break;
    case 'inconsistent':
      labelText = percentText
        ? `${trafficText} · ${percentText} · ${reason === 'operational-unknown' ? 'parcial' : 'inconsistente'}`
        : 'estado parcial';
      break;
    default:
      labelText = percentText ? `${trafficText} · ${percentText}` : 'sem telemetria';
      if (state === 'stale') labelText += ' · antigo';
      else if (partial || evaluatedCount === 1) labelText += ' · parcial';
      break;
  }

  return {
    state,
    reason,
    color: LINK_V2_COLORS[state],
    strokeDasharray: LINK_V2_DASH[state],
    strokeWidth: linkV2StrokeWidth(input.capacityBps),
    capacityTierLabel: linkV2CapacityTier(input.capacityBps)?.label ?? 'capacidade desconhecida',
    utilizationPercent,
    dominantBps,
    direction,
    partial,
    stale: anyStale,
    aToB,
    bToA,
    labelText,
    labelRecommended: state !== 'normal' || (input.alarms ?? 0) > 0,
  };
}

/** A seta segue a topologia somente quando existe sentido dominante confiável. */
export function linkV2ShowsArrow(visual: LinkV2Visual): boolean {
  if (visual.state === 'down' || visual.state === 'no-data' || visual.state === 'stale') return false;
  return visual.direction === 'a2b' || visual.direction === 'b2a';
}

export interface LinkV2LabelPolicyContext {
  /** Controle "Mostrar todos os rótulos". */
  showAll: boolean;
  selected: boolean;
  hovered: boolean;
  /** Enlace conectado ao nó selecionado. */
  adjacentToSelectedNode: boolean;
}

/**
 * Rótulo inteligente: só some quando o enlace é saudável abaixo de 50% e não
 * está selecionado, em hover nem ligado ao nó selecionado.
 */
export function shouldShowLinkV2Label(
  visual: LinkV2Visual,
  context: LinkV2LabelPolicyContext,
): boolean {
  if (context.showAll) return true;
  if (context.selected || context.hovered || context.adjacentToSelectedNode) return true;
  return visual.labelRecommended;
}

/** Blocos do tooltip (RX/TX completos continuam disponíveis no detalhe). */
export function linkV2StateDescription(visual: LinkV2Visual): string {
  switch (visual.state) {
    case 'down':
      return 'Operação confirmada como DOWN — não há indicação de utilização.';
    case 'no-data':
      return visual.reason === 'capacity-unknown'
        ? 'Capacidade não declarada: utilização não calculada em nenhum sentido.'
        : 'Sem telemetria válida em nenhum sentido.';
    case 'stale':
      return 'Existe amostra, mas ela está desatualizada (mais de 3 ciclos de coleta).';
    case 'inconsistent':
      return visual.reason === 'operational-unknown'
        ? 'Estado operacional parcialmente conhecido — sem fingir normalidade.'
        : 'Amostra inconsistente (utilização acima da capacidade tolerada ou marcada como inconsistente).';
    default:
      return visual.partial
        ? 'Avaliação parcial: apenas um sentido tem amostra válida e recente.'
        : 'Utilização válida nos dois sentidos.';
  }
}
