import type { OpticalLaneReading, OpticalThresholdSource, OpticalThresholdsV1 } from '@gmj/shared';
import { decodeSnmpText } from '../snmp/snmp-text';
import { SNMP_OPTICAL_DBM_DECIMALS, microWattsToDbm, normalizeOpticalDbm } from './optical-power';

/**
 * HUAWEI-ENTITY-EXTENT-MIB (hwEntityStateExtTable), tudo indexado por
 * entPhysicalIndex e correlacionado por entPhysicalName. A UNIDADE de cada
 * coluna muda por plataforma (matriz modelo x versao x capability de
 * 2026-10-09), por isso TODO decode vem do profile e nunca de heuristica por
 * magnitude/sinal:
 *
 * - .8/.9: potencia SCALAR RX/TX. uW (S6730/VRP5), centi-dBm (F1A/VRP8 e
 *   S6750/YunShan). A SEMANTICA tambem muda: no F1A e a potencia AGREGADA das
 *   lanes (soma em mW); no S6730/S6750 e a lane 0;
 * - .13-.16: thresholds de ALARME do transceiver (centi-dBm nas 3 familias);
 * - .20-.23: thresholds de WARNING (F1A e S6730); o S6750 nao publica;
 * - .31: bias por lane em CSV decimal de mA (o F1A nao implementa);
 * - .32/.33: potencia por lane em CSV — inteiro centi-dBm (F1A), decimal
 *   centi-dBm (S6730) ou decimal dBm (S6750);
 * - .38-.41: max/min das lanes (so F1A; centi-dBm).
 */
export const HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS = {
  rxPowerRaw: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.8',
  txPowerRaw: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.9',
  rxLowAlarmCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.13',
  rxHighAlarmCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.14',
  txLowAlarmCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.15',
  txHighAlarmCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.16',
  rxLowWarningCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.20',
  rxHighWarningCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.21',
  txLowWarningCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.22',
  txHighWarningCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.23',
  biasCurrentByLane: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.31',
  rxPowerByLane: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.32',
  txPowerByLane: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.33',
  maxRxPowerCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.38',
  minRxPowerCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.39',
  maxTxPowerCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.40',
  minTxPowerCentiDbm: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.41',
} as const;

/** Testemunha da MIB na mesma subarvore (capability probe). */
export const HUAWEI_ENTITY_STATE_WITNESS_OID = '1.3.6.1.4.1.2011.5.25.31.1.1.1.1.1';

/** Encoding do campo RAW .8/.9. Propriedade do PROFILE, nunca do valor. */
export type HuaweiOpticalScalarEncoding = 'MICRO_WATTS' | 'CENTI_DBM' | 'DBM' | 'UNSUPPORTED';

/**
 * O que o scalar .8/.9 REPRESENTA quando o modulo tem varias lanes:
 * `AGGREGATED_LANES` (F1A/VRP8: soma em mW de todas as lanes) ou `LANE_0`
 * (S6730/S6750: apenas a primeira lane). Nunca inferir pelo valor.
 */
export type HuaweiOpticalScalarSemantics = 'LANE_0' | 'AGGREGATED_LANES' | 'UNKNOWN';

/** Encoding do CSV de potencia das lanes (.32/.33). */
export type HuaweiOpticalLaneEncoding =
  | 'INT_CENTI_DBM'
  | 'DECIMAL_CENTI_DBM'
  | 'DECIMAL_DBM'
  | 'UNSUPPORTED';

/** Encoding do bias por lane (.31). */
export type HuaweiOpticalLaneBiasEncoding = 'DECIMAL_MA' | 'MICRO_AMPS' | 'UNSUPPORTED';

/** Encoding de uma coluna de threshold/min-max (alarme, warning, min/max). */
export type HuaweiOpticalThresholdEncoding = 'CENTI_DBM' | 'DBM' | 'UNSUPPORTED';

/**
 * Capability optica declarativa por familia/OS. `capabilities` e DERIVADA dos
 * encodings por `huaweiOpticalCapability()` para nunca sair de sincronia.
 */
export interface HuaweiOpticalCapability {
  scalarEncoding: HuaweiOpticalScalarEncoding;
  scalarSemantics: HuaweiOpticalScalarSemantics;
  laneEncoding: HuaweiOpticalLaneEncoding;
  laneBiasEncoding: HuaweiOpticalLaneBiasEncoding;
  alarmThresholdEncoding: HuaweiOpticalThresholdEncoding;
  warningThresholdEncoding: HuaweiOpticalThresholdEncoding;
  minMaxEncoding: HuaweiOpticalThresholdEncoding;
  capabilities: {
    table: boolean;
    scalarPower: boolean;
    alarmThresholds: boolean;
    laneBias: boolean;
    lanes: boolean;
    warnings: boolean;
    minMax: boolean;
  };
}

/** Monta a capability derivando `capabilities` dos encodings (fonte unica). */
export function huaweiOpticalCapability(
  input: Omit<HuaweiOpticalCapability, 'capabilities'>,
): HuaweiOpticalCapability {
  return {
    ...input,
    capabilities: {
      table: input.scalarEncoding !== 'UNSUPPORTED'
        || input.laneEncoding !== 'UNSUPPORTED'
        || input.laneBiasEncoding !== 'UNSUPPORTED',
      scalarPower: input.scalarEncoding !== 'UNSUPPORTED',
      alarmThresholds: input.alarmThresholdEncoding !== 'UNSUPPORTED',
      laneBias: input.laneBiasEncoding !== 'UNSUPPORTED',
      lanes: input.laneEncoding !== 'UNSUPPORTED',
      warnings: input.warningThresholdEncoding !== 'UNSUPPORTED',
      minMax: input.minMaxEncoding !== 'UNSUPPORTED',
    },
  };
}

/** Plataforma sem leitura optica via HUAWEI-ENTITY-EXTENT (ex.: MA5800). */
export const UNSUPPORTED_HUAWEI_OPTICAL_CAPABILITY: HuaweiOpticalCapability =
  huaweiOpticalCapability({
    scalarEncoding: 'UNSUPPORTED',
    scalarSemantics: 'UNKNOWN',
    laneEncoding: 'UNSUPPORTED',
    laneBiasEncoding: 'UNSUPPORTED',
    alarmThresholdEncoding: 'UNSUPPORTED',
    warningThresholdEncoding: 'UNSUPPORTED',
    minMaxEncoding: 'UNSUPPORTED',
  });

/**
 * Sentinela crua de coluna de threshold/min-max: `-1` e `-255` aparecem em
 * portas SEM modulo e nao sao limites reais (`-2.55 dBm` de alarme seria
 * absurdo). Nao vale para potencia: ali `-40 dBm` continua sendo leitura real.
 */
const CENTI_DBM_THRESHOLD_SENTINELS = new Set([-1, -255]);

const MAX_PLAUSIBLE_OPTICAL_BIAS_MA = 1_000;
const DBM_DECIMALS = SNMP_OPTICAL_DBM_DECIMALS;

function rawNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = value instanceof Uint8Array ? decodeSnmpText(value) : String(value);
  if (!text.trim()) return null;
  const parsed = Number(text.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Potencia SCALAR RX/TX (.8/.9) conforme o encoding do profile.
 * `MICRO_WATTS`: uW -> dBm (0/negativo nao e leitura; conversao transcendente
 * arredondada como todo o caminho em dBm do produto);
 * `CENTI_DBM`/`DBM`: valor cru com o decode ANTES da validacao de faixa,
 * preservando a resolucao do vendor;
 * `UNSUPPORTED`: nunca decodifica (nao adivinha unidade).
 */
export function decodeOpticalScalarDbm(
  value: unknown,
  encoding: HuaweiOpticalScalarEncoding,
): number | null {
  if (encoding === 'UNSUPPORTED') return null;
  if (encoding === 'MICRO_WATTS') return microWattsToDbm(value);
  const raw = rawNumber(value);
  if (raw === null) return null;
  return normalizeOpticalDbm(encoding === 'CENTI_DBM' ? raw / 100 : raw, DBM_DECIMALS);
}

/**
 * Potencia de UMA lane (.32/.33). O CSV chega como texto; o decode vem ANTES
 * de qualquer validacao de faixa (`-1372.63` centi-dBm = `-13.7263` dBm e um
 * valor legitimo que seria descartado se lido como dBm cru).
 */
export function decodeOpticalLaneDbm(
  value: unknown,
  encoding: HuaweiOpticalLaneEncoding,
): number | null {
  const raw = rawNumber(value);
  if (raw === null || encoding === 'UNSUPPORTED') return null;
  if (encoding === 'DECIMAL_DBM') return normalizeOpticalDbm(raw, DBM_DECIMALS);
  return normalizeOpticalDbm(raw / 100, DBM_DECIMALS);
}

/**
 * Threshold (.13-.16 / .20-.23) conforme o encoding declarado no profile.
 * Sentinela e valor fora da faixa optica viram null: nunca inventa limite.
 */
export function decodeOpticalThresholdDbm(
  value: unknown,
  encoding: HuaweiOpticalThresholdEncoding,
): number | null {
  if (encoding === 'UNSUPPORTED') return null;
  const raw = rawNumber(value);
  if (raw === null) return null;
  if (encoding === 'CENTI_DBM') {
    if (CENTI_DBM_THRESHOLD_SENTINELS.has(raw)) return null;
    return normalizeOpticalDbm(raw / 100, DBM_DECIMALS);
  }
  return normalizeOpticalDbm(raw, DBM_DECIMALS);
}

/** Max/min das lanes (.38-.41): mesma regra e sentinelas dos thresholds. */
export function decodeOpticalMinMaxDbm(
  value: unknown,
  encoding: HuaweiOpticalThresholdEncoding,
): number | null {
  return decodeOpticalThresholdDbm(value, encoding);
}

/** Bias de UMA lane (.31): decimal em mA ou micro-amps inteiros. */
export function decodeOpticalBiasMa(
  value: unknown,
  encoding: HuaweiOpticalLaneBiasEncoding,
): number | null {
  if (encoding === 'UNSUPPORTED') return null;
  const raw = rawNumber(value);
  if (raw === null) return null;
  const milliamps = encoding === 'MICRO_AMPS' ? raw / 1000 : raw;
  return milliamps >= 0 && milliamps <= MAX_PLAUSIBLE_OPTICAL_BIAS_MA ? milliamps : null;
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
export function buildHuaweiDeviceThresholds(
  input: {
    rx: HuaweiThresholdValues;
    tx: HuaweiThresholdValues;
    /** Par WARNING do RX (.20/.21); ausente/null = familia sem WARNING. */
    rxWarning?: HuaweiThresholdValues | undefined;
    /** Par WARNING do TX (.22/.23); ausente/null = familia sem WARNING. */
    txWarning?: HuaweiThresholdValues | undefined;
  },
): OpticalThresholdsV1 | null {
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
    // do mesmo jeito que o par low >= high — nunca se inventa um lado.
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

/** Bias em mA do caminho SSH (texto ja em mA). */
export function normalizeHuaweiBiasCurrentMa(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = value instanceof Uint8Array ? decodeSnmpText(value) : String(value);
  if (!text.trim()) return null;
  const parsed = Number(text.trim());
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_PLAUSIBLE_OPTICAL_BIAS_MA
    ? parsed
    : null;
}

/**
 * Converte as tres colunas CSV em lanes independentes e esparsas. Cada campo e
 * ignorado individualmente (nunca desloca as lanes seguintes) e uma lane so
 * existe quando tem ao menos um valor valido.
 */
export function parseHuaweiOpticalLaneCsv(
  rxCsv: unknown,
  txCsv: unknown,
  biasCsv: unknown,
  laneEncoding: HuaweiOpticalLaneEncoding,
  biasEncoding: HuaweiOpticalLaneBiasEncoding,
): OpticalLaneReading[] {
  const rxValues = csvValues(rxCsv);
  const txValues = csvValues(txCsv);
  const biasValues = csvValues(biasCsv);
  const laneCount = Math.max(rxValues.length, txValues.length, biasValues.length);
  const lanes: OpticalLaneReading[] = [];

  for (let lane = 0; lane < laneCount; lane += 1) {
    const rxPowerDbm = decodeOpticalLaneDbm(rxValues[lane], laneEncoding);
    const txPowerDbm = decodeOpticalLaneDbm(txValues[lane], laneEncoding);
    const biasCurrentMa = decodeOpticalBiasMa(biasValues[lane], biasEncoding);
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
