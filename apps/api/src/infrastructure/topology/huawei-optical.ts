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
 * - .31/.32/.33: bias/RX/TX por lane em CSV. Bias e sempre mA; a potencia RX/TX
 *   vem em dBm ou centi-dBm conforme o `opticalLaneEncoding` do profile (o S6750
 *   entrega dBm cru e o S6730 entrega centi-dBm), nunca por heuristica.
 */
export const HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS = {
  rxPowerRaw: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.8',
  txPowerRaw: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.9',
  rxLowAlarmCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.13',
  rxHighAlarmCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.14',
  txLowAlarmCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.15',
  txHighAlarmCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.16',
  // WARNING (degradacao antecipada) em CENTI-dBm, PAR SEPARADO do ALARM. O VRP
  // classico (S6730/NE8000) publica; o YunShan (S6750) nao existe a coluna â€”
  // ausencia legitima, nunca copiada do ALARM.
  rxLowWarningCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.20',
  rxHighWarningCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.21',
  txLowWarningCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.22',
  txHighWarningCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.23',
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
 * Encoding dos WARNING (.20-.23). Propriedade do PROFILE, nunca do valor:
 * - `CENTI_DBM` quando a familia publica a coluna (VRP classico/YunShan);
 * - `ABSENT` quando a familia NAO tem a coluna (YunShan/S6750): nem sequer
 *   varremos os OIDs, para nao gravar nada e nao gastar SNMP.
 */
export type HuaweiOpticalWarningEncoding = 'CENTI_DBM' | 'ABSENT';

/**
 * Encoding das colunas CSV .32 (RX) / .33 (TX) POR LANE. Tambem e propriedade
 * do PROFILE, nunca do tamanho do numero:
 *
 * - S6750 (YunShan): `DBM` — o CSV ja vem em dBm (`0.19,0.69,1.02,0.11`);
 * - S6730 (VRP classico): `CENTI_DBM` — o CSV vem em centi-dBm e o valor cru
 *   (`-1372.63`) estoura a faixa optica se lido como dBm (evidencia real:
 *   67502222 / 100GE0/0/2);
 * - `UNKNOWN`: nao decodifica potencia de lane (bias segue normal).
 */
export type HuaweiOpticalLaneEncoding = 'DBM' | 'CENTI_DBM' | 'UNKNOWN';

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

/**
 * Potencia de UMA lane (.32/.33) conforme o encoding do profile. O valor cru
 * passa primeiro por `rawNumber` (CSV e sempre texto) e depois pela validacao
 * fisica normal; `UNKNOWN` devolve null em vez de arriscar uma unidade errada.
 */
export function decodeHuaweiLanePowerDbm(
  value: unknown,
  encoding: HuaweiOpticalLaneEncoding,
): number | null {
  if (encoding === 'UNKNOWN') return null;
  const raw = rawNumber(value);
  if (raw === null) return null;
  return encoding === 'CENTI_DBM' ? normalizeOpticalDbm(raw / 100) : normalizeOpticalDbm(raw);
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
  /** Par WARNING do RX (.20/.21); ausente/null = familia sem WARNING. */
  rxWarning?: HuaweiThresholdValues | undefined;
  /** Par WARNING do TX (.22/.23); ausente/null = familia sem WARNING. */
  txWarning?: HuaweiThresholdValues | undefined;
}): OpticalThresholdsV1 | null {
  const source: OpticalThresholdSource = 'DEVICE';
  const coherentPair = (values: HuaweiThresholdValues): { low: number | null; high: number | null } => {
    const coherent = values.low === null || values.high === null || values.low < values.high;
    return { low: coherent ? values.low : null, high: coherent ? values.high : null };
  };
  const side = (
    values: HuaweiThresholdValues,
    warning: HuaweiThresholdValues | undefined,
  ) => {
    const pair = coherentPair(values);
    const warningPair = warning ? coherentPair(warning) : { low: null, high: null };
    // WARNING incoerente com o ALARM (fora da janela hard) e descartado inteiro,
    // do mesmo jeito que o par low >= high â€” nunca se inventa um lado.
    const lowOrdered = pair.low === null || warningPair.low === null || warningPair.low >= pair.low;
    const highOrdered = pair.high === null || warningPair.high === null || warningPair.high <= pair.high;
    const lowWarning = lowOrdered ? warningPair.low : null;
    const highWarning = highOrdered ? warningPair.high : null;
    const hasWarning = lowWarning !== null || highWarning !== null;
    return {
      lowAlarmDbm: pair.low,
      highAlarmDbm: pair.high,
      // Sem WARNING publicado nao se inventa chave: o JSON fica identico ao da
      // fase anterior (YunShan nao publica .20-.23).
      ...(hasWarning ? { lowWarningDbm: lowWarning, highWarningDbm: highWarning } : {}),
      lowSource: pair.low === null && lowWarning === null ? null : source,
      highSource: pair.high === null && highWarning === null ? null : source,
    };
  };
  const rx = side(input.rx, input.rxWarning);
  const tx = side(input.tx, input.txWarning);
  const empty = (values: ReturnType<typeof side>) =>
    values.lowAlarmDbm === null
    && values.highAlarmDbm === null
    && (values.lowWarningDbm ?? null) === null
    && (values.highWarningDbm ?? null) === null;
  if (empty(rx) && empty(tx)) return null;
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

/** Converts the three Huawei CSV columns into independent, sparse lane readings. */
export function parseHuaweiOpticalLaneCsv(
  rxCsv: unknown,
  txCsv: unknown,
  biasCsv: unknown,
  laneEncoding: HuaweiOpticalLaneEncoding,
): OpticalLaneReading[] {
  const rxValues = csvValues(rxCsv);
  const txValues = csvValues(txCsv);
  const biasValues = csvValues(biasCsv);
  const laneCount = Math.max(rxValues.length, txValues.length, biasValues.length);
  const lanes: OpticalLaneReading[] = [];

  for (let lane = 0; lane < laneCount; lane += 1) {
    const rxPowerDbm = decodeHuaweiLanePowerDbm(rxValues[lane], laneEncoding);
    const txPowerDbm = decodeHuaweiLanePowerDbm(txValues[lane], laneEncoding);
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
