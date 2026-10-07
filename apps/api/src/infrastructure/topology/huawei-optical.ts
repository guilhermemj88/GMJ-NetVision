import type { OpticalLaneReading, OpticalThresholdSource, OpticalThresholdsV1 } from '@gmj/shared';
import { decodeSnmpText } from '../snmp/snmp-text';
import { microWattsToDbm, normalizeOpticalDbm } from './optical-power';

/**
 * HUAWEI-ENTITY-EXTENT-MIB (hwEntityStateExtTable), tudo indexado por
 * entPhysicalIndex e correlacionado por entPhysicalName:
 *
 * - .8/.9: potencia SCALAR RX/TX em valor RAW — a unidade depende da familia
 *   (uW no VRP classico do S6730/NE8000; centi-dBm no YunShan do S6750-H), por
 *   isso o decode vem do profile e nunca de heuristicas;
 * - .13-.16: thresholds de alarme do transceiver em CENTI-dBm nas duas familias
 *   comprovadas (raw / 100);
 * - .31/.32/.33: bias/RX/TX por lane em CSV, valores JA em dBm.
 */
export const HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS = {
  rxPowerRaw: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.8',
  txPowerRaw: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.9',
  rxLowAlarmCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.13',
  rxHighAlarmCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.14',
  txLowAlarmCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.15',
  txHighAlarmCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.16',
  biasCurrentByLane: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.31',
  rxPowerByLane: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.32',
  txPowerByLane: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.33',
} as const;

/**
 * Encoding do campo RAW .8/.9. E propriedade do PROFILE (modelo/sysDescr/OS) e
 * nunca do sinal do valor: heuristica por "negativo ou positivo" e proibida.
 */
export type HuaweiOpticalScalarEncoding = 'MICRO_WATTS' | 'CENTI_DBM' | 'UNKNOWN';

/**
 * Sentinelas conhecidos de "unsupported" nos OIDs de threshold. `-1` NAO pode
 * virar -0.01 dBm: e descartado antes de virar threshold real.
 */
const UNSUPPORTED_THRESHOLD_RAW = new Set([-1]);

function rawNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = value instanceof Uint8Array ? decodeSnmpText(value) : String(value);
  if (!text.trim()) return null;
  const parsed = Number(text.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** RAW em centi-dBm (raw / 100) com validacao de faixa optica. */
export function centiDbmToDbm(value: unknown): number | null {
  const raw = rawNumber(value);
  return raw === null ? null : normalizeOpticalDbm(raw / 100);
}

/**
 * Threshold de alarme do transceiver (raw em centi-dBm). Valor sentinela,
 * nao numerico ou fora da faixa optica retorna null: nunca inventa limite.
 */
export function decodeHuaweiThresholdDbm(value: unknown): number | null {
  const raw = rawNumber(value);
  if (raw === null || UNSUPPORTED_THRESHOLD_RAW.has(raw)) return null;
  return normalizeOpticalDbm(raw / 100);
}

/** Potencia scalar RX/TX conforme o encoding do profile (UNKNOWN = nao adivinha). */
export function decodeHuaweiScalarPowerDbm(
  value: unknown,
  encoding: HuaweiOpticalScalarEncoding,
): number | null {
  if (encoding === 'MICRO_WATTS') return microWattsToDbm(value);
  if (encoding === 'CENTI_DBM') return centiDbmToDbm(value);
  return null;
}

/** Par low/high de um lado (RX/TX) lido do SNMP, sempre com origem DEVICE. */
export interface HuaweiThresholdValues {
  low: number | null;
  high: number | null;
}

/**
 * Constroi o JSON canonico a partir dos OIDs .13-.16. Ausencia parcial e
 * permitida; par incoerente (low >= high) e descartado inteiro, sem inventar
 * um dos lados. Retorna null quando nenhum lado valido existe.
 */
export function buildHuaweiDeviceThresholds(input: {
  rx: HuaweiThresholdValues;
  tx: HuaweiThresholdValues;
}): OpticalThresholdsV1 | null {
  const source: OpticalThresholdSource = 'DEVICE';
  const side = (values: HuaweiThresholdValues) => {
    const coherent = values.low === null
      || values.high === null
      || values.low < values.high;
    const low = coherent ? values.low : null;
    const high = coherent ? values.high : null;
    return {
      lowAlarmDbm: low,
      highAlarmDbm: high,
      lowSource: low === null ? null : source,
      highSource: high === null ? null : source,
    };
  };
  const rx = side(input.rx);
  const tx = side(input.tx);
  if (rx.lowAlarmDbm === null && rx.highAlarmDbm === null && tx.lowAlarmDbm === null && tx.highAlarmDbm === null) {
    return null;
  }
  return { version: 1, scalar: { rx, tx }, lanes: [] };
}

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
