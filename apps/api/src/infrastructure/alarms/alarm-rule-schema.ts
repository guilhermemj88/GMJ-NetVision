import { z } from 'zod';
import type { AlarmRuleConfig, AlarmRuleScope, MetricAlarmType } from '@gmj/shared';

/**
 * Validacao das AlarmRules (Zod + discriminated union).
 *
 * Tudo que entra pela API passa por aqui; tudo que sai do banco e revalidado
 * (linha invalida e ignorada pela leitura, nunca derruba o painel nem o motor).
 */

/** Tipos criaveis pela API nesta fase; INTERFACE_DOWN segue o fluxo legado. */
export const CREATABLE_ALARM_RULE_TYPES = [
  'INTERFACE_ERRORS',
  'INTERFACE_CRC',
  'INTERFACE_DISCARDS',
  'OPTICAL_RX_DEGRADATION',
] as const;

export const MAX_ALARM_RULE_SAMPLES = 10;

export function isMetricAlarmType(value: string): value is MetricAlarmType {
  return (CREATABLE_ALARM_RULE_TYPES as readonly string[]).includes(value);
}

const scopeIdList = (max: number) => z.array(z.string().min(1).max(64)).min(1).max(max);

export const alarmRuleScopeSchema = z
  .object({
    devices: scopeIdList(200).optional(),
    interfaces: scopeIdList(500).optional(),
    speedsBps: z.array(z.number().int().positive().max(1_000_000_000_000)).min(1).max(12).optional(),
  })
  .strict();

const metricThresholdFields = {
  /**
   * 0 = QUALQUER ocorrencia: o intervalo precisa ter delta > 0, sem depender da
   * duracao do poll (usado pelos presets QUALQUER CRC / QUALQUER DISCARD).
   */
  thresholdPerMinute: z.number().min(0).max(10_000_000),
  recoveryThresholdPerMinute: z.number().min(0).max(10_000_000),
  triggerSamples: z.number().int().min(1).max(MAX_ALARM_RULE_SAMPLES),
  recoverySamples: z.number().int().min(1).max(MAX_ALARM_RULE_SAMPLES),
};

const RECOVERY_MESSAGE =
  'recoveryThresholdPerMinute deve ser menor que thresholdPerMinute (e 0 quando o threshold for 0)';

const recoveryBelowTrigger = (value: {
  thresholdPerMinute: number;
  recoveryThresholdPerMinute: number;
}): boolean => (value.thresholdPerMinute > 0
  ? value.recoveryThresholdPerMinute < value.thresholdPerMinute
  : value.recoveryThresholdPerMinute === 0);

export const interfaceErrorsConfigSchema = z
  .object({
    direction: z.enum(['RX', 'TX', 'BOTH']),
    ...metricThresholdFields,
  })
  .strict()
  .refine(recoveryBelowTrigger, { message: RECOVERY_MESSAGE });

export const interfaceDiscardsConfigSchema = interfaceErrorsConfigSchema;

/** FCS/CRC e metrica de recepcao (RX) por definicao: sem direcao configuravel. */
export const interfaceCrcConfigSchema = z
  .object(metricThresholdFields)
  .strict()
  .refine(recoveryBelowTrigger, { message: RECOVERY_MESSAGE });

const OPTICAL_WINDOW_MESSAGE = 'recoveryProximityPercent deve ser menor que warningProximityPercent';
const OPTICAL_LADDER_MESSAGE = 'majorProximityPercent deve ser maior que warningProximityPercent';
const OPTICAL_TREND_MESSAGE = 'trendMajorDropDb deve ser maior ou igual a trendDropDb';

/** Limiares opticos (proximidade/margem/tendencia) validados na entrada. */
export const opticalConfigSchema = z
  .object({
    warningProximityPercent: z.number().min(0).max(100).default(90),
    majorProximityPercent: z.number().min(0).max(100).default(95),
    criticalAtLowAlarm: z.boolean().default(true),
    warningTriggerSamples: z.number().int().min(1).max(MAX_ALARM_RULE_SAMPLES).default(3),
    majorTriggerSamples: z.number().int().min(1).max(MAX_ALARM_RULE_SAMPLES).default(2),
    criticalTriggerSamples: z.number().int().min(1).max(MAX_ALARM_RULE_SAMPLES).default(1),
    warningMarginDb: z.number().min(0).max(30).default(3),
    recoveryProximityPercent: z.number().min(0).max(100).default(85),
    recoverySamples: z.number().int().min(1).max(MAX_ALARM_RULE_SAMPLES).default(3),
    trendDropDb: z.number().min(0).max(60).default(3),
    trendMajorDropDb: z.number().min(0).max(60).default(5),
    trendWindowMinutes: z.number().int().min(5).max(1440).default(30),
    manualRxLowAlarmDbm: z.number().min(-60).max(20).nullish(),
    manualRxHighAlarmDbm: z.number().min(-60).max(20).nullish(),
  })
  .strict()
  .refine(
    (value) => value.recoveryProximityPercent < value.warningProximityPercent,
    { message: OPTICAL_WINDOW_MESSAGE },
  )
  .refine((value) => value.warningProximityPercent < value.majorProximityPercent, {
    message: OPTICAL_LADDER_MESSAGE,
  })
  .refine((value) => value.trendMajorDropDb >= value.trendDropDb, {
    message: OPTICAL_TREND_MESSAGE,
  });

export const alarmRuleConfigByType = {
  INTERFACE_ERRORS: interfaceErrorsConfigSchema,
  INTERFACE_CRC: interfaceCrcConfigSchema,
  INTERFACE_DISCARDS: interfaceDiscardsConfigSchema,
  OPTICAL_RX_DEGRADATION: opticalConfigSchema,
} as const;

const ruleBaseShape = {
  name: z.string().min(1).max(120),
  enabled: z.boolean().optional().default(true),
  severity: z.enum(['CRITICAL', 'MAJOR', 'WARNING', 'INFO']),
  mapLinkedOnly: z.boolean().optional().default(true),
  mediaEnabled: z.boolean().optional().default(false),
  scope: alarmRuleScopeSchema.optional().default({}),
};

export const createAlarmRuleSchema = z.discriminatedUnion('type', [
  z
    .object({ ...ruleBaseShape, type: z.literal('INTERFACE_ERRORS'), config: interfaceErrorsConfigSchema })
    .strict(),
  z
    .object({ ...ruleBaseShape, type: z.literal('INTERFACE_CRC'), config: interfaceCrcConfigSchema })
    .strict(),
  z
    .object({
      ...ruleBaseShape,
      type: z.literal('INTERFACE_DISCARDS'),
      config: interfaceDiscardsConfigSchema,
    })
    .strict(),
  z
    .object({
      ...ruleBaseShape,
      type: z.literal('OPTICAL_RX_DEGRADATION'),
      config: opticalConfigSchema,
    })
    .strict(),
]);

export type CreateAlarmRuleInput = z.infer<typeof createAlarmRuleSchema>;

export function parseAlarmRuleScope(value: unknown): AlarmRuleScope | null {
  const parsed = alarmRuleScopeSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : null;
}

export function parseAlarmRuleConfig(type: string, value: unknown): AlarmRuleConfig | null {
  const schema = (alarmRuleConfigByType as Record<string, z.ZodTypeAny>)[type];
  if (!schema) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? (parsed.data as AlarmRuleConfig) : null;
}
