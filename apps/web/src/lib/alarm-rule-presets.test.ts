import { describe, expect, it } from 'vitest';
import type { AlarmRuleDto } from '@gmj/shared';
import {
  ALARM_RULE_PRESETS,
  ANY_CRC_PRESET,
  describeAlarmRule,
  describeAlarmRuleScope,
  opticalRuleDefaults,
  presetsForType,
} from './alarm-rule-presets';

describe('presets e resumos de regra de alarme', () => {
  it('preset QUALQUER CRC usa threshold 0 (delta > 0), 1 amostra e WARNING', () => {
    expect(ANY_CRC_PRESET.type).toBe('INTERFACE_CRC');
    expect(ANY_CRC_PRESET.severity).toBe('WARNING');
    expect(ANY_CRC_PRESET.config).toMatchObject({
      thresholdPerMinute: 0,
      recoveryThresholdPerMinute: 0,
      triggerSamples: 1,
      recoverySamples: 1,
    });
  });

  it('oferece preset de qualquer discard (delta > 0) e de discard sustentado (taxa/min)', () => {
    const presets = presetsForType('INTERFACE_DISCARDS');
    expect(presets.map((preset) => preset.id)).toEqual(['discards-any', 'discards-sustained']);
    expect(presets[0]!.config).toMatchObject({ thresholdPerMinute: 0, triggerSamples: 1 });
    const sustained = presets[1]!;
    expect(sustained.config).toMatchObject({ thresholdPerMinute: 20, triggerSamples: 3 });
  });

  it('defaults da regra optica seguem o schema do backend (3 dB WARN / 5 dB MAJOR / 30 min)', () => {
    expect(opticalRuleDefaults()).toMatchObject({
      warningProximityPercent: 90,
      majorProximityPercent: 95,
      criticalAtLowAlarm: true,
      trendDropDb: 3,
      trendMajorDropDb: 5,
      trendWindowMinutes: 30,
      recoveryProximityPercent: 85,
      recoverySamples: 3,
    });
  });

  it('descreve regra metrica e optica para os cards', () => {
    const crc = {
      type: 'INTERFACE_CRC',
      config: ALARM_RULE_PRESETS[0]!.config,
    } as unknown as Pick<AlarmRuleDto, 'type' | 'config'>;
    expect(describeAlarmRule(crc)).toBe('RX qualquer ocorrência (delta > 0) · 1 amostra');

    const rateCrc = {
      type: 'INTERFACE_CRC',
      config: { thresholdPerMinute: 2, recoveryThresholdPerMinute: 0, triggerSamples: 1, recoverySamples: 1 },
    } as unknown as Pick<AlarmRuleDto, 'type' | 'config'>;
    expect(describeAlarmRule(rateCrc)).toBe('RX > 2 CRC/min · 1 amostra');

    const optical = {
      type: 'OPTICAL_RX_DEGRADATION',
      config: opticalRuleDefaults(),
    } as unknown as Pick<AlarmRuleDto, 'type' | 'config'>;
    const summary = describeAlarmRule(optical);
    expect(summary).toContain('90% WARN / 95% MAJOR / LOW CRIT');
    expect(summary).toContain('queda 3 dB WARN / 5 dB MAJOR / 30 min');
  });

  it('descreve escopo por velocidade e vinculo de mapa', () => {
    expect(describeAlarmRuleScope({}, true)).toBe('todas as interfaces · somente em enlaces');
    expect(
      describeAlarmRuleScope({ speedsBps: [40_000_000_000, 100_000_000_000] }, false),
    ).toBe('40G / 100G');
    expect(describeAlarmRuleScope({ devices: ['d1', 'd2'] }, false)).toBe('2 equipamento(s)');
  });
});
