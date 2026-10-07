import type {
  AlarmRuleConfig,
  AlarmRuleDto,
  AlarmSeverity,
  InterfaceCrcRuleConfig,
  InterfaceDiscardsRuleConfig,
  InterfaceErrorsRuleConfig,
  MetricAlarmType,
  OpticalRuleConfig,
} from '@gmj/shared';

/**
 * Presets operacionais de regra (F8, secao I).
 *
 * "Qualquer ocorrencia" e expresso como `thresholdPerMinute: 0`, que o motor
 * entende como delta > 0 no intervalo — sem depender da duracao do poll (1 CRC
 * em 60s ou em 120s disparam igual). `thresholdPerMinute > 0` continua sendo a
 * taxa/min classica.
 */
export interface AlarmRulePreset {
  id: string;
  label: string;
  summary: string;
  type: MetricAlarmType;
  severity: AlarmSeverity;
  config: AlarmRuleConfig;
}

/** Threshold que o motor interpreta como "qualquer ocorrência" (delta > 0). */
export const ANY_OCCURRENCE_THRESHOLD_PER_MINUTE = 0;

export const ANY_CRC_PRESET: AlarmRulePreset = {
  id: 'crc-any',
  label: 'QUALQUER CRC',
  summary: 'qualquer ocorrência (delta > 0) · 1 amostra',
  type: 'INTERFACE_CRC',
  severity: 'WARNING',
  config: {
    thresholdPerMinute: ANY_OCCURRENCE_THRESHOLD_PER_MINUTE,
    recoveryThresholdPerMinute: 0,
    triggerSamples: 1,
    recoverySamples: 1,
  } satisfies InterfaceCrcRuleConfig,
};

export const ANY_DISCARDS_PRESET: AlarmRulePreset = {
  id: 'discards-any',
  label: 'QUALQUER DISCARD',
  summary: 'RX ou TX com delta > 0 · 1 amostra',
  type: 'INTERFACE_DISCARDS',
  severity: 'WARNING',
  config: {
    direction: 'BOTH',
    thresholdPerMinute: ANY_OCCURRENCE_THRESHOLD_PER_MINUTE,
    recoveryThresholdPerMinute: 0,
    triggerSamples: 1,
    recoverySamples: 1,
  } satisfies InterfaceDiscardsRuleConfig,
};

export const SUSTAINED_DISCARDS_PRESET: AlarmRulePreset = {
  id: 'discards-sustained',
  label: 'DISCARD SUSTENTADO',
  summary: 'acima de 20/min por 3 amostras',
  type: 'INTERFACE_DISCARDS',
  severity: 'WARNING',
  config: {
    direction: 'BOTH',
    thresholdPerMinute: 20,
    recoveryThresholdPerMinute: 5,
    triggerSamples: 3,
    recoverySamples: 3,
  } satisfies InterfaceDiscardsRuleConfig,
};

export const SUSTAINED_ERRORS_PRESET: AlarmRulePreset = {
  id: 'errors-sustained',
  label: 'ERROS SUSTENTADOS',
  summary: 'acima de 10/min por 3 amostras',
  type: 'INTERFACE_ERRORS',
  severity: 'MAJOR',
  config: {
    direction: 'RX',
    thresholdPerMinute: 10,
    recoveryThresholdPerMinute: 2,
    triggerSamples: 3,
    recoverySamples: 3,
  } satisfies InterfaceErrorsRuleConfig,
};

export const ALARM_RULE_PRESETS: readonly AlarmRulePreset[] = [
  ANY_CRC_PRESET,
  ANY_DISCARDS_PRESET,
  SUSTAINED_DISCARDS_PRESET,
  SUSTAINED_ERRORS_PRESET,
];

/** Defaults da regra optica, iguais aos do schema do backend. */
export function opticalRuleDefaults(): OpticalRuleConfig {
  return {
    warningProximityPercent: 90,
    majorProximityPercent: 95,
    criticalAtLowAlarm: true,
    warningTriggerSamples: 3,
    majorTriggerSamples: 2,
    criticalTriggerSamples: 1,
    warningMarginDb: 3,
    recoveryProximityPercent: 85,
    recoverySamples: 3,
    trendDropDb: 3,
    trendMajorDropDb: 5,
    trendWindowMinutes: 30,
    manualRxLowAlarmDbm: null,
    manualRxHighAlarmDbm: null,
  };
}

export function presetsForType(type: MetricAlarmType): readonly AlarmRulePreset[] {
  return ALARM_RULE_PRESETS.filter((preset) => preset.type === type);
}

const DIRECTION_LABELS: Record<InterfaceErrorsRuleConfig['direction'], string> = {
  RX: 'RX',
  TX: 'TX',
  BOTH: 'RX/TX',
};

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Resumo curto da configuracao, usado nos cards do painel de regras. */
export function describeAlarmRule(rule: Pick<AlarmRuleDto, 'type' | 'config'>): string {
  if (rule.type === 'OPTICAL_RX_DEGRADATION') {
    const config = rule.config as OpticalRuleConfig;
    return [
      `limites do equipamento · ${config.warningProximityPercent}% WARN / ${config.majorProximityPercent}% MAJOR / LOW CRIT`,
      `queda ${formatNumber(config.trendDropDb)} dB WARN / ${formatNumber(config.trendMajorDropDb)} dB MAJOR / ${config.trendWindowMinutes} min`,
    ].join(' · ');
  }
  const config = rule.config as InterfaceCrcRuleConfig;
  const direction = 'direction' in config
    ? `${DIRECTION_LABELS[(config as InterfaceErrorsRuleConfig).direction]} `
    : 'RX ';
  const unit = rule.type === 'INTERFACE_CRC' ? 'CRC' : 'discards';
  const samples = `${config.triggerSamples} amostra${config.triggerSamples > 1 ? 's' : ''}`;
  if (config.thresholdPerMinute <= 0) {
    return `${direction}qualquer ocorrência (delta > 0) · ${samples}`;
  }
  return `${direction}> ${formatNumber(config.thresholdPerMinute)} ${unit}/min · ${samples}`;
}

/** Resumo do escopo: velocidades, devices/interfaces e vinculo de mapa. */
export function describeAlarmRuleScope(
  scope: AlarmRuleDto['scope'],
  mapLinkedOnly: boolean,
): string {
  const parts: string[] = [];
  if (scope.speedsBps?.length) {
    parts.push(scope.speedsBps.map(formatSpeedBps).join(' / '));
  }
  if (scope.devices?.length) parts.push(`${scope.devices.length} equipamento(s)`);
  if (scope.interfaces?.length) parts.push(`${scope.interfaces.length} interface(s)`);
  if (!parts.length) parts.push('todas as interfaces');
  if (mapLinkedOnly) parts.push('somente em enlaces');
  return parts.join(' · ');
}

export function formatSpeedBps(speedBps: number): string {
  if (speedBps >= 1_000_000_000) return `${Math.round(speedBps / 1_000_000_000)}G`;
  if (speedBps >= 1_000_000) return `${Math.round(speedBps / 1_000_000)}M`;
  return `${Math.round(speedBps / 1_000)}k`;
}

export const RULE_SPEED_OPTIONS = [
  { bps: 1_000_000_000, label: '1G' },
  { bps: 10_000_000_000, label: '10G' },
  { bps: 40_000_000_000, label: '40G' },
  { bps: 100_000_000_000, label: '100G' },
] as const;
