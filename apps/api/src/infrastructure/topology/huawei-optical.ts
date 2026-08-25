import type { OpticalLaneReading } from '@gmj/shared';
import { decodeSnmpText } from '../snmp/snmp-text';
import { normalizeOpticalDbm } from './optical-power';

export const HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS = {
  rxPowerUw: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.8',
  txPowerUw: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.9',
  biasCurrentByLane: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.31',
  rxPowerByLane: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.32',
  txPowerByLane: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.33',
} as const;

function csvValues(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const text = value instanceof Uint8Array ? decodeSnmpText(value) : String(value);
  if (!text.trim()) return [];
  return text.split(',').map((item) => item.trim());
}

const MAX_PLAUSIBLE_OPTICAL_BIAS_MA = 1_000;

export function normalizeHuaweiBiasCurrentMa(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = value instanceof Uint8Array ? decodeSnmpText(value) : String(value);
  if (!text.trim()) return null;
  const parsed = Number(text.trim());
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_PLAUSIBLE_OPTICAL_BIAS_MA
    ? parsed
    : null;
}

function opticalDbm(value: string | undefined): number | null {
  return value ? normalizeOpticalDbm(value) : null;
}

/** Converts the three Huawei CSV columns into independent, sparse lane readings. */
export function parseHuaweiOpticalLaneCsv(
  rxCsv: unknown,
  txCsv: unknown,
  biasCsv: unknown,
): OpticalLaneReading[] {
  const rxValues = csvValues(rxCsv);
  const txValues = csvValues(txCsv);
  const biasValues = csvValues(biasCsv);
  const laneCount = Math.max(rxValues.length, txValues.length, biasValues.length);
  const lanes: OpticalLaneReading[] = [];

  for (let lane = 0; lane < laneCount; lane += 1) {
    const rxPowerDbm = opticalDbm(rxValues[lane]);
    const txPowerDbm = opticalDbm(txValues[lane]);
    const biasCurrentMa = normalizeHuaweiBiasCurrentMa(biasValues[lane]);
    if (rxPowerDbm === null && txPowerDbm === null && biasCurrentMa === null) continue;
    lanes.push({
      lane,
      rxPowerDbm,
      txPowerDbm,
      ...(biasCurrentMa === null ? {} : { biasCurrentMa }),
    });
  }

  return lanes;
}

export function usefulOpticalLaneCount(lanes: OpticalLaneReading[] | null | undefined): number {
  return (lanes ?? []).filter((lane) =>
    Number.isFinite(lane.rxPowerDbm)
    || Number.isFinite(lane.txPowerDbm)
    || Number.isFinite(lane.biasCurrentMa)
  ).length;
}

export function hasHuaweiMultiLaneCapability(
  lanes: OpticalLaneReading[] | null | undefined,
): boolean {
  return usefulOpticalLaneCount(lanes) >= 2;
}
