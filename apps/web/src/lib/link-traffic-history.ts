import {
  resolveMetricInterfaceGroups,
  singleEndedMonitoredSide,
  type LinkInterfaceResolver,
  type MetricPoint,
  type NetworkInterface,
  type NetworkLink,
} from '@gmj/shared';

export type LinkHistoryDirectionId = 'A_TO_B' | 'B_TO_A';
export type LinkHistoryField = 'rx' | 'tx';

/**
 * Fonte historica de UMA direcao: as interfaces cujo campo alimenta o fluxo.
 * A serie nunca cruza pontas: um sentido usa SOMENTE o TX da origem (canonico)
 * ou, quando o TX nao tem historico, SOMENTE o RX observado no destino —
 * jamais a soma dos dois lados, que contaria o mesmo fluxo duas vezes.
 */
export interface LinkHistorySource {
  interfaces: NetworkInterface[];
  field: LinkHistoryField;
  /** Rotulo curto da origem fisica, ex.: "TX ponta A". */
  label: string;
}

export interface LinkHistoryDirectionPlan {
  direction: LinkHistoryDirectionId;
  primary: LinkHistorySource | null;
  fallback: LinkHistorySource | null;
}

export interface LinkHistoryValuePoint {
  timestamp: string;
  value: number | null;
}

export interface LinkHistorySeries {
  direction: LinkHistoryDirectionId;
  points: LinkHistoryValuePoint[];
  /** Fonte efetivamente exibida; `null` quando nenhuma teve amostra. */
  used: LinkHistorySource | null;
  /** `true` quando o TX estava sem historico e o RX observado foi usado. */
  usedFallback: boolean;
}

export interface LinkHistoryStats {
  current: number | null;
  average: number | null;
  peak: number | null;
  samples: number;
}

export interface LinkHistoryCounterRecord {
  timestamp: string;
  aToBErrors: number | null;
  bToAErrors: number | null;
  aToBDiscards: number | null;
  bToADiscards: number | null;
}

/**
 * Planos das duas direcoes espelhando EXATAMENTE a semantica ao vivo do
 * `aggregateLinkMetrics` do shared: TX da origem e o valor canonico, RX do
 * destino e o observado (compatibilidade) para enlaces bidirecionais; enlace
 * unilateral usa o lado monitorado (TX/RX locais) sem fallback.
 */
export function linkHistoryPlans(
  link: NetworkLink,
  findInterface: LinkInterfaceResolver,
): LinkHistoryDirectionPlan[] {
  const groups = resolveMetricInterfaceGroups(link, findInterface);
  const source = (field: LinkHistoryField, label: string): LinkHistorySource | null =>
    groups.source.length ? { interfaces: groups.source, field, label } : null;
  const target = (field: LinkHistoryField, label: string): LinkHistorySource | null =>
    groups.target.length ? { interfaces: groups.target, field, label } : null;

  const monitored = link.trafficMode === 'SINGLE_ENDED' ? singleEndedMonitoredSide(link) : null;
  if (monitored === 'SOURCE') {
    return [
      { direction: 'A_TO_B', primary: source('tx', 'TX local'), fallback: null },
      { direction: 'B_TO_A', primary: source('rx', 'RX local'), fallback: null },
    ];
  }
  if (monitored === 'TARGET') {
    return [
      { direction: 'A_TO_B', primary: target('rx', 'RX local'), fallback: null },
      { direction: 'B_TO_A', primary: target('tx', 'TX local'), fallback: null },
    ];
  }
  return [
    {
      direction: 'A_TO_B',
      primary: source('tx', 'TX ponta A'),
      fallback: target('rx', 'RX ponta B'),
    },
    {
      direction: 'B_TO_A',
      primary: target('tx', 'TX ponta B'),
      fallback: source('rx', 'RX ponta A'),
    },
  ];
}

function bucketValue(point: MetricPoint, field: LinkHistoryField): number | null {
  const value = field === 'tx' ? point.txBps : point.rxBps;
  return Number.isFinite(value) ? value : null;
}

/**
 * Soma por bucket entre as interfaces da MESMA ponta: bucket sem nenhuma
 * leitura vira `null` (ausencia), nunca zero — o grafico quebra a linha,
 * nao interpola.
 */
function sumSourceSeries(
  source: LinkHistorySource,
  historyFor: (interfaceId: string) => MetricPoint[] | undefined,
): LinkHistoryValuePoint[] {
  const totals = new Map<string, number>();
  const present = new Set<string>();
  for (const networkInterface of source.interfaces) {
    for (const point of historyFor(networkInterface.id) ?? []) {
      const value = bucketValue(point, source.field);
      if (value === null) continue;
      totals.set(point.timestamp, (totals.get(point.timestamp) ?? 0) + value);
      present.add(point.timestamp);
    }
  }
  return [...present]
    .sort((left, right) => left.localeCompare(right))
    .map((timestamp) => ({ timestamp, value: totals.get(timestamp) ?? null }));
}

function hasReading(points: readonly LinkHistoryValuePoint[]): boolean {
  return points.some((point) => point.value !== null);
}

/**
 * Serie de uma direcao. O fallback (RX observado) so entra quando o TX da
 * origem NAO tem NENHUMA leitura na janela inteira — a mesma regra do valor
 * instantaneo. Com TX presente, o RX do destino nunca e somado nem exibido.
 */
export function buildLinkHistorySeries(
  plan: LinkHistoryDirectionPlan,
  historyFor: (interfaceId: string) => MetricPoint[] | undefined,
): LinkHistorySeries {
  const primaryPoints = plan.primary ? sumSourceSeries(plan.primary, historyFor) : [];
  if (plan.primary && hasReading(primaryPoints)) {
    return {
      direction: plan.direction,
      points: primaryPoints,
      used: plan.primary,
      usedFallback: false,
    };
  }
  const fallbackPoints = plan.fallback ? sumSourceSeries(plan.fallback, historyFor) : [];
  if (plan.fallback && hasReading(fallbackPoints)) {
    return {
      direction: plan.direction,
      points: fallbackPoints,
      used: plan.fallback,
      usedFallback: true,
    };
  }
  return { direction: plan.direction, points: primaryPoints, used: null, usedFallback: false };
}

export function seriesStats(points: readonly LinkHistoryValuePoint[]): LinkHistoryStats {
  let total = 0;
  let samples = 0;
  let peak: number | null = null;
  let current: number | null = null;
  for (const point of points) {
    if (point.value === null) continue;
    total += point.value;
    samples += 1;
    current = point.value;
    if (peak === null || point.value > peak) peak = point.value;
  }
  return {
    current,
    average: samples ? total / samples : null,
    peak,
    samples,
  };
}

export function utilizationPercent(value: number | null, capacityBps: number): number | null {
  if (value === null || !Number.isFinite(capacityBps) || capacityBps <= 0) return null;
  return Math.round((value / capacityBps) * 1000) / 10;
}

/**
 * Contadores da MESMA fonte usada pela serie: TX da origem → erros/discards de
 * transmissao; RX observado no destino → erros/discards de recepcao. Nunca os
 * dois lados juntos (o mesmo fluxo), nunca um contador de outra direcao.
 */
export function buildLinkCounterRecords(
  series: readonly LinkHistorySeries[],
  historyFor: (interfaceId: string) => MetricPoint[] | undefined,
): LinkHistoryCounterRecord[] {
  const totals = new Map<string, LinkHistoryCounterRecord>();
  const ensure = (timestamp: string): LinkHistoryCounterRecord => {
    const existing = totals.get(timestamp);
    if (existing) return existing;
    const created: LinkHistoryCounterRecord = {
      timestamp,
      aToBErrors: null,
      bToAErrors: null,
      aToBDiscards: null,
      bToADiscards: null,
    };
    totals.set(timestamp, created);
    return created;
  };
  const add = (timestamp: string, key: keyof Omit<LinkHistoryCounterRecord, 'timestamp'>, value: number | null) => {
    if (value === null) return;
    const record = ensure(timestamp);
    record[key] = (record[key] ?? 0) + value;
  };
  for (const item of series) {
    if (!item.used) continue;
    const errorField = item.used.field === 'tx' ? 'txErrors' : 'rxErrors';
    const discardField = item.used.field === 'tx' ? 'txDiscards' : 'rxDiscards';
    const errorsKey = item.direction === 'A_TO_B' ? 'aToBErrors' : 'bToAErrors';
    const discardsKey = item.direction === 'A_TO_B' ? 'aToBDiscards' : 'bToADiscards';
    for (const networkInterface of item.used.interfaces) {
      for (const point of historyFor(networkInterface.id) ?? []) {
        add(point.timestamp, errorsKey, Number.isFinite(point[errorField]) ? point[errorField] : null);
        add(point.timestamp, discardsKey, Number.isFinite(point[discardField]) ? point[discardField] : null);
      }
    }
  }
  return [...totals.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}
