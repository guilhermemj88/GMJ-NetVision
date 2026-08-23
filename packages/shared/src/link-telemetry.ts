import { calculateUtilization } from './format';
import type {
  DirectionalLinkMetric,
  LinkTrafficConsistency,
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
  const consistency: LinkTrafficConsistency = deltaPercent <= tolerancePercent
    ? 'CONSISTENT'
    : 'DIVERGENT';
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
): NetworkLink['directions'] {
  return {
    A_TO_B: direction(
      availableRate(source, 'txBps'),
      availableRate(target, 'rxBps'),
      capacityBps,
    ),
    B_TO_A: direction(
      availableRate(target, 'txBps'),
      availableRate(source, 'rxBps'),
      capacityBps,
    ),
  };
}

export function linkStatusFromInterfaces(
  source: NetworkInterface | undefined,
  target: NetworkInterface | undefined,
): NetworkLink['status'] {
  if (!source && !target) return 'UNKNOWN';
  if (
    source?.operStatus === 'DOWN'
    || source?.operStatus === 'DISABLED'
    || target?.operStatus === 'DOWN'
    || target?.operStatus === 'DISABLED'
  ) return 'DOWN';
  if (source?.operStatus === 'UP' && target?.operStatus === 'UP') return 'UP';
  return 'UNKNOWN';
}
