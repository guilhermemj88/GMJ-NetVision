import { alarmInterfaceLabel, alarmSuppressionFingerprint, METRIC_ALARM_TYPES } from '@gmj/shared';
import type {
  Alarm,
  AlarmMetadata,
  AlarmSeverity,
  InterfaceErrorsRuleConfig,
  MetricAlarmType,
  MetricThresholdRuleConfig,
  NetworkInterface,
  OpticalProximityReference,
  OpticalRuleConfig,
  OpticalThresholdSource,
  OpticalTriggerReason,
} from '@gmj/shared';
import type { AlarmRepository } from '../infrastructure/alarms/alarm-repository';
import type { AlarmRuleRecord, AlarmRuleRepository } from '../infrastructure/alarms/alarm-rule-repository';
import type { AlarmNotifier } from './alarm-notification-service';
import { indexActiveSuppressions } from './alarm-suppression-service';
import type { AlarmSuppressionRepository, AlarmSuppressionRecord } from '../infrastructure/alarms/alarm-suppression-repository';
import type {
  HostRepository,
  InterfaceMetricWindowRow,
  InterfaceOpticalThresholdRecord,
  InterfaceOpticalWindowRow,
} from '../infrastructure/persistence/host-repository';
import { isPlausibleCounter32Wrap } from '../infrastructure/snmp/counter-delta';

/** Janela de leitura das amostras recentes (30 min cobre os tetos de samples). */
export const METRIC_ALARM_WINDOW_MS = 30 * 60_000;

/**
 * Janela minima das amostras opticas: cobre o trend de 30 min e triggers de
 * ate 10 amostras do poll optico (300s). `*TriggerSamples` contam AMOSTRAS
 * OPTICAS, nunca minutos.
 */
export const OPTICAL_ALARM_WINDOW_MS = 60 * 60_000;

/** Tolerancia para nao duplicar a amostra recem-persistida ao avaliar o agora. */
const OPTICAL_SAMPLE_TOLERANCE_MS = 5_000;

export type OpticalLadder = 'NONE' | 'WARNING' | 'MAJOR' | 'CRITICAL';

const SEVERITY_RANK: Record<AlarmSeverity, number> = {
  INFO: 1,
  WARNING: 2,
  MAJOR: 3,
  CRITICAL: 4,
};

function highestSeverity(left: AlarmSeverity, right: AlarmSeverity): AlarmSeverity {
  return SEVERITY_RANK[left] >= SEVERITY_RANK[right] ? left : right;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Proximidade (%) do RX em relacao ao Low Alarm: 100 = no Low, 0 = no High.
 * NUNCA deriva um threshold falso (nada de `low * 0.9`); o valor e apenas a
 * posicao relativa dentro da faixa real do transceiver, com clamp 0..100.
 */
export function opticalProximityPercent(current: number, low: number, high: number): number | null {
  if (!(high > low)) return null;
  const raw = ((high - current) / (high - low)) * 100;
  return Math.min(100, Math.max(0, raw));
}

const OPTICAL_LADDER_RANK: Record<OpticalLadder, number> = {
  NONE: 0,
  WARNING: 1,
  MAJOR: 2,
  CRITICAL: 3,
};

function highestLadder(left: OpticalLadder, right: OpticalLadder): OpticalLadder {
  return OPTICAL_LADDER_RANK[left] >= OPTICAL_LADDER_RANK[right] ? left : right;
}

/**
 * Um valor que salta tao acima dos vizinhos e um pico ISOLADO (glitch/reset de
 * leitura), nao uma condicao real: ele nunca serve de referencia para a queda,
 * senao a volta ao normal viraria um falso MAJOR.
 */
const OPTICAL_TREND_SPIKE_GUARD_DB = 5;

function isIsolatedUpwardSpike(points: readonly number[], index: number): boolean {
  const value = points[index];
  if (value === undefined) return false;
  const previous = points[index - 1];
  const next = points[index + 1];
  if (previous === undefined && next === undefined) return false;
  const neighbourPeak = Math.max(previous ?? Number.NEGATIVE_INFINITY, next ?? Number.NEGATIVE_INFINITY);
  return Number.isFinite(neighbourPeak) && value - neighbourPeak > OPTICAL_TREND_SPIKE_GUARD_DB;
}

/**
 * Queda RELEVANTE no estado atual: maior valor da janela (ignorando picos
 * isolados) menos a amostra MAIS RECENTE. Queda antiga ja recuperada zera — nao
 * se abre alarme de trend depois que a potencia voltou.
 */
export function opticalTrendDropDb(points: readonly number[]): number {
  const current = points.at(-1);
  if (current === undefined) return 0;
  let peak = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < points.length; index += 1) {
    const value = points[index] as number;
    if (isIsolatedUpwardSpike(points, index)) continue;
    if (value > peak) peak = value;
  }
  if (!Number.isFinite(peak)) return 0;
  return round2(Math.max(0, peak - current));
}

export interface OpticalLadderCriteria {
  currentPowerDbm: number;
  lowAlarmDbm: number | null;
  highAlarmDbm: number | null;
  /**
   * WARNING do transceiver (.20-.23). Quando o par existe e e coerente a
   * proximidade passa a ser medida nele (degradacao antecipada); quando nao
   * existe (`null`, ex.: YunShan/S6750) o fallback e a janela HARD, que e o
   * comportamento historico â€” nunca uma janela inventada com um lado so.
   */
  lowWarningDbm?: number | null | undefined;
  highWarningDbm?: number | null | undefined;
  warningProximityPercent: number;
  majorProximityPercent: number;
  criticalAtLowAlarm: boolean;
  warningMarginDb: number;
  /** Queda observada na janela (0 quando ha menos de 3 amostras validas). */
  trendDropObservedDb: number;
  trendDropThresholdDb: number;
  /** Queda (dB) que escala a severidade para MAJOR; nunca abre CRITICAL sozinha. */
  trendMajorDropThresholdDb: number;
}

/** Tolerancia (em pontos percentuais) para nao perder um limiar exato por ponto flutuante. */
const PROXIMITY_EPSILON = 1e-9;

/**
 * Janela efetiva da proximidade: WARNING quando o equipamento publica o par
 * completo e coerente; senao o par HARD (ALARM). Um lado so nunca forma janela.
 */
function opticalProximityWindow(criteria: OpticalLadderCriteria): {
  low: number;
  high: number;
  reference: OpticalProximityReference;
} | null {
  const warningLow = criteria.lowWarningDbm ?? null;
  const warningHigh = criteria.highWarningDbm ?? null;
  if (warningLow !== null && warningHigh !== null && warningLow < warningHigh) {
    return { low: warningLow, high: warningHigh, reference: 'WARNING' };
  }
  const low = criteria.lowAlarmDbm;
  const high = criteria.highAlarmDbm;
  if (low !== null && high !== null && low < high) {
    return { low, high, reference: 'ALARM' };
  }
  return null;
}

/** Escada de proximidade/margem do Low (o CRITICAL do Low e tratado a parte). */
function opticalProximityLadder(criteria: OpticalLadderCriteria): OpticalLadder {
  const window = opticalProximityWindow(criteria);
  if (window) {
    const proximity = opticalProximityPercent(criteria.currentPowerDbm, window.low, window.high);
    if (proximity === null) return 'NONE';
    if (proximity >= criteria.majorProximityPercent - PROXIMITY_EPSILON) return 'MAJOR';
    if (proximity >= criteria.warningProximityPercent - PROXIMITY_EPSILON) return 'WARNING';
    return 'NONE';
  }
  const low = criteria.lowAlarmDbm;
  if (low !== null && criteria.currentPowerDbm - low <= criteria.warningMarginDb) return 'WARNING';
  return 'NONE';
}

/** Escada de variacao rapida: MAJOR/WARNING pela queda; CRITICAL nunca por queda. */
function opticalTrendLadder(criteria: OpticalLadderCriteria): OpticalLadder {
  const drop = criteria.trendDropObservedDb;
  if (drop >= criteria.trendMajorDropThresholdDb) return 'MAJOR';
  if (drop >= criteria.trendDropThresholdDb) return 'WARNING';
  return 'NONE';
}

/**
 * Escada deterministica por amostra: MAXIMO entre os criterios INDEPENDENTES.
 * CRITICAL quando o RX alcanca/cruza o Low Alarm; MAJOR/WARNING por proximidade
 * percentual (faixa Low..High conhecida); WARNING por margem quando so existe o
 * Low; e WARNING/MAJOR por queda na janela, que funciona mesmo sem nenhum
 * threshold (nunca inventa alarme sem criterio).
 */
export function opticalLadderFor(criteria: OpticalLadderCriteria): OpticalLadder {
  if (
    criteria.lowAlarmDbm !== null
    && criteria.criticalAtLowAlarm
    && criteria.currentPowerDbm <= criteria.lowAlarmDbm
  ) {
    return 'CRITICAL';
  }
  return highestLadder(opticalProximityLadder(criteria), opticalTrendLadder(criteria));
}

/** Recuperacao: proximidade abaixo do limite, margem folgada ou trend limpo. */
export function opticalRecovered(
  criteria: OpticalLadderCriteria & { recoveryProximityPercent: number },
): boolean {
  const { currentPowerDbm: current, lowAlarmDbm: low } = criteria;
  const window = opticalProximityWindow(criteria);
  if (window) {
    const proximity = opticalProximityPercent(current, window.low, window.high);
    return proximity !== null
      && proximity <= criteria.recoveryProximityPercent + PROXIMITY_EPSILON;
  }
  if (low !== null) return current - low > criteria.warningMarginDb;
  return criteria.trendDropObservedDb < criteria.trendDropThresholdDb;
}

/** As N ultimas amostras satisfazem a severidade exigida? (por amostra, sem minutos). */
function sustainedSeverity(
  ladders: readonly OpticalLadder[],
  severity: Exclude<OpticalLadder, 'NONE'>,
  required: number,
): boolean {
  if (required < 1 || ladders.length < required) return false;
  const rank = SEVERITY_RANK[severity];
  return ladders
    .slice(-required)
    .every((ladder) => ladder !== 'NONE' && SEVERITY_RANK[ladder] >= rank);
}

export type MetricDirection = 'RX' | 'TX';

export interface CounterSample {
  timestampMs: number;
  /** Contador acumulado bruto (apenas para classificar a transicao). */
  value: bigint;
  /** Delta persistido da transicao (fonte da taxa; nunca o bruto). */
  delta: bigint | null;
}

export interface SamplePairEvaluation {
  valid: boolean;
  reason: 'OK' | 'INVALID_INTERVAL' | 'RESET_OR_DISCONTINUITY' | 'NO_DELTA';
  intervalSeconds: number;
  delta: bigint;
  ratePerMinute: number;
}

/**
 * Avalia UMA transicao entre amostras consecutivas persistidas.
 *
 * O DELTA persistido e a fonte da taxa (nunca o contador acumulado bruto);
 * o valor bruto entra apenas para classificar a transicao:
 * - contador voltando com wrap plausivel de 32 bits => delta aceito;
 * - contador voltando sem wrap => reset/descontinuidade => amostra ignorada;
 * - delta ausente (nao coletado em um dos lados) => amostra ignorada;
 * - intervalo nao positivo => amostra ignorada;
 * - primeira amostra (sem par) nunca entra na avaliacao.
 */
export function evaluateSamplePair(
  previous: CounterSample,
  current: CounterSample,
): SamplePairEvaluation {
  const intervalSeconds = (current.timestampMs - previous.timestampMs) / 1000;
  if (!(intervalSeconds > 0)) {
    return { valid: false, reason: 'INVALID_INTERVAL', intervalSeconds, delta: 0n, ratePerMinute: 0 };
  }
  if (current.value < previous.value && !isPlausibleCounter32Wrap(previous.value, current.value)) {
    return {
      valid: false,
      reason: 'RESET_OR_DISCONTINUITY',
      intervalSeconds,
      delta: 0n,
      ratePerMinute: 0,
    };
  }
  if (current.delta === null) {
    return { valid: false, reason: 'NO_DELTA', intervalSeconds, delta: 0n, ratePerMinute: 0 };
  }
  return {
    valid: true,
    reason: 'OK',
    intervalSeconds,
    delta: current.delta,
    ratePerMinute: (Number(current.delta) * 60) / intervalSeconds,
  };
}

/**
 * Predicado de trigger da taxa. `thresholdPerMinute === 0` significa QUALQUER
 * ocorrencia: o intervalo avaliado precisa ter delta > 0, independentemente de
 * quantos segundos ele durou (poll irregular nao muda a semantica). Um intervalo
 * sem delta (0) nunca casa, e delta ausente/reset continua invalido.
 */
export function thresholdTriggerPredicate(
  thresholdPerMinute: number,
): (ratePerMinute: number) => boolean {
  if (thresholdPerMinute > 0) return (ratePerMinute) => ratePerMinute >= thresholdPerMinute;
  return (ratePerMinute) => ratePerMinute > 0;
}

/** Ultimas `required` avaliacoes (da cauda) validas e aderentes ao predicado. */
export function consecutiveMatch(
  evaluations: readonly SamplePairEvaluation[],
  predicate: (ratePerMinute: number) => boolean,
  required: number,
): boolean {
  if (required < 1 || evaluations.length < required) return false;
  return evaluations
    .slice(-required)
    .every((evaluation) => evaluation.valid && predicate(evaluation.ratePerMinute));
}

export function ruleMatchesInterface(
  rule: AlarmRuleRecord,
  deviceId: string,
  networkInterface: Pick<NetworkInterface, 'id' | 'speedBps'>,
  linkedInterfaceIds: ReadonlySet<string> | null,
): boolean {
  if (rule.scope.devices?.length && !rule.scope.devices.includes(deviceId)) return false;
  if (rule.scope.interfaces?.length && !rule.scope.interfaces.includes(networkInterface.id)) {
    return false;
  }
  if (rule.scope.speedsBps?.length) {
    const speed = Number(networkInterface.speedBps ?? 0);
    if (!rule.scope.speedsBps.includes(speed)) return false;
  }
  if (rule.mapLinkedOnly && (!linkedInterfaceIds || !linkedInterfaceIds.has(networkInterface.id))) {
    return false;
  }
  return true;
}

export function metricAlarmMessage(input: {
  deviceName: string;
  interfaceLabel: string;
  interfaceName: string;
  type: MetricAlarmType;
  direction: MetricDirection | null;
  ratePerMinute: number;
  thresholdPerMinute: number;
  /** Delta do intervalo avaliado (delta > 0 e o criterio do preset QUALQUER). */
  delta?: string | undefined;
}): string {
  const metric = metricLabel(input.type, input.direction);
  const scope = `${input.deviceName}: ${input.interfaceLabel} (${input.interfaceName})`;
  if (input.thresholdPerMinute <= 0) {
    const delta = input.delta ? ` (+${input.delta} no intervalo)` : '';
    return `${scope} — ${metric} qualquer ocorrência (delta > 0)${delta}`;
  }
  return `${scope} — ${metric} ${formatRate(input.ratePerMinute)}/min (limite ${formatRate(input.thresholdPerMinute)}/min)`;
}

function metricLabel(type: MetricAlarmType, direction: MetricDirection | null): string {
  if (type === 'INTERFACE_CRC') return 'CRC/FCS';
  const noun = type === 'INTERFACE_DISCARDS' ? 'discards' : 'errors';
  return `${direction ?? 'RX'} ${noun}`;
}

function formatRate(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export interface MetricToggle {
  metricKey: string;
  direction: MetricDirection;
  rawColumn: (row: InterfaceMetricWindowRow) => bigint | null;
  deltaColumn: (row: InterfaceMetricWindowRow) => bigint | null;
}

function directionsFor(direction: 'RX' | 'TX' | 'BOTH'): MetricDirection[] {
  return direction === 'BOTH' ? ['RX', 'TX'] : [direction];
}

export function metricTogglesForRule(rule: AlarmRuleRecord): MetricToggle[] {
  if (rule.type === 'INTERFACE_CRC') {
    return [
      {
        metricKey: 'FCS',
        direction: 'RX',
        rawColumn: (row) => row.fcsErrors,
        deltaColumn: (row) => row.fcsErrorsDelta,
      },
    ];
  }
  const direction = (rule.config as InterfaceErrorsRuleConfig).direction;
  return directionsFor(direction).map((side) =>
    rule.type === 'INTERFACE_ERRORS'
      ? {
          metricKey: side,
          direction: side,
          rawColumn: (row) => (side === 'RX' ? row.inErrors : row.outErrors),
          deltaColumn: (row) => (side === 'RX' ? row.inErrorsDelta : row.outErrorsDelta),
        }
      : {
          metricKey: side,
          direction: side,
          rawColumn: (row) => (side === 'RX' ? row.inDiscards : row.outDiscards),
          deltaColumn: (row) => (side === 'RX' ? row.inDiscardsDelta : row.outDiscardsDelta),
        },
  );
}

/** Campos de limiar/samples comuns aos tipos desta fase. */
export function thresholdConfigFor(rule: AlarmRuleRecord): MetricThresholdRuleConfig {
  return rule.config as MetricThresholdRuleConfig;
}

export type OpticalAlarmReason = 'AT_LOW' | 'PROXIMITY' | 'MARGIN' | 'TREND';

export interface OpticalLadderOutcome {
  reason: OpticalAlarmReason;
  unit: string;
  currentValue: number;
  thresholdValue: number;
}

/**
 * Valores publicados no alarme conforme o criterio que sustentou a severidade.
 * A proximidade usa a faixa real LOW..HIGH do equipamento; nunca um threshold
 * derivado (`low * 0.9` e proibido por decisao de projeto).
 */
export function opticalAlarmOutcome(
  criteria: OpticalLadderCriteria,
  ladder: OpticalLadder,
): OpticalLadderOutcome {
  const { currentPowerDbm: current, lowAlarmDbm: low } = criteria;
  if (ladder === 'CRITICAL' && low !== null && criteria.criticalAtLowAlarm && current <= low) {
    return {
      reason: 'AT_LOW',
      unit: 'dBm',
      currentValue: round2(current),
      thresholdValue: round2(low),
    };
  }
  const trendLadder = opticalTrendLadder(criteria);
  if (OPTICAL_LADDER_RANK[trendLadder] > OPTICAL_LADDER_RANK[opticalProximityLadder(criteria)]) {
    return {
      reason: 'TREND',
      unit: 'dB',
      currentValue: criteria.trendDropObservedDb,
      thresholdValue: trendLadder === 'MAJOR'
        ? criteria.trendMajorDropThresholdDb
        : criteria.trendDropThresholdDb,
    };
  }
  const window = opticalProximityWindow(criteria);
  if (window) {
    const proximity = opticalProximityPercent(current, window.low, window.high) ?? 0;
    return {
      reason: 'PROXIMITY',
      unit: '%',
      currentValue: round2(proximity),
      thresholdValue: ladder === 'MAJOR'
        ? criteria.majorProximityPercent
        : criteria.warningProximityPercent,
    };
  }
  if (low !== null) {
    return {
      reason: 'MARGIN',
      unit: 'dB',
      currentValue: round2(current - low),
      thresholdValue: criteria.warningMarginDb,
    };
  }
  return {
    reason: 'TREND',
    unit: 'dB',
    currentValue: criteria.trendDropObservedDb,
    thresholdValue: criteria.trendDropThresholdDb,
  };
}

export function opticalAlarmMessage(input: {
  deviceName: string;
  interfaceLabel: string;
  interfaceName: string;
  metricKey: string;
  reason: OpticalAlarmReason;
  outcome: OpticalLadderOutcome;
  lowAlarmDbm: number | null;
  highAlarmDbm: number | null;
  trendWindowMinutes: number;
}): string {
  const scope = input.metricKey === 'RX'
    ? 'RX optico'
    : `RX optico lane ${input.metricKey.replace('RX_LANE_', '')}`;
  const prefix = `${input.deviceName}: ${input.interfaceLabel} (${input.interfaceName}) — ${scope}`;
  const { currentValue, thresholdValue } = input.outcome;
  switch (input.reason) {
    case 'AT_LOW':
      return `${prefix} em ${currentValue} dBm (Low Alarm ${thresholdValue} dBm)`;
    case 'PROXIMITY':
      return `${prefix} com proximidade ${currentValue}% do Low Alarm (${input.lowAlarmDbm} a ${input.highAlarmDbm} dBm)`;
    case 'MARGIN':
      return `${prefix} com margem de ${currentValue} dB acima do Low Alarm ${input.lowAlarmDbm} dBm`;
    default:
      return `${prefix} caiu ${currentValue} dB em ${input.trendWindowMinutes} min`;
  }
}

interface OpticalPoint {
  timestampMs: number;
  rxPowerDbm: number | null;
}

interface OpticalSeries {
  metricKey: string;
  lane: number | null;
  powerSource: 'SNMP' | 'SSH' | null;
  speedBps: number;
  lowAlarmDbm: number | null;
  highAlarmDbm: number | null;
  lowWarningDbm: number | null;
  highWarningDbm: number | null;
  thresholdSource: OpticalThresholdSource | null;
  points: OpticalPoint[];
}

/** Fonte efetiva do threshold: lane > scalar > manual da regra > nada. */
function opticalThresholdSideFor(
  record: InterfaceOpticalThresholdRecord | null,
  lane: number | null,
  config: OpticalRuleConfig,
): Pick<
  OpticalSeries,
  'lowAlarmDbm' | 'highAlarmDbm' | 'lowWarningDbm' | 'highWarningDbm' | 'thresholdSource'
> {
  const scopes = lane === null
    ? [record?.thresholds?.scalar.rx]
    : [
        record?.thresholds?.lanes.find((item) => item.lane === lane)?.rx,
        record?.thresholds?.scalar.rx,
      ];
  for (const side of scopes) {
    if (!side) continue;
    const lowWarning = side.lowWarningDbm ?? null;
    const highWarning = side.highWarningDbm ?? null;
    const hasAny = side.lowAlarmDbm !== null
      || side.highAlarmDbm !== null
      || lowWarning !== null
      || highWarning !== null;
    if (!hasAny) continue;
    return {
      lowAlarmDbm: side.lowAlarmDbm,
      highAlarmDbm: side.highAlarmDbm,
      lowWarningDbm: lowWarning,
      highWarningDbm: highWarning,
      thresholdSource: side.lowSource ?? side.highSource ?? null,
    };
  }
  if (config.manualRxLowAlarmDbm != null || config.manualRxHighAlarmDbm != null) {
    return {
      lowAlarmDbm: config.manualRxLowAlarmDbm ?? null,
      highAlarmDbm: config.manualRxHighAlarmDbm ?? null,
      lowWarningDbm: null,
      highWarningDbm: null,
      thresholdSource: 'MANUAL',
    };
  }
  return {
    lowAlarmDbm: null,
    highAlarmDbm: null,
    lowWarningDbm: null,
    highWarningDbm: null,
    thresholdSource: null,
  };
}

/**
 * Series avaliadas na interface: modo LANE quando ha 2+ lanes com leitura
 * (scalar deixa de ser avaliado, sem alarme duplicado) e modo SCALAR caso
 * contrario. Cada lane vira um fingerprint `RX_LANE_n` independente.
 */
export function opticalSeriesFor(
  networkInterface: NetworkInterface,
  samples: readonly InterfaceOpticalWindowRow[],
  record: InterfaceOpticalThresholdRecord | null,
  config: OpticalRuleConfig,
  nowMs: number,
): OpticalSeries[] {
  const ordered = [...samples].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  const laneReadings = (networkInterface.opticalLanes ?? [])
    .filter((lane) => typeof lane.rxPowerDbm === 'number');
  const speedBps = Number(networkInterface.speedBps ?? 0);

  const withCurrent = (points: OpticalPoint[], currentValue: number | null): OpticalPoint[] => {
    if (currentValue === null) return points;
    const last = points.at(-1);
    if (!last || nowMs - last.timestampMs > OPTICAL_SAMPLE_TOLERANCE_MS) {
      points.push({ timestampMs: nowMs, rxPowerDbm: currentValue });
    }
    return points;
  };

  if (laneReadings.length >= 2) {
    return laneReadings.flatMap((lane) => {
      const side = opticalThresholdSideFor(record, lane.lane, config);
      const points = withCurrent(
        ordered.map((sample) => ({
          timestampMs: sample.timestamp.getTime(),
          rxPowerDbm: sample.opticalLanes.find((item) => item.lane === lane.lane)?.rxPowerDbm ?? null,
        })),
        lane.rxPowerDbm ?? null,
      );
      return [{
        metricKey: `RX_LANE_${lane.lane}`,
        lane: lane.lane,
        powerSource: networkInterface.opticalLaneSource ?? null,
        speedBps,
        ...side,
        points,
      }];
    });
  }

  const scalar = networkInterface.rxPowerDbm;
  if (typeof scalar !== 'number') return [];
  return [{
    metricKey: 'RX',
    lane: null,
    powerSource: networkInterface.opticalSource ?? null,
    speedBps,
    ...opticalThresholdSideFor(record, null, config),
    points: withCurrent(
      ordered.map((sample) => ({
        timestampMs: sample.timestamp.getTime(),
        rxPowerDbm: sample.rxPowerDbm,
      })),
      scalar,
    ),
  }];
}

function trendObservedAt(points: readonly OpticalPoint[], index: number, trendWindowMs: number): number {
  const end = points[index];
  if (!end) return 0;
  const startMs = end.timestampMs - trendWindowMs;
  const values: number[] = [];
  for (let position = index; position >= 0; position -= 1) {
    const point = points[position];
    if (!point || point.timestampMs < startMs) break;
    if (point.rxPowerDbm !== null) values.unshift(point.rxPowerDbm);
  }
  return values.length >= 3 ? opticalTrendDropDb(values) : 0;
}

function opticalCriteriaAt(
  series: OpticalSeries,
  index: number,
  config: OpticalRuleConfig,
  trendWindowMs: number,
): (OpticalLadderCriteria & { recoveryProximityPercent: number }) | null {
  const current = series.points[index]?.rxPowerDbm;
  if (current === null || current === undefined) return null;
  return {
    currentPowerDbm: current,
    lowAlarmDbm: series.lowAlarmDbm,
    highAlarmDbm: series.highAlarmDbm,
    lowWarningDbm: series.lowWarningDbm,
    highWarningDbm: series.highWarningDbm,
    warningProximityPercent: config.warningProximityPercent,
    majorProximityPercent: config.majorProximityPercent,
    criticalAtLowAlarm: config.criticalAtLowAlarm,
    warningMarginDb: config.warningMarginDb,
    trendDropObservedDb: trendObservedAt(series.points, index, trendWindowMs),
    trendDropThresholdDb: config.trendDropDb,
    trendMajorDropThresholdDb: config.trendMajorDropDb,
    recoveryProximityPercent: config.recoveryProximityPercent,
  };
}

/** Todos os motivos aplicaveis da amostra (ordem estavel para o NOC). */
function opticalTriggerReasons(criteria: OpticalLadderCriteria): OpticalTriggerReason[] {
  const reasons: OpticalTriggerReason[] = [];
  const { currentPowerDbm: current, lowAlarmDbm: low } = criteria;
  if (low !== null && criteria.criticalAtLowAlarm && current <= low) reasons.push('AT_LOW');
  if (opticalTrendLadder(criteria) !== 'NONE') reasons.push('RAPID_DROP');
  const window = opticalProximityWindow(criteria);
  if (window) {
    const proximity = opticalProximityPercent(current, window.low, window.high);
    if (proximity !== null && proximity >= criteria.warningProximityPercent - PROXIMITY_EPSILON) {
      reasons.push('PROXIMITY');
    }
  } else if (low !== null && current - low <= criteria.warningMarginDb) {
    reasons.push('MARGIN');
  }
  return reasons;
}

function opticalAlarmMetadata(
  series: OpticalSeries,
  criteria: OpticalLadderCriteria,
  config: OpticalRuleConfig,
): AlarmMetadata {
  const window = opticalProximityWindow(criteria);
  const proximity = window
    ? round2(opticalProximityPercent(criteria.currentPowerDbm, window.low, window.high) ?? 0)
    : null;
  return {
    direction: 'RX',
    rxPowerDbm: round2(criteria.currentPowerDbm),
    rxLowAlarmDbm: criteria.lowAlarmDbm,
    rxHighAlarmDbm: criteria.highAlarmDbm,
    rxLowWarningDbm: criteria.lowWarningDbm ?? null,
    rxHighWarningDbm: criteria.highWarningDbm ?? null,
    proximityReference: window?.reference ?? null,
    marginDb: criteria.lowAlarmDbm !== null
      ? round2(criteria.currentPowerDbm - criteria.lowAlarmDbm)
      : null,
    proximityPercent: proximity,
    trendDropDb: criteria.trendDropObservedDb,
    trendWindowMinutes: config.trendWindowMinutes,
    triggerReasons: opticalTriggerReasons(criteria),
    currentPowerSource: series.powerSource,
    thresholdSource: series.thresholdSource,
    speedBps: series.speedBps,
    ...(series.lane === null ? {} : { lane: series.lane }),
  };
}

function isOpticalRule(rule: AlarmRuleRecord): boolean {
  return rule.type === 'OPTICAL_RX_DEGRADATION';
}

export interface MetricEvaluationInput {
  deviceId: string;
  deviceName: string;
  interfaces: readonly NetworkInterface[];
}

export interface OpticalEvaluationInput {
  deviceId: string;
  deviceName: string;
  interfaces: readonly NetworkInterface[];
}

export interface AlarmEngineDependencies {
  hosts: HostRepository;
  alarms: AlarmRepository;
  rules: AlarmRuleRepository;
  /** Notificacao de midia (NETWORK_ALARMS); ausente = motor sem midia. */
  notifier?: AlarmNotifier | undefined;
  /** Supressao operacional: ausente = motor sem retirada manual. */
  suppressions?: AlarmSuppressionRepository | undefined;
  now?: () => Date;
}

/**
 * Motor dos alarmes metricos (errors/discards/CRC). Roda apos cada poll e e
 * STATELESS: PENDING/RECOVERING sao derivados das amostras persistidas, entao
 * reinicio de processo nao perde contagem nem gera storm.
 */
export class AlarmEngine {
  private readonly now: () => Date;
  /** Housekeeping de supressoes expiradas roda no maximo 1x por minuto. */
  private lastSuppressionSweepAt = 0;

  constructor(private readonly deps: AlarmEngineDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Supressoes ativas do equipamento, indexadas pelo fingerprint do alarme. */
  private async activeSuppressions(
    deviceId: string,
  ): Promise<Map<string, AlarmSuppressionRecord>> {
    if (!this.deps.suppressions) return new Map<string, AlarmSuppressionRecord>();
    const rows = await this.deps.suppressions.listActive(this.now(), { deviceId });
    return indexActiveSuppressions(rows);
  }

  private async housekeepSuppressions(): Promise<void> {
    if (!this.deps.suppressions) return;
    const now = this.now().getTime();
    if (now - this.lastSuppressionSweepAt < 60_000) return;
    this.lastSuppressionSweepAt = now;
    await this.deps.suppressions.expireDue(new Date(now));
  }

  async processDeviceMetrics(input: MetricEvaluationInput): Promise<void> {
    if (!input.interfaces.length) return;

    await this.housekeepSuppressions();

    const rules = (await this.deps.rules.listEnabled(METRIC_ALARM_TYPES)).filter(
      (rule) => !isOpticalRule(rule),
    );
    const applicable = rules.filter(
      (rule) => !rule.scope.devices?.length || rule.scope.devices.includes(input.deviceId),
    );
    if (!applicable.length) return;

    const linked = applicable.some((rule) => rule.mapLinkedOnly)
      ? await this.deps.alarms.findLinkedInterfaceIds(input.interfaces.map((item) => item.id))
      : null;

    const since = new Date(this.now().getTime() - METRIC_ALARM_WINDOW_MS);
    const rows = await this.deps.hosts.getRecentInterfaceMetricSamples(input.deviceId, since);
    if (!rows.length) return;

    const rowsByInterface = new Map<string, InterfaceMetricWindowRow[]>();
    for (const row of rows) {
      const list = rowsByInterface.get(row.interfaceId);
      if (list) list.push(row);
      else rowsByInterface.set(row.interfaceId, [row]);
    }

    const openAlarms = await this.deps.alarms.listOpenMetricAlarms(input.deviceId);
    const openFingerprints = new Map(
      openAlarms.map((alarm) => [
        fingerprintOf(alarm.ruleId ?? '', alarm.interfaceId, alarm.type, alarm.metricKey ?? ''),
        alarm,
      ]),
    );
    const suppressions = await this.activeSuppressions(input.deviceId);

    for (const networkInterface of input.interfaces) {
      const interfaceRows = rowsByInterface.get(networkInterface.id);
      if (!interfaceRows?.length) continue;
      for (const rule of applicable) {
        if (!ruleMatchesInterface(rule, input.deviceId, networkInterface, linked)) continue;
        for (const toggle of metricTogglesForRule(rule)) {
          const evaluations = evaluateWindow(interfaceRows, toggle);
          const fingerprint = fingerprintOf(
            rule.id,
            networkInterface.id,
            rule.type,
            toggle.metricKey,
          );
          const open = openFingerprints.get(fingerprint);
          const config = thresholdConfigFor(rule);
          const suppression = suppressions.get(fingerprint) ?? null;
          const recovered = consecutiveMatch(
            evaluations,
            (rate) => rate <= config.recoveryThresholdPerMinute,
            config.recoverySamples,
          );

          if (!open) {
            if (suppression) {
              // Supressao ativa: nunca reabre. UNTIL_CLEAR e liberada quando a
              // condicao normaliza; UNTIL_TIME espera o proprio horario.
              if (suppression.mode === 'UNTIL_CLEAR' && recovered) {
                await this.deps.suppressions?.clear(suppression.id, this.now(), 'RECOVERED');
                suppressions.delete(fingerprint);
              }
              continue;
            }
            if (
              consecutiveMatch(
                evaluations,
                thresholdTriggerPredicate(config.thresholdPerMinute),
                config.triggerSamples,
              )
            ) {
              const latest = evaluations.at(-1);
              if (!latest) continue;
              const ratePerMinute = Math.round(latest.ratePerMinute * 100) / 100;
              const opened = await this.deps.alarms.openMetricAlarm({
                deviceId: input.deviceId,
                interfaceId: networkInterface.id,
                ifIndex: networkInterface.ifIndex,
                ruleId: rule.id,
                type: rule.type,
                severity: rule.severity,
                metricKey: toggle.metricKey,
                currentValue: ratePerMinute,
                thresholdValue: config.thresholdPerMinute,
                unit: 'per_min',
                metadata: {
                  direction: toggle.direction,
                  delta: latest.delta.toString(),
                  ratePerMinute,
                  thresholdPerMinute: config.thresholdPerMinute,
                  sampleIntervalSeconds: Math.round(latest.intervalSeconds),
                },
                message: metricAlarmMessage({
                  deviceName: input.deviceName,
                  interfaceLabel: alarmInterfaceLabel(
                    networkInterface.alias,
                    networkInterface.description,
                    networkInterface.name,
                    networkInterface.ifIndex,
                  ),
                  interfaceName: networkInterface.name,
                  type: rule.type,
                  direction: toggle.direction,
                  ratePerMinute,
                  thresholdPerMinute: config.thresholdPerMinute,
                  delta: latest.delta.toString(),
                }),
                startedAt: this.now(),
              });
              if (opened) {
                openFingerprints.set(fingerprint, opened);
                await this.notify(() =>
                  this.deps.notifier?.notifyOpened(opened, { mediaEnabled: rule.mediaEnabled }),
                );
              }
            }
            continue;
          }

          if (recovered) {
            const resolved = await this.deps.alarms.resolveMetricAlarm(
              networkInterface.id,
              rule.type,
              toggle.metricKey,
              this.now(),
            );
            if (resolved) {
              openFingerprints.delete(fingerprint);
              await this.notify(() =>
                this.deps.notifier?.notifyResolved(
                  { ...open, endedAt: this.now().toISOString() },
                  { mediaEnabled: rule.mediaEnabled },
                ),
              );
            }
          }
        }
      }
    }
  }

  /**
   * Avalia o RX optico persistido (AMOSTRAS OPTICAS de 300s). STATELESS: a
   * escada, os triggers e a recuperacao saem das amostras do banco. A escalada
   * acontece na MESMA linha do alarme aberto (sem downgrade) e a recuperacao
   * sustentada e o unico caminho de saida.
   */
  async processOpticalReadings(input: OpticalEvaluationInput): Promise<void> {
    if (!input.interfaces.length) return;

    const rules = (await this.deps.rules.listEnabled(METRIC_ALARM_TYPES)).filter(isOpticalRule);
    const applicable = rules.filter(
      (rule) => !rule.scope.devices?.length || rule.scope.devices.includes(input.deviceId),
    );
    if (!applicable.length) return;

    const linked = applicable.some((rule) => rule.mapLinkedOnly)
      ? await this.deps.alarms.findLinkedInterfaceIds(input.interfaces.map((item) => item.id))
      : null;

    const trendWindows = applicable.map(
      (rule) => (rule.config as OpticalRuleConfig).trendWindowMinutes * 60_000,
    );
    const windowMs = Math.max(OPTICAL_ALARM_WINDOW_MS, ...trendWindows);
    const now = this.now();
    const samples = await this.deps.hosts.getRecentInterfaceOpticalSamples(
      input.deviceId,
      new Date(now.getTime() - windowMs),
    );
    const samplesByInterface = new Map<string, InterfaceOpticalWindowRow[]>();
    for (const sample of samples) {
      const list = samplesByInterface.get(sample.interfaceId);
      if (list) list.push(sample);
      else samplesByInterface.set(sample.interfaceId, [sample]);
    }
    const thresholds = new Map(
      (await this.deps.hosts.getInterfaceOpticalThresholds(input.deviceId)).map((record) => [
        record.interfaceId,
        record,
      ]),
    );
    const openByFingerprint = new Map(
      (await this.deps.alarms.listOpenMetricAlarms(input.deviceId))
        .filter((alarm) => alarm.type === 'OPTICAL_RX_DEGRADATION')
        .map((alarm) => [
          fingerprintOf(alarm.ruleId ?? '', alarm.interfaceId, alarm.type, alarm.metricKey ?? ''),
          alarm,
        ]),
    );
    const suppressions = await this.activeSuppressions(input.deviceId);

    for (const networkInterface of input.interfaces) {
      for (const rule of applicable) {
        if (!ruleMatchesInterface(rule, input.deviceId, networkInterface, linked)) continue;
        const config = rule.config as OpticalRuleConfig;
        const seriesList = opticalSeriesFor(
          networkInterface,
          samplesByInterface.get(networkInterface.id) ?? [],
          thresholds.get(networkInterface.id) ?? null,
          config,
          now.getTime(),
        );
        for (const series of seriesList) {
          await this.evaluateOpticalSeries({
            deviceId: input.deviceId,
            deviceName: input.deviceName,
            networkInterface,
            rule,
            config,
            series,
            openByFingerprint,
            suppressions,
          });
        }
      }
    }
  }

  private async evaluateOpticalSeries(input: {
    deviceId: string;
    deviceName: string;
    networkInterface: NetworkInterface;
    rule: AlarmRuleRecord;
    config: OpticalRuleConfig;
    series: OpticalSeries;
    openByFingerprint: Map<string, Alarm>;
    suppressions: Map<string, AlarmSuppressionRecord>;
  }): Promise<void> {
    const { series, config, rule, networkInterface } = input;
    const trendWindowMs = config.trendWindowMinutes * 60_000;
    const criteriaList = series.points.map((_, index) =>
      opticalCriteriaAt(series, index, config, trendWindowMs),
    );
    const ladders = criteriaList.map((criteria) =>
      criteria ? opticalLadderFor(criteria) : ('NONE' as OpticalLadder),
    );
    const fingerprint = fingerprintOf(rule.id, networkInterface.id, rule.type, series.metricKey);
    const open = input.openByFingerprint.get(fingerprint);
    const recoveries = criteriaList.map((criteria) =>
      criteria ? opticalRecovered(criteria) : false,
    );
    const sustainedRecovery = recoveries.length >= config.recoverySamples
      && recoveries.slice(-config.recoverySamples).every(Boolean);

    if (open) {
      if (sustainedRecovery) {
        const resolved = await this.deps.alarms.resolveMetricAlarm(
          networkInterface.id,
          rule.type,
          series.metricKey,
          this.now(),
        );
        if (resolved) {
          input.openByFingerprint.delete(fingerprint);
          await this.notify(() =>
            this.deps.notifier?.notifyResolved(
              { ...open, endedAt: this.now().toISOString() },
              { mediaEnabled: rule.mediaEnabled },
            ),
          );
        }
        return;
      }
    }

    const suppression = input.suppressions.get(fingerprint) ?? null;
    if (!open && suppression) {
      // Supressao ativa: nao reabre; UNTIL_CLEAR libera quando a leitura volta.
      if (suppression.mode === 'UNTIL_CLEAR' && sustainedRecovery) {
        await this.deps.suppressions?.clear(suppression.id, this.now(), 'RECOVERED');
        input.suppressions.delete(fingerprint);
      }
      return;
    }

    const target = (['CRITICAL', 'MAJOR', 'WARNING'] as const).find((severity) =>
      sustainedSeverity(ladders, severity, triggerSamplesFor(config, severity)),
    );
    const latest = criteriaList.at(-1) ?? null;
    if (!target || !latest) return;

    const severity = highestSeverity(rule.severity, target);
    const outcome = opticalAlarmOutcome(latest, target);
    const metadata = opticalAlarmMetadata(series, latest, config);
    const message = opticalAlarmMessage({
      deviceName: input.deviceName,
      interfaceLabel: alarmInterfaceLabel(
        networkInterface.alias,
        networkInterface.description,
        networkInterface.name,
        networkInterface.ifIndex,
      ),
      interfaceName: networkInterface.name,
      metricKey: series.metricKey,
      reason: outcome.reason,
      outcome,
      lowAlarmDbm: series.lowAlarmDbm,
      highAlarmDbm: series.highAlarmDbm,
      trendWindowMinutes: config.trendWindowMinutes,
    });

    if (!open) {
      const opened = await this.deps.alarms.openMetricAlarm({
        deviceId: input.deviceId,
        interfaceId: networkInterface.id,
        ifIndex: networkInterface.ifIndex,
        ruleId: rule.id,
        type: rule.type,
        severity,
        metricKey: series.metricKey,
        currentValue: outcome.currentValue,
        thresholdValue: outcome.thresholdValue,
        unit: outcome.unit,
        metadata,
        message,
        startedAt: this.now(),
      });
      if (opened) {
        input.openByFingerprint.set(fingerprint, opened);
        await this.notify(() =>
          this.deps.notifier?.notifyOpened(opened, { mediaEnabled: rule.mediaEnabled }),
        );
      }
      return;
    }

    // Mesma linha: so escala, nunca rebaixa (INFO < WARNING < MAJOR < CRITICAL).
    if (SEVERITY_RANK[severity] <= SEVERITY_RANK[open.severity]) return;
    const escalated = await this.deps.alarms.escalateMetricAlarm(open.id, {
      severity,
      currentValue: outcome.currentValue,
      thresholdValue: outcome.thresholdValue,
      unit: outcome.unit,
      metadata,
      message,
    });
    if (escalated) {
      input.openByFingerprint.set(fingerprint, escalated);
      await this.notify(() =>
        this.deps.notifier?.notifyEscalated(escalated, { mediaEnabled: rule.mediaEnabled }),
      );
    }
  }

  /** Midia e best-effort: falha de notificacao nunca derruba o motor. */
  private async notify(action: () => Promise<void> | undefined): Promise<void> {
    if (!this.deps.notifier) return;
    try {
      await action();
    } catch {
      // Sem notificacao neste ciclo; o dedupe persistido garante o retry.
    }
  }
}

function triggerSamplesFor(
  config: OpticalRuleConfig,
  severity: Exclude<OpticalLadder, 'NONE'>,
): number {
  if (severity === 'CRITICAL') return config.criticalTriggerSamples;
  if (severity === 'MAJOR') return config.majorTriggerSamples;
  return config.warningTriggerSamples;
}

function evaluateWindow(
  rows: readonly InterfaceMetricWindowRow[],
  toggle: MetricToggle,
): SamplePairEvaluation[] {
  const evaluations: SamplePairEvaluation[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const previousRow = rows[index - 1];
    const currentRow = rows[index];
    if (!previousRow || !currentRow) continue;
    const previousValue = toggle.rawColumn(previousRow);
    const currentValue = toggle.rawColumn(currentRow);
    if (previousValue === null || currentValue === null) {
      evaluations.push({
        valid: false,
        reason: 'NO_DELTA',
        intervalSeconds: 0,
        delta: 0n,
        ratePerMinute: 0,
      });
      continue;
    }
    evaluations.push(
      evaluateSamplePair(
        {
          timestampMs: previousRow.timestamp.getTime(),
          value: previousValue,
          delta: toggle.deltaColumn(previousRow),
        },
        {
          timestampMs: currentRow.timestamp.getTime(),
          value: currentValue,
          delta: toggle.deltaColumn(currentRow),
        },
      ),
    );
  }
  return evaluations;
}

function fingerprintOf(
  ruleId: string,
  interfaceId: string,
  type: string,
  metricKey: string,
): string {
  // Mesmo fingerprint da supressao: uma unica chave para dedupe e retirada.
  return alarmSuppressionFingerprint({
    interfaceId,
    type: type as Alarm['type'],
    ruleId,
    metricKey,
  });
}
