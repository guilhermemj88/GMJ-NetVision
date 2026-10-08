import { describe, expect, it } from 'vitest';
import type { AlarmRuleDto } from '@gmj/shared';
import {
  ALARM_RULE_PRESETS,
  ANY_CRC_PRESET,
  BASIC_ALARM_RULE_SLOTS,
  basicSlotByManagedKey,
  describeAlarmRule,
  describeAlarmRuleScope,
  isRecommendedConfiguration,
  opticalRuleDefaults,
  otherEnabledRulesOfType,
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

describe('slots do BASICO (F9.6)', () => {
  it('expoe os 4 slots gerenciados com managedKey, tipo e preset recomendado', () => {
    expect(BASIC_ALARM_RULE_SLOTS.map((slot) => slot.managedKey)).toEqual([
      'BASIC_INTERFACE_CRC',
      'BASIC_INTERFACE_DISCARDS',
      'BASIC_INTERFACE_ERRORS',
      'BASIC_OPTICAL_RX_DEGRADATION',
    ]);
    expect(BASIC_ALARM_RULE_SLOTS.map((slot) => slot.type)).toEqual([
      'INTERFACE_CRC',
      'INTERFACE_DISCARDS',
      'INTERFACE_ERRORS',
      'OPTICAL_RX_DEGRADATION',
    ]);
    const crc = BASIC_ALARM_RULE_SLOTS[0]!;
    expect(crc.severity).toBe('WARNING');
    expect(crc.config).toMatchObject({
      thresholdPerMinute: 10,
      recoveryThresholdPerMinute: 2,
      triggerSamples: 3,
      recoverySamples: 3,
    });
    const discards = BASIC_ALARM_RULE_SLOTS[1]!;
    expect(discards.config).toMatchObject({
      direction: 'BOTH',
      thresholdPerMinute: 20,
      recoveryThresholdPerMinute: 5,
      triggerSamples: 3,
      recoverySamples: 3,
    });
    const errors = BASIC_ALARM_RULE_SLOTS[2]!;
    expect(errors.severity).toBe('MAJOR');
    expect(errors.config).toMatchObject({ direction: 'RX', thresholdPerMinute: 10 });
    const optical = BASIC_ALARM_RULE_SLOTS[3]!;
    expect(optical.config).toEqual(opticalRuleDefaults());
  });

  it('RECOMENDADA quando config/severity/mapLinkedOnly batem com o slot', () => {
    const slot = BASIC_ALARM_RULE_SLOTS[0]!;
    const rule = {
      config: { ...slot.config },
      severity: slot.severity,
      mapLinkedOnly: true,
    } as Pick<AlarmRuleDto, 'config' | 'severity' | 'mapLinkedOnly'>;
    expect(isRecommendedConfiguration(rule, slot)).toBe(true);

    // Números com precisão "suja" continuam iguais (normalização).
    expect(isRecommendedConfiguration(
      { ...rule, config: { thresholdPerMinute: 10.0, recoveryThresholdPerMinute: 2, triggerSamples: 3, recoverySamples: 3 } },
      slot,
    )).toBe(true);
  });

  it('PERSONALIZADA em qualquer diferença tecnica; midia/enabled nao contam', () => {
    const slot = BASIC_ALARM_RULE_SLOTS[0]!;
    const base = {
      config: { ...slot.config },
      severity: slot.severity,
      mapLinkedOnly: true,
    } as Pick<AlarmRuleDto, 'config' | 'severity' | 'mapLinkedOnly'>;

    expect(isRecommendedConfiguration({ ...base, config: { ...slot.config, thresholdPerMinute: 5 } }, slot))
      .toBe(false);
    expect(isRecommendedConfiguration({ ...base, severity: 'MAJOR' }, slot)).toBe(false);
    expect(isRecommendedConfiguration({ ...base, mapLinkedOnly: false }, slot)).toBe(false);
    // mediaEnabled/enabled não fazem parte da comparação (nem são aceitos nela).
    expect(isRecommendedConfiguration(base, slot)).toBe(true);
  });

  it('resolve o slot pelo managedKey e conta regras extras do mesmo tipo', () => {
    expect(basicSlotByManagedKey('BASIC_INTERFACE_CRC')?.type).toBe('INTERFACE_CRC');
    expect(basicSlotByManagedKey(null)).toBeNull();
    expect(basicSlotByManagedKey(undefined)).toBeNull();

    const slot = BASIC_ALARM_RULE_SLOTS[0]!;
    const managed = { id: 'r1', type: 'INTERFACE_CRC', enabled: true } as AlarmRuleDto;
    const customSameType = { id: 'r2', type: 'INTERFACE_CRC', enabled: true } as AlarmRuleDto;
    const disabledSameType = { id: 'r3', type: 'INTERFACE_CRC', enabled: false } as AlarmRuleDto;
    const otherType = { id: 'r4', type: 'INTERFACE_DISCARDS', enabled: true } as AlarmRuleDto;

    expect(otherEnabledRulesOfType([managed, customSameType, disabledSameType, otherType], slot, 'r1'))
      .toBe(1);
    expect(otherEnabledRulesOfType([managed, disabledSameType], slot, 'r1')).toBe(0);
  });
});
