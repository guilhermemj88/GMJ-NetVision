import { alarmInterfaceLabel, METRIC_ALARM_TYPES } from '@gmj/shared';
import type {
  InterfaceErrorsRuleConfig,
  MetricAlarmType,
  MetricThresholdRuleConfig,
  NetworkInterface,
} from '@gmj/shared';
import type { AlarmRepository } from '../infrastructure/alarms/alarm-repository';
import type { AlarmRuleRecord, AlarmRuleRepository } from '../infrastructure/alarms/alarm-rule-repository';
import type {
  HostRepository,
  InterfaceMetricWindowRow,
} from '../infrastructure/persistence/host-repository';
import { isPlausibleCounter32Wrap } from '../infrastructure/snmp/counter-delta';

/** Janela de leitura das amostras recentes (30 min cobre os tetos de samples). */
export const METRIC_ALARM_WINDOW_MS = 30 * 60_000;

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
}): string {
  const metric = metricLabel(input.type, input.direction);
  return `${input.deviceName}: ${input.interfaceLabel} (${input.interfaceName}) — ${metric} ${formatRate(input.ratePerMinute)}/min (limite ${formatRate(input.thresholdPerMinute)}/min)`;
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

export interface MetricEvaluationInput {
  deviceId: string;
  deviceName: string;
  interfaces: readonly NetworkInterface[];
}

export interface AlarmEngineDependencies {
  hosts: HostRepository;
  alarms: AlarmRepository;
  rules: AlarmRuleRepository;
  now?: () => Date;
}

/**
 * Motor dos alarmes metricos (errors/discards/CRC). Roda apos cada poll e e
 * STATELESS: PENDING/RECOVERING sao derivados das amostras persistidas, entao
 * reinicio de processo nao perde contagem nem gera storm.
 */
export class AlarmEngine {
  private readonly now: () => Date;

  constructor(private readonly deps: AlarmEngineDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  async processDeviceMetrics(input: MetricEvaluationInput): Promise<void> {
    if (!input.interfaces.length) return;

    const rules = await this.deps.rules.listEnabled(METRIC_ALARM_TYPES);
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

          if (!open) {
            if (
              consecutiveMatch(
                evaluations,
                (rate) => rate >= config.thresholdPerMinute,
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
                }),
                startedAt: this.now(),
              });
              if (opened) openFingerprints.set(fingerprint, opened);
            }
            continue;
          }

          if (
            consecutiveMatch(
              evaluations,
              (rate) => rate <= config.recoveryThresholdPerMinute,
              config.recoverySamples,
            )
          ) {
            const resolved = await this.deps.alarms.resolveMetricAlarm(
              networkInterface.id,
              rule.type,
              toggle.metricKey,
              this.now(),
            );
            if (resolved) openFingerprints.delete(fingerprint);
          }
        }
      }
    }
  }
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
  return `${ruleId}|${interfaceId}|${type}|${metricKey}`;
}
