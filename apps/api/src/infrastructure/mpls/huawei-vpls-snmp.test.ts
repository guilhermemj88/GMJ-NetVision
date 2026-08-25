import { describe, expect, it } from 'vitest';
import type { SnmpClient, SnmpVarBind } from '../../domain/ports';
import { HUAWEI_VPLS_PW_ENTRY_OID, HUAWEI_VPLS_VSI_ENTRY_OID } from './huawei-vpls-oids';
import { HuaweiVplsSnmpCollector } from './huawei-vpls-snmp';

function index(value: string): string {
  return [value.length, ...[...value].map((character) => character.charCodeAt(0))].join('.');
}

function row(
  base: string,
  column: number,
  suffix: string,
  value: SnmpVarBind['value'],
): SnmpVarBind {
  return { oid: `${base}.${column}.${suffix}`, value };
}

describe('HuaweiVplsSnmpCollector', () => {
  it('aggregates one VSI with every real peer instead of duplicating the VSI', async () => {
    const vsiIndex = index('GERENCIA');
    const peerIps = [
      '10.100.101.0',
      '10.100.101.3',
      '10.100.101.5',
      '10.100.101.11',
      '10.100.101.255',
    ];
    const vsiRows = [
      row(HUAWEI_VPLS_VSI_ENTRY_OID, 3, vsiIndex, '4.6424:99'),
      row(HUAWEI_VPLS_VSI_ENTRY_OID, 4, vsiIndex, 99),
      row(HUAWEI_VPLS_VSI_ENTRY_OID, 6, vsiIndex, 1),
      row(HUAWEI_VPLS_VSI_ENTRY_OID, 7, vsiIndex, 1500),
      row(HUAWEI_VPLS_VSI_ENTRY_OID, 33, vsiIndex, 1),
    ];
    const pwRows = peerIps.flatMap((remoteIp, position) => {
      const suffix = `${vsiIndex}.${position + 1}.${remoteIp}`;
      return [
        row(HUAWEI_VPLS_PW_ENTRY_OID, 6, suffix, remoteIp.endsWith('.3') ? 36323 : 1000 + position),
        row(HUAWEI_VPLS_PW_ENTRY_OID, 7, suffix, remoteIp.endsWith('.3') ? 35937 : 2000 + position),
        row(HUAWEI_VPLS_PW_ENTRY_OID, 8, suffix, 2),
        row(HUAWEI_VPLS_PW_ENTRY_OID, 13, suffix, 2),
        row(HUAWEI_VPLS_PW_ENTRY_OID, 14, suffix, 1),
      ];
    });
    const client: SnmpClient = {
      get: async () => [],
      walk: async (_host, oid) => (oid === HUAWEI_VPLS_VSI_ENTRY_OID ? vsiRows : pwRows),
    };

    const result = await new HuaweiVplsSnmpCollector(client).collect('10.100.101.8', {});

    expect(result.supported).toBe(true);
    expect(result.vsis).toHaveLength(1);
    expect(result.vsis[0]?.name).toBe('GERENCIA');
    expect(result.vsis[0]?.pws.map((pw) => pw.remoteIp)).toEqual(peerIps);
    expect(result.vsis[0]?.pws.find((pw) => pw.remoteIp === '10.100.101.3')).toMatchObject({
      inboundLabel: 36323,
      outboundLabel: 35937,
    });
    expect(result.vsis[0]?.status).toBe('UP');
  });

  it('marks a VSI degraded only when a valid PW row is down', async () => {
    const vsiIndex = index('L2L_GM_163');
    const client: SnmpClient = {
      get: async () => [],
      walk: async (_host, oid) =>
        oid === HUAWEI_VPLS_VSI_ENTRY_OID
          ? [
              row(HUAWEI_VPLS_VSI_ENTRY_OID, 6, vsiIndex, 1),
              row(HUAWEI_VPLS_VSI_ENTRY_OID, 33, vsiIndex, 1),
            ]
          : [row(HUAWEI_VPLS_PW_ENTRY_OID, 8, `${vsiIndex}.4.10.100.101.3`, 1)],
    };
    const result = await new HuaweiVplsSnmpCollector(client).collect('host', {});
    expect(result.vsis[0]?.status).toBe('DEGRADED');
  });

  it('detects capability from valid VSI entries, not model metadata', async () => {
    const client: SnmpClient = { get: async () => [], walk: async () => [] };
    const result = await new HuaweiVplsSnmpCollector(client).collect('host', {});
    expect(result).toMatchObject({ supported: false, vsis: [] });
  });
});
