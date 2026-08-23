import { historyBucketMilliseconds } from './history';
import type {
  HistoryPeriod,
  InterfaceOpticalSample,
  NetworkInterface,
  OpticalHistoryPoint,
  OpticalLaneHistoryPoint,
  OpticalLaneReading,
} from './types';

type StatsAccumulator = { count: number; sum: number; min: number; max: number };

function validNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function addValue(current: StatsAccumulator, value: number | null | undefined): void {
  if (!validNumber(value)) return;
  current.count += 1;
  current.sum += value;
  current.min = Math.min(current.min, value);
  current.max = Math.max(current.max, value);
}

function stats(current: StatsAccumulator): { avg: number | null; min: number | null; max: number | null } {
  return current.count
    ? { avg: current.sum / current.count, min: current.min, max: current.max }
    : { avg: null, min: null, max: null };
}

function emptyStats(): StatsAccumulator {
  return { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY };
}

function hasUsefulLane(lane: OpticalLaneReading): boolean {
  return validNumber(lane.rxPowerDbm)
    || validNumber(lane.txPowerDbm)
    || validNumber(lane.biasCurrentMa);
}

export function hasUsefulOpticalSample(sample: InterfaceOpticalSample): boolean {
  return validNumber(sample.rxPowerDbm)
    || validNumber(sample.txPowerDbm)
    || sample.opticalLanes.some(hasUsefulLane);
}

function isFresh(value: string | null | undefined, collectedAfter?: Date): boolean {
  if (!collectedAfter) return true;
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= collectedAfter.getTime();
}

/** Builds the single final sample for one interface collection. */
export function opticalSampleFromInterface(
  networkInterface: NetworkInterface,
  timestamp: Date,
  collectedAfter?: Date,
): InterfaceOpticalSample | null {
  const scalarFresh = isFresh(networkInterface.opticalUpdatedAt, collectedAfter);
  const lanesFresh = isFresh(networkInterface.opticalLanesUpdatedAt, collectedAfter);
  const sample: InterfaceOpticalSample = {
    timestamp: timestamp.toISOString(),
    rxPowerDbm: scalarFresh && validNumber(networkInterface.rxPowerDbm)
      ? networkInterface.rxPowerDbm
      : null,
    txPowerDbm: scalarFresh && validNumber(networkInterface.txPowerDbm)
      ? networkInterface.txPowerDbm
      : null,
    opticalLanes: lanesFresh
      ? (networkInterface.opticalLanes ?? []).filter(hasUsefulLane)
      : [],
  };
  return hasUsefulOpticalSample(sample) ? sample : null;
}

type LaneBucket = {
  sampleCount: number;
  rx: StatsAccumulator;
  tx: StatsAccumulator;
};

type OpticalBucket = {
  timestamp: number;
  sampleCount: number;
  rx: StatsAccumulator;
  tx: StatsAccumulator;
  lanes: Map<number, LaneBucket>;
};

function laneHistory(lane: number, bucket: LaneBucket): OpticalLaneHistoryPoint {
  const rx = stats(bucket.rx);
  const tx = stats(bucket.tx);
  return {
    lane,
    sampleCount: bucket.sampleCount,
    rxAvg: rx.avg,
    rxMin: rx.min,
    rxMax: rx.max,
    txAvg: tx.avg,
    txMin: tx.min,
    txMax: tx.max,
  };
}

export function aggregateOpticalHistory(
  samples: InterfaceOpticalSample[],
  period: HistoryPeriod,
): OpticalHistoryPoint[] {
  const bucketMilliseconds = historyBucketMilliseconds(period);
  const buckets = new Map<number, OpticalBucket>();
  const ordered = samples
    .filter(hasUsefulOpticalSample)
    .map((sample) => ({ sample, timestamp: Date.parse(sample.timestamp) }))
    .filter((item) => Number.isFinite(item.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp);

  for (const { sample, timestamp: sampleTimestamp } of ordered) {
    const timestamp = bucketMilliseconds === null
      ? sampleTimestamp
      : Math.floor(sampleTimestamp / bucketMilliseconds) * bucketMilliseconds;
    const bucket = buckets.get(timestamp) ?? {
      timestamp,
      sampleCount: 0,
      rx: emptyStats(),
      tx: emptyStats(),
      lanes: new Map<number, LaneBucket>(),
    };
    bucket.sampleCount += 1;
    addValue(bucket.rx, sample.rxPowerDbm);
    addValue(bucket.tx, sample.txPowerDbm);

    for (const lane of sample.opticalLanes) {
      if (!hasUsefulLane(lane)) continue;
      const laneBucket = bucket.lanes.get(lane.lane) ?? {
        sampleCount: 0,
        rx: emptyStats(),
        tx: emptyStats(),
      };
      laneBucket.sampleCount += 1;
      addValue(laneBucket.rx, lane.rxPowerDbm);
      addValue(laneBucket.tx, lane.txPowerDbm);
      bucket.lanes.set(lane.lane, laneBucket);
    }
    buckets.set(timestamp, bucket);
  }

  return [...buckets.values()].map((bucket) => {
    const rx = stats(bucket.rx);
    const tx = stats(bucket.tx);
    return {
      timestamp: new Date(bucket.timestamp).toISOString(),
      sampleCount: bucket.sampleCount,
      rxAvg: rx.avg,
      rxMin: rx.min,
      rxMax: rx.max,
      txAvg: tx.avg,
      txMin: tx.min,
      txMax: tx.max,
      lanes: [...bucket.lanes.entries()]
        .sort(([left], [right]) => left - right)
        .map(([lane, laneBucket]) => laneHistory(lane, laneBucket)),
    };
  });
}
