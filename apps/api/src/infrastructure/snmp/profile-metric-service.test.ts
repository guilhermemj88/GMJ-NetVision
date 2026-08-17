import { describe, expect, it, vi } from 'vitest';
import { SnmpProfileMetricService } from './profile-metric-service';
import { HUAWEI_ENTITY_CPU_USAGE_OID, HUAWEI_ENTITY_NAME_OID } from './profiles/huawei/generic';
import { HUAWEI_AVG_CPU_1MIN_OID } from './profiles/huawei/ne8000';

const options = { community: 'secret', version: 'v2c' as const, port: 161 };

describe('SnmpProfileMetricService', () => {
  it('selects the preferred MPU entity instead of the first table row', async () => {
    const client = { walk: vi.fn(async (_host: string, oid: string) => {
      if (oid === HUAWEI_ENTITY_CPU_USAGE_OID) return [
        { oid: `${oid}.10`, value: 81 },
        { oid: `${oid}.20`, value: 32 },
      ];
      if (oid === HUAWEI_ENTITY_NAME_OID) return [
        { oid: `${oid}.10`, value: 'LPU 1' },
        { oid: `${oid}.20`, value: 'MPU 0' },
      ];
      return [];
    }) };
    const result = await new SnmpProfileMetricService(client).collect(
      'device-1', '10.0.0.1', options, { model: 'NE8000 F1A', vendor: 'Huawei' },
    );
    expect(result.cpuPercent).toBe(32);
    expect(result.diagnostic.metrics.cpu?.selectedOid).toBe(HUAWEI_ENTITY_CPU_USAGE_OID);
  });

  it('falls back when a candidate is invalid and accepts one unambiguous CPU row', async () => {
    const client = { walk: vi.fn(async (_host: string, oid: string) => {
      if (oid === HUAWEI_ENTITY_CPU_USAGE_OID) return [{ oid: `${oid}.20`, value: 255 }];
      if (oid === HUAWEI_ENTITY_NAME_OID) return [{ oid: `${oid}.20`, value: 'MPU 0' }];
      if (oid === HUAWEI_AVG_CPU_1MIN_OID) return [{ oid: `${oid}.0.0.0`, value: 41 }];
      return [];
    }) };
    const result = await new SnmpProfileMetricService(client).collect(
      'device-1', '10.0.0.1', options, { model: 'NE8000 F1A', vendor: 'Huawei' },
    );
    expect(result.cpuPercent).toBe(41);
    expect(result.diagnostic.metrics.cpu?.attempts.map((attempt) => attempt.status)).toEqual([
      'INVALID_VALUE', 'SELECTED',
    ]);
  });

  it('does not select the first row when a candidate has multiple ambiguous values', async () => {
    const client = { walk: vi.fn(async (_host: string, oid: string) => oid === HUAWEI_AVG_CPU_1MIN_OID
      ? [{ oid: `${oid}.0.0.0`, value: 20 }, { oid: `${oid}.0.1.0`, value: 70 }]
      : []) };
    const result = await new SnmpProfileMetricService(client).collect(
      'device-1', '10.0.0.1', options, { model: 'NE8000 F1A', vendor: 'Huawei' },
    );
    expect(result.cpuPercent).toBeUndefined();
    expect(result.diagnostic.metrics.cpu?.attempts.at(-1)?.status).toBe('AMBIGUOUS');
  });
});
