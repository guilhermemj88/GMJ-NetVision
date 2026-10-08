import { describe, expect, it } from 'vitest';
import {
  alarmResolutionReasonForSuppression,
  alarmSuppressionFingerprint,
  isAlarmSuppressionActive,
  type AlarmSuppression,
} from './alarm-suppression';
import {
  alarmResolutionReasonLabel,
  alarmSuppressionModeLabel,
  alarmSuppressionReasonLabel,
} from './alarm-label';

function suppression(patch: Partial<AlarmSuppression> = {}): AlarmSuppression {
  return {
    id: 'sup-1',
    fingerprint: 'iface-1|INTERFACE_DOWN',
    deviceId: 'dev-1',
    interfaceId: 'iface-1',
    type: 'INTERFACE_DOWN',
    ruleId: null,
    metricKey: null,
    mode: 'UNTIL_CLEAR',
    reason: 'INTENTIONAL_SHUTDOWN',
    note: null,
    suppressedAt: '2026-10-07T12:00:00.000Z',
    suppressedBy: 'qa-preview',
    expiresAt: null,
    clearedAt: null,
    clearedReason: null,
    createdAt: '2026-10-07T12:00:00.000Z',
    updatedAt: '2026-10-07T12:00:00.000Z',
    ...patch,
  };
}

describe('alarmSuppressionFingerprint', () => {
  it('uses interface + type for INTERFACE_DOWN and ignores rule/metric noise', () => {
    expect(
      alarmSuppressionFingerprint({
        interfaceId: 'iface-1',
        type: 'INTERFACE_DOWN',
        ruleId: 'ignored',
        metricKey: 'ignored',
      }),
    ).toBe('iface-1|INTERFACE_DOWN');
  });

  it('keeps rule and metric for metric alarms', () => {
    expect(
      alarmSuppressionFingerprint({
        interfaceId: 'iface-1',
        type: 'INTERFACE_DISCARDS',
        ruleId: 'rule-7',
        metricKey: 'TX',
      }),
    ).toBe('iface-1|INTERFACE_DISCARDS|rule-7|TX');
  });

  it('separates CRC from RX/TX and optical lanes from the scalar reading', () => {
    const crc = alarmSuppressionFingerprint({
      interfaceId: 'iface-1',
      type: 'INTERFACE_CRC',
      ruleId: 'rule-1',
      metricKey: 'FCS',
    });
    const rx = alarmSuppressionFingerprint({
      interfaceId: 'iface-1',
      type: 'INTERFACE_ERRORS',
      ruleId: 'rule-1',
      metricKey: 'RX',
    });
    const optical = alarmSuppressionFingerprint({
      interfaceId: 'iface-1',
      type: 'OPTICAL_RX_DEGRADATION',
      ruleId: 'rule-2',
      metricKey: 'RX',
    });
    const lane = alarmSuppressionFingerprint({
      interfaceId: 'iface-1',
      type: 'OPTICAL_RX_DEGRADATION',
      ruleId: 'rule-2',
      metricKey: 'RX_LANE_2',
    });
    expect(new Set([crc, rx, optical, lane]).size).toBe(4);
  });

  it('treats a missing rule as the empty segment instead of dropping the key', () => {
    expect(
      alarmSuppressionFingerprint({ interfaceId: 'iface-9', type: 'INTERFACE_CRC', metricKey: 'FCS' }),
    ).toBe('iface-9|INTERFACE_CRC||FCS');
  });
});

describe('isAlarmSuppressionActive', () => {
  const now = Date.parse('2026-10-07T13:00:00.000Z');

  it('is active while UNTIL_CLEAR has not been cleared', () => {
    expect(isAlarmSuppressionActive(suppression(), now)).toBe(true);
  });

  it('is active while UNTIL_TIME is still inside the window', () => {
    const row = suppression({ mode: 'UNTIL_TIME', expiresAt: '2026-10-07T13:00:01.000Z' });
    expect(isAlarmSuppressionActive(row, now)).toBe(true);
  });

  it('stops blocking as soon as UNTIL_TIME expires', () => {
    const row = suppression({ mode: 'UNTIL_TIME', expiresAt: '2026-10-07T12:59:59.000Z' });
    expect(isAlarmSuppressionActive(row, now)).toBe(false);
  });

  it('never blocks after being cleared, whatever the mode', () => {
    const row = suppression({
      mode: 'UNTIL_TIME',
      expiresAt: '2026-10-07T18:00:00.000Z',
      clearedAt: '2026-10-07T12:30:00.000Z',
      clearedReason: 'MANUAL',
    });
    expect(isAlarmSuppressionActive(row, now)).toBe(false);
  });
});

describe('alarmResolutionReasonForSuppression', () => {
  it('keeps the structured reasons as the history label', () => {
    expect(alarmResolutionReasonForSuppression('INTENTIONAL_SHUTDOWN')).toBe(
      'INTENTIONAL_SHUTDOWN',
    );
    expect(alarmResolutionReasonForSuppression('MAINTENANCE')).toBe('MAINTENANCE');
    expect(alarmResolutionReasonForSuppression('FALSE_POSITIVE')).toBe('FALSE_POSITIVE');
  });

  it('maps OTHER to MANUAL_SUPPRESSION', () => {
    expect(alarmResolutionReasonForSuppression('OTHER')).toBe('MANUAL_SUPPRESSION');
  });
});

describe('suppression labels', () => {
  it('renders the administrative close reason in the history', () => {
    expect(alarmResolutionReasonLabel('MANUAL_SUPPRESSION')).toBe('suprimido pelo operador');
    expect(alarmResolutionReasonLabel('INTENTIONAL_SHUTDOWN')).toBe('desligamento intencional');
    expect(alarmResolutionReasonLabel('RULE_DISABLED')).toBe('regra desativada');
  });

  it('returns null for a technical recovery and echoes unknown values', () => {
    expect(alarmResolutionReasonLabel(null)).toBeNull();
    expect(alarmResolutionReasonLabel(undefined)).toBeNull();
    expect(alarmResolutionReasonLabel('SOMETHING_ELSE')).toBe('SOMETHING_ELSE');
  });

  it('labels modes and reasons for the operator', () => {
    expect(alarmSuppressionModeLabel('UNTIL_CLEAR')).toBe('Até normalizar');
    expect(alarmSuppressionModeLabel('UNTIL_TIME')).toBe('Até o horário');
    expect(alarmSuppressionReasonLabel('MAINTENANCE')).toBe('Manutenção');
    expect(alarmSuppressionReasonLabel('OTHER')).toBe('Outro');
  });
});
