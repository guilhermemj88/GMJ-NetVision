import { describe, expect, it } from 'vitest';
import {
  decodeLengthPrefixedAsciiIndex,
  parseHuaweiAcIndex,
  parseHuaweiAcStatus,
  parseHuaweiAdminStatus,
  parseHuaweiPwIndex,
  parseHuaweiPwState,
  parseHuaweiPwStatus,
  parseHuaweiPwWorkingState,
  parseHuaweiVsiIndex,
  parseHuaweiVsiOperationalStatus,
  parseHuaweiVcType,
} from './huawei-vpls-parser';

function encoded(value: string): number[] {
  return [value.length, ...[...value].map((character) => character.charCodeAt(0))];
}

describe('Huawei VPLS indexes', () => {
  it('decodes the validated real VSI indexes', () => {
    expect(decodeLengthPrefixedAsciiIndex([8, 71, 69, 82, 69, 78, 67, 73, 65])).toEqual({
      value: 'GERENCIA',
      consumed: 9,
    });
    expect(parseHuaweiVsiIndex([10, 76, 50, 76, 95, 71, 77, 95, 49, 54, 51])).toBe('L2L_GM_163');
  });

  it.each(['A', 'VSI-LONGA_2026', 'L2L_9-EDGE'])('accepts a valid ASCII name: %s', (name) => {
    expect(parseHuaweiVsiIndex(encoded(name))).toBe(name);
  });

  it('parses the validated PW index and stable key', () => {
    expect(parseHuaweiPwIndex([8, 71, 69, 82, 69, 78, 67, 73, 65, 4, 10, 100, 101, 3])).toEqual({
      vsiName: 'GERENCIA',
      pwId: 4,
      remoteIp: '10.100.101.3',
      key: 'GERENCIA|4|10.100.101.3',
    });
  });

  it('parses the validated GERENCIA AC index and ifIndex', () => {
    expect(parseHuaweiAcIndex([8, 71, 69, 82, 69, 78, 67, 73, 65, 43])).toEqual({
      vsiName: 'GERENCIA',
      ifIndex: 43,
      key: 'GERENCIA|43',
    });
    expect(parseHuaweiAcIndex([...encoded('GERENCIA'), 0])).toBeNull();
    expect(parseHuaweiAcIndex([...encoded('GERENCIA'), 43, 1])).toBeNull();
  });

  it.each([
    { index: [] },
    { index: [0] },
    { index: [4, 65, 66] },
    { index: [1, 31] },
    { index: [...encoded('GERENCIA'), 4] },
    { index: [...encoded('GERENCIA'), 4, 10, 100, 101] },
    { index: [...encoded('GERENCIA'), 4, 10, 100, 101, 256] },
    { index: [...encoded('GERENCIA')] },
  ])('rejects an invalid or incomplete index: $index', ({ index }) => {
    expect(parseHuaweiPwIndex(index)).toBeNull();
  });
});

describe('Huawei VPLS status enums', () => {
  it('normalizes official VSI values and unknown values', () => {
    expect([1, 2, 3, 99].map(parseHuaweiVsiOperationalStatus)).toEqual([
      'UP',
      'DOWN',
      'ADMIN_DOWN',
      'UNKNOWN',
    ]);
    expect([1, 2, 99].map(parseHuaweiAdminStatus)).toEqual(['UP', 'DOWN', 'UNKNOWN']);
    expect([1, 2, 99].map(parseHuaweiAcStatus)).toEqual(['UP', 'DOWN', 'UNKNOWN']);
  });

  it('normalizes official PW status, state and working-state values', () => {
    expect([1, 2, 3, 4, 99].map(parseHuaweiPwStatus)).toEqual([
      'DOWN',
      'UP',
      'PLUG_OUT',
      'BACKUP',
      'UNKNOWN',
    ]);
    expect([1, 2, 99].map(parseHuaweiPwState)).toEqual(['DOWN', 'UP', 'UNKNOWN']);
    expect([1, 2, 99].map(parseHuaweiPwWorkingState)).toEqual(['MASTER', 'BACKUP', 'UNKNOWN']);
  });

  it('normalizes validated VC encapsulation values without exposing raw integers', () => {
    expect(parseHuaweiVcType(4)).toBe('VLAN');
    expect(parseHuaweiVcType(5)).toBe('ETHERNET');
    expect(parseHuaweiVcType(64)).toBe('IP_INTERWORKING');
    expect(parseHuaweiVcType(999)).toBe('UNKNOWN');
  });
});
