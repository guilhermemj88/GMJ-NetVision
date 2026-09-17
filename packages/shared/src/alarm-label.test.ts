import { describe, expect, it } from 'vitest';
import {
  alarmInterfaceLabel,
  alarmTypeLabel,
  formatAlarmDownSince,
  formatAlarmDuration,
} from './alarm-label';

describe('alarmInterfaceLabel', () => {
  it('prioritizes alias over description, name and ifIndex', () => {
    expect(alarmInterfaceLabel('UPSTREAM-CORE', 'GigabitEthernet0/0/1', 'GE0/0/1', 12)).toBe(
      'UPSTREAM-CORE',
    );
  });

  it('falls back to description when alias is empty', () => {
    expect(alarmInterfaceLabel('', 'ifDescr port', 'GE0/0/1', 12)).toBe('ifDescr port');
    expect(alarmInterfaceLabel(null, '  ifDescr port  ', 'GE0/0/1', 12)).toBe('ifDescr port');
  });

  it('falls back to the technical name when alias and description are blank', () => {
    expect(alarmInterfaceLabel('   ', null, '40GE0/0/1', 99)).toBe('40GE0/0/1');
  });

  it('falls back to ifIndex when every text field is empty', () => {
    expect(alarmInterfaceLabel('', '', '', 77)).toBe('ifIndex 77');
    expect(alarmInterfaceLabel(null, undefined, null, 77)).toBe('ifIndex 77');
  });

  it('keeps the alias value as configured, including a device description from SSH', () => {
    expect(
      alarmInterfaceLabel(
        'SW-SPA-SJO-5732-MPLS-01',
        'HUAWEI, S6720-30C-EI-24S-AC, S6720',
        '40GE0/0/1',
        118,
      ),
    ).toBe('SW-SPA-SJO-5732-MPLS-01');
  });
});

describe('formatAlarmDownSince', () => {
  it('formats an ISO timestamp as a local HH:mm:ss clock', () => {
    const date = new Date(2026, 8, 16, 21, 17, 32);
    expect(formatAlarmDownSince(date.toISOString())).toBe('21:17:32');
  });

  it('returns a placeholder for an invalid timestamp', () => {
    expect(formatAlarmDownSince('not-a-date')).toBe('--:--:--');
  });
});

describe('formatAlarmDuration', () => {
  const startedAt = new Date(2026, 8, 16, 21, 17, 32);

  it('formats sub-minute durations in seconds only', () => {
    const endedAt = new Date(startedAt.getTime() + 38_000);
    expect(formatAlarmDuration(startedAt.toISOString(), endedAt.toISOString())).toBe('38s');
  });

  it('formats durations between one minute and one hour as minutes and seconds', () => {
    const endedAt = new Date(startedAt.getTime() + 134_000);
    expect(formatAlarmDuration(startedAt.toISOString(), endedAt.toISOString())).toBe('2m14s');
  });

  it('formats durations over one hour as hours and minutes', () => {
    const endedAt = new Date(startedAt.getTime() + 63 * 60_000);
    expect(formatAlarmDuration(startedAt.toISOString(), endedAt.toISOString())).toBe('1h03m');
  });

  it('returns 0s for invalid or non-positive spans', () => {
    expect(formatAlarmDuration('not-a-date', startedAt.toISOString())).toBe('0s');
    expect(
      formatAlarmDuration(startedAt.toISOString(), new Date(startedAt.getTime() - 1).toISOString()),
    ).toBe('0s');
  });
});

describe('alarmTypeLabel', () => {
  it('maps INTERFACE_DOWN to the NOC caption', () => {
    expect(alarmTypeLabel('INTERFACE_DOWN')).toBe('LINK DOWN');
  });

  it('keeps unknown types as-is', () => {
    expect(alarmTypeLabel('CUSTOM')).toBe('CUSTOM');
  });
});
