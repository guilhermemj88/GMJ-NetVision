import { calculateUtilization } from './format';
import type {
  DirectionalLinkMetric,
  LinkAggregationMode,
  LinkMetricSource,
  LinkTrafficConsistency,
  LinkTrafficMode,
  LinkVisualPath,
  NetworkInterface,
  NetworkLink,
} from './types';

export const LINK_TRAFFIC_DIVERGENCE_TOLERANCE_PERCENT = 10;

function availableRate(
  networkInterface: NetworkInterface | undefined,
  field: 'rxBps' | 'txBps',
): number | null {
  if (!networkInterface || networkInterface.telemetryAvailable === false) return null;
  const value = networkInterface[field];
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function trafficConsistency(
  txBps: number | null,
  observedRxBps: number | null,
  tolerancePercent = LINK_TRAFFIC_DIVERGENCE_TOLERANCE_PERCENT,
): Pick<DirectionalLinkMetric, 'deltaPercent' | 'consistency'> {
  if (txBps === null || observedRxBps === null) {
    return { deltaPercent: null, consistency: 'UNKNOWN' };
  }
  const maximum = Math.max(txBps, observedRxBps);
  const deltaPercent = maximum === 0 ? 0 : (Math.abs(txBps - observedRxBps) / maximum) * 100;
  const consistency: LinkTrafficConsistency =
    deltaPercent <= tolerancePercent ? 'CONSISTENT' : 'DIVERGENT';
  return { deltaPercent, consistency };
}

function direction(
  txBps: number | null,
  observedRxBps: number | null,
  capacityBps: number,
): DirectionalLinkMetric {
  // The transmitter is the canonical map-label value. The receiver is retained
  // for validation and is only a compatibility fallback when TX is unavailable.
  const bps = txBps ?? observedRxBps ?? 0;
  return {
    bps,
    utilization: calculateUtilization(bps, capacityBps),
    txBps,
    observedRxBps,
    ...trafficConsistency(txBps, observedRxBps),
  };
}

export function directionalLinkMetrics(
  source: NetworkInterface | undefined,
  target: NetworkInterface | undefined,
  capacityBps: number,
  trafficMode: LinkTrafficMode = 'BIDIRECTIONAL',
): NetworkLink['directions'] {
  if (trafficMode === 'SINGLE_ENDED') {
    if (source && !target) {
      return {
        A_TO_B: direction(availableRate(source, 'txBps'), null, capacityBps),
        B_TO_A: direction(null, availableRate(source, 'rxBps'), capacityBps),
      };
    }
    if (target && !source) {
      return {
        A_TO_B: direction(null, availableRate(target, 'rxBps'), capacityBps),
        B_TO_A: direction(availableRate(target, 'txBps'), null, capacityBps),
      };
    }
  }
  return {
    A_TO_B: direction(availableRate(source, 'txBps'), availableRate(target, 'rxBps'), capacityBps),
    B_TO_A: direction(availableRate(target, 'txBps'), availableRate(source, 'rxBps'), capacityBps),
  };
}

export function linkStatusFromInterfaces(
  source: NetworkInterface | undefined,
  target: NetworkInterface | undefined,
  trafficMode: LinkTrafficMode = 'BIDIRECTIONAL',
): NetworkLink['status'] {
  if (trafficMode === 'SINGLE_ENDED') {
    const monitored = source && !target ? source : target && !source ? target : undefined;
    if (!monitored) return 'UNKNOWN';
    if (monitored.operStatus === 'DOWN' || monitored.operStatus === 'DISABLED') return 'DOWN';
    return monitored.operStatus === 'UP' ? 'UP' : 'UNKNOWN';
  }
  if (!source && !target) return 'UNKNOWN';
  if (
    source?.operStatus === 'DOWN' ||
    source?.operStatus === 'DISABLED' ||
    target?.operStatus === 'DOWN' ||
    target?.operStatus === 'DISABLED'
  )
    return 'DOWN';
  if (source?.operStatus === 'UP' && target?.operStatus === 'UP') return 'UP';
  return 'UNKNOWN';
}

export function automaticLinkCapacity(
  source: NetworkInterface | undefined,
  target: NetworkInterface | undefined,
  trafficMode: LinkTrafficMode,
  fallbackBps: number,
): number {
  const validSpeed = (networkInterface: NetworkInterface | undefined): number | null =>
    networkInterface && Number.isFinite(networkInterface.speedBps) && networkInterface.speedBps > 0
      ? networkInterface.speedBps
      : null;
  const sourceSpeed = validSpeed(source);
  const targetSpeed = validSpeed(target);
  if (trafficMode === 'SINGLE_ENDED') return Math.max(1, sourceSpeed ?? targetSpeed ?? fallbackBps);
  if (sourceSpeed !== null && targetSpeed !== null)
    return Math.max(1, Math.min(sourceSpeed, targetSpeed));
  return Math.max(1, fallbackBps);
}

export function defaultVisualPath(order = 0): LinkVisualPath {
  return { order, label: null, customColor: null, curvature: 0, enabled: true };
}

export function defaultVisualPaths(count = 1): LinkVisualPath[] {
  return Array.from({ length: Math.max(1, Math.trunc(count)) }, (_, index) =>
    defaultVisualPath(index),
  );
}

export function autoCurvatures(count: number): number[] {
  const total = Math.max(1, Math.trunc(count));
  if (total === 1) return [0];
  if (total === 2) return [-20, 20];
  const spacing = 30;
  return Array.from({ length: total }, (_, index) => (index - (total - 1) / 2) * spacing);
}

function sumRate(interfaces: NetworkInterface[], field: 'rxBps' | 'txBps'): number | null {
  let total = 0;
  let found = false;
  for (const networkInterface of interfaces) {
    const value = availableRate(networkInterface, field);
    if (value !== null) {
      total += value;
      found = true;
    }
  }
  return found ? total : null;
}

function sumCounter(
  interfaces: NetworkInterface[],
  field: 'rxErrors' | 'txErrors' | 'rxDiscards' | 'txDiscards',
): number {
  return interfaces.reduce(
    (total, networkInterface) =>
      total + (Number.isFinite(networkInterface[field]) ? networkInterface[field] : 0),
    0,
  );
}

export function aggregatedDirections(
  source: NetworkInterface[],
  target: NetworkInterface[],
  capacityBps: number,
  trafficMode: LinkTrafficMode = 'BIDIRECTIONAL',
): NetworkLink['directions'] {
  if (trafficMode === 'SINGLE_ENDED') {
    if (source.length && !target.length) {
      return {
        A_TO_B: direction(sumRate(source, 'txBps'), null, capacityBps),
        B_TO_A: direction(null, sumRate(source, 'rxBps'), capacityBps),
      };
    }
    if (target.length && !source.length) {
      return {
        A_TO_B: direction(null, sumRate(target, 'rxBps'), capacityBps),
        B_TO_A: direction(sumRate(target, 'txBps'), null, capacityBps),
      };
    }
  }
  return {
    A_TO_B: direction(sumRate(source, 'txBps'), sumRate(target, 'rxBps'), capacityBps),
    B_TO_A: direction(sumRate(target, 'txBps'), sumRate(source, 'rxBps'), capacityBps),
  };
}

function hasDown(interfaces: NetworkInterface[]): boolean {
  return interfaces.some(
    (networkInterface) =>
      networkInterface.operStatus === 'DOWN' || networkInterface.operStatus === 'DISABLED',
  );
}

function hasUp(interfaces: NetworkInterface[]): boolean {
  return interfaces.some((networkInterface) => networkInterface.operStatus === 'UP');
}

export function linkStatusFromInterfaceGroups(
  source: NetworkInterface[],
  target: NetworkInterface[],
  trafficMode: LinkTrafficMode = 'BIDIRECTIONAL',
): NetworkLink['status'] {
  if (trafficMode === 'SINGLE_ENDED') {
    const monitored =
      source.length && !target.length ? source : target.length && !source.length ? target : [];
    if (!monitored.length) return 'UNKNOWN';
    if (hasDown(monitored)) return 'DOWN';
    return hasUp(monitored) ? 'UP' : 'UNKNOWN';
  }
  if (!source.length && !target.length) return 'UNKNOWN';
  if (hasDown(source) || hasDown(target)) return 'DOWN';
  if (source.length && target.length) return hasUp(source) && hasUp(target) ? 'UP' : 'UNKNOWN';
  return hasUp(source.length ? source : target) ? 'UP' : 'UNKNOWN';
}

export type LinkInterfaceResolver = (
  deviceId: string | null | undefined,
  interfaceId: string | null | undefined,
) => NetworkInterface | undefined;

export function resolveMetricInterfaceGroups(
  link: {
    sourceDeviceId: string | null;
    targetDeviceId: string | null;
    sourceInterfaceId: string | null;
    targetInterfaceId: string | null;
    aggregationMode: LinkAggregationMode;
    metricSources: LinkMetricSource[];
  },
  findInterface: LinkInterfaceResolver,
): { source: NetworkInterface[]; target: NetworkInterface[] } {
  const referenceSource = findInterface(link.sourceDeviceId, link.sourceInterfaceId);
  const referenceTarget = findInterface(link.targetDeviceId, link.targetInterfaceId);

  if (link.aggregationMode === 'SUM' && link.metricSources.length > 0) {
    const source = link.metricSources
      .filter((entry) => entry.side === 'SOURCE')
      .map((entry) => findInterface(link.sourceDeviceId, entry.interfaceId))
      .filter((item): item is NetworkInterface => Boolean(item));
    const target = link.metricSources
      .filter((entry) => entry.side === 'TARGET')
      .map((entry) => findInterface(link.targetDeviceId, entry.interfaceId))
      .filter((item): item is NetworkInterface => Boolean(item));
    return {
      source: source.length ? source : referenceSource ? [referenceSource] : [],
      target: target.length ? target : referenceTarget ? [referenceTarget] : [],
    };
  }
  return {
    source: referenceSource ? [referenceSource] : [],
    target: referenceTarget ? [referenceTarget] : [],
  };
}

export function aggregateLinkMetrics(
  link: {
    sourceDeviceId: string | null;
    targetDeviceId: string | null;
    sourceInterfaceId: string | null;
    targetInterfaceId: string | null;
    aggregationMode: LinkAggregationMode;
    metricSources: LinkMetricSource[];
    trafficMode: LinkTrafficMode;
    capacityBps: number;
  },
  findInterface: LinkInterfaceResolver,
): {
  directions: NetworkLink['directions'];
  status: NetworkLink['status'];
  rxBps: number;
  txBps: number;
  rxUtilization: number;
  txUtilization: number;
  rxErrors: number;
  txErrors: number;
  rxDiscards: number;
  txDiscards: number;
} {
  const { source, target } = resolveMetricInterfaceGroups(link, findInterface);
  const directions = aggregatedDirections(source, target, link.capacityBps, link.trafficMode);
  const status = linkStatusFromInterfaceGroups(source, target, link.trafficMode);
  const aToB = directions.A_TO_B.bps;
  const bToA = directions.B_TO_A.bps;

  if (link.aggregationMode === 'SUM') {
    const all = [...source, ...target];
    const singleEnded = link.trafficMode === 'SINGLE_ENDED';
    const monitored =
      singleEnded
        ? source.length && !target.length
          ? source
          : target.length && !source.length
            ? target
            : []
        : [];
    const rxBps = monitored.length ? (sumRate(monitored, 'rxBps') ?? 0) : bToA;
    const txBps = monitored.length ? (sumRate(monitored, 'txBps') ?? 0) : aToB;
    return {
      directions,
      status,
      rxBps,
      txBps,
      rxUtilization: calculateUtilization(rxBps, link.capacityBps),
      txUtilization: calculateUtilization(txBps, link.capacityBps),
      rxErrors: sumCounter(all, 'rxErrors'),
      txErrors: sumCounter(all, 'txErrors'),
      rxDiscards: sumCounter(all, 'rxDiscards'),
      txDiscards: sumCounter(all, 'txDiscards'),
    };
  }

  const monitoredIf =
    link.trafficMode === 'SINGLE_ENDED'
      ? source.length && !target.length
        ? source[0]
        : target.length && !source.length
          ? target[0]
          : undefined
      : undefined;
  const rxBps = monitoredIf?.rxBps ?? bToA;
  const txBps = monitoredIf?.txBps ?? aToB;
  return {
    directions,
    status,
    rxBps,
    txBps,
    rxUtilization: calculateUtilization(rxBps, link.capacityBps),
    txUtilization: calculateUtilization(txBps, link.capacityBps),
    rxErrors: monitoredIf?.rxErrors ?? source[0]?.rxErrors ?? target[0]?.txErrors ?? 0,
    txErrors: monitoredIf?.txErrors ?? source[0]?.txErrors ?? target[0]?.rxErrors ?? 0,
    rxDiscards: monitoredIf?.rxDiscards ?? source[0]?.rxDiscards ?? target[0]?.txDiscards ?? 0,
    txDiscards: monitoredIf?.txDiscards ?? source[0]?.txDiscards ?? target[0]?.rxDiscards ?? 0,
  };
}
