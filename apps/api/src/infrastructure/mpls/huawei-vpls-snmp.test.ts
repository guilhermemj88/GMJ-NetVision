import { describe, expect, it } from 'vitest';
import type { SnmpClient, SnmpVarBind } from '../../domain/ports';
import {
  HUAWEI_VPLS_AC_COLUMNS,
  HUAWEI_VPLS_AC_ENTRY_OID,
  HUAWEI_VPLS_AC_WALK_COLUMNS,
  HUAWEI_VPLS_PW_COLUMNS,
  HUAWEI_VPLS_PW_ENTRY_OID,
  HUAWEI_VPLS_PW_WALK_COLUMNS,
  HUAWEI_VPLS_VSI_COLUMNS,
  HUAWEI_VPLS_VSI_ENTRY_OID,
  HUAWEI_VPLS_VSI_WALK_COLUMNS,
} from './huawei-vpls-oids';
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

function fixtureClient(rows: SnmpVarBind[], walkedOids: string[] = []): SnmpClient {
  return {
    get: async () => [],
    walk: async (_host, oid) => {
      walkedOids.push(oid);
      return rows.filter((item) => item.oid.startsWith(`${oid}.`));
    },
  };
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
    const walkedOids: string[] = [];
    const result = await new HuaweiVplsSnmpCollector(
      fixtureClient([...vsiRows, ...pwRows], walkedOids),
    ).collect('10.100.101.8', {});

    expect(result.supported).toBe(true);
    expect(result.capabilities).toEqual({ vsi: true, ac: false, pw: true });
    expect(result.errors).toEqual([]);
    expect(result.vsis).toHaveLength(1);
    expect(result.vsis[0]?.name).toBe('GERENCIA');
    expect(result.vsis[0]?.pws.map((pw) => pw.remoteIp)).toEqual(peerIps);
    expect(result.vsis[0]?.pws.find((pw) => pw.remoteIp === '10.100.101.3')).toMatchObject({
      inboundLabel: 36323,
      outboundLabel: 35937,
    });
    expect(result.vsis[0]?.status).toBe('UP');
    expect(walkedOids).not.toContain(HUAWEI_VPLS_VSI_ENTRY_OID);
    expect(walkedOids).not.toContain(HUAWEI_VPLS_PW_ENTRY_OID);
    expect(walkedOids).not.toContain(HUAWEI_VPLS_AC_ENTRY_OID);
  });

  it('marks a VSI degraded only when a valid PW row is down', async () => {
    const vsiIndex = index('L2L_GM_163');
    const rows = [
      row(HUAWEI_VPLS_VSI_ENTRY_OID, 6, vsiIndex, 1),
      row(HUAWEI_VPLS_VSI_ENTRY_OID, 33, vsiIndex, 1),
      row(HUAWEI_VPLS_PW_ENTRY_OID, 8, `${vsiIndex}.4.10.100.101.3`, 1),
    ];
    const result = await new HuaweiVplsSnmpCollector(fixtureClient(rows)).collect('host', {});
    expect(result.vsis[0]?.status).toBe('DEGRADED');
  });

  it('keeps a partial collection when one PW column fails', async () => {
    const vsiIndex = index('GERENCIA');
    const pwSuffix = `${vsiIndex}.7.10.100.101.3`;
    const rows = [
      row(HUAWEI_VPLS_VSI_ENTRY_OID, HUAWEI_VPLS_VSI_COLUMNS.operationalStatus, vsiIndex, 1),
      row(HUAWEI_VPLS_VSI_ENTRY_OID, HUAWEI_VPLS_VSI_COLUMNS.adminStatus, vsiIndex, 1),
      row(HUAWEI_VPLS_PW_ENTRY_OID, HUAWEI_VPLS_PW_COLUMNS.inboundLabel, pwSuffix, 36323),
      row(HUAWEI_VPLS_PW_ENTRY_OID, HUAWEI_VPLS_PW_COLUMNS.state, pwSuffix, 2),
    ];
    const client = fixtureClient(rows);
    const originalWalk = client.walk.bind(client);
    client.walk = async (host, oid, options) => {
      if (oid === `${HUAWEI_VPLS_PW_ENTRY_OID}.${HUAWEI_VPLS_PW_COLUMNS.status}`) {
        throw new Error('SNMP timeout');
      }
      return originalWalk(host, oid, options);
    };

    const result = await new HuaweiVplsSnmpCollector(client).collect('host', {});

    expect(result.supported).toBe(true);
    expect(result.errors).toEqual(['PW .8: SNMP timeout']);
    expect(result.collectedColumns.pw).not.toContain(HUAWEI_VPLS_PW_COLUMNS.status);
    expect(result.vsis[0]?.pws[0]).toMatchObject({
      pwId: 7,
      remoteIp: '10.100.101.3',
      inboundLabel: 36323,
      status: 'UNKNOWN',
      statusObserved: false,
    });
    expect(result.vsis[0]?.status).toBe('UNKNOWN');
  });

  it('keeps an operationally UP VSI as UP when the PW capability is absent', async () => {
    const vsiIndex = index('GERENCIA');
    const rows = [
      row(HUAWEI_VPLS_VSI_ENTRY_OID, HUAWEI_VPLS_VSI_COLUMNS.operationalStatus, vsiIndex, 1),
      row(HUAWEI_VPLS_VSI_ENTRY_OID, HUAWEI_VPLS_VSI_COLUMNS.adminStatus, vsiIndex, 1),
    ];

    const result = await new HuaweiVplsSnmpCollector(fixtureClient(rows)).collect('host', {});

    expect(result.capabilities).toEqual({ vsi: true, ac: false, pw: false });
    expect(result.vsis[0]).toMatchObject({
      name: 'GERENCIA',
      operationalStatus: 'UP',
      status: 'UP',
      statusComplete: true,
      pws: [],
    });
  });

  it('collects AC independently and preserves raw time values from its indexed columns', async () => {
    const vsiIndex = index('GERENCIA');
    const acSuffix = `${vsiIndex}.43`;
    const rows = [
      row(HUAWEI_VPLS_VSI_ENTRY_OID, HUAWEI_VPLS_VSI_COLUMNS.operationalStatus, vsiIndex, 1),
      row(HUAWEI_VPLS_AC_ENTRY_OID, HUAWEI_VPLS_AC_COLUMNS.status, acSuffix, 1),
      row(
        HUAWEI_VPLS_AC_ENTRY_OID,
        HUAWEI_VPLS_AC_COLUMNS.upStartTime,
        acSuffix,
        '2025/09/17 20:49:53',
      ),
      row(HUAWEI_VPLS_AC_ENTRY_OID, HUAWEI_VPLS_AC_COLUMNS.upSumTime, acSuffix, 29537970),
    ];

    const result = await new HuaweiVplsSnmpCollector(fixtureClient(rows)).collect('host', {});

    expect(result.capabilities).toEqual({ vsi: true, ac: true, pw: false });
    expect(result.vsis[0]?.status).toBe('UP');
    expect(result.vsis[0]?.acs[0]).toMatchObject({
      vsiName: 'GERENCIA',
      ifIndex: 43,
      status: 'UP',
      upStartTimeRaw: '2025/09/17 20:49:53',
      upSumTimeRaw: 29537970n,
    });
  });

  it('does not invalidate a VSI when AC or PW walks fail', async () => {
    const vsiIndex = index('GERENCIA');
    const rows = [
      row(HUAWEI_VPLS_VSI_ENTRY_OID, HUAWEI_VPLS_VSI_COLUMNS.operationalStatus, vsiIndex, 1),
    ];
    const baseClient = fixtureClient(rows);
    const originalWalk = baseClient.walk.bind(baseClient);
    baseClient.walk = async (host, oid, options) => {
      if (
        oid.startsWith(`${HUAWEI_VPLS_AC_ENTRY_OID}.`) ||
        oid.startsWith(`${HUAWEI_VPLS_PW_ENTRY_OID}.`)
      ) {
        throw new Error('SNMP timeout');
      }
      return originalWalk(host, oid, options);
    };

    const result = await new HuaweiVplsSnmpCollector(baseClient).collect('host', {});

    expect(result.supported).toBe(true);
    expect(result.capabilities).toEqual({ vsi: true, ac: null, pw: null });
    expect(result.vsis[0]).toMatchObject({ status: 'UP', statusComplete: false });
    expect(result.errors.some((error) => error.startsWith('AC .'))).toBe(true);
    expect(result.errors.some((error) => error.startsWith('PW .'))).toBe(true);
  });

  it('collects a tree with more than 4096 objects without exceeding the limit in any walk', async () => {
    const vsiIndex = index('MASSIVE_MULTIPOINT');
    const vsiRows = HUAWEI_VPLS_VSI_WALK_COLUMNS.map((column) =>
      row(
        HUAWEI_VPLS_VSI_ENTRY_OID,
        column,
        vsiIndex,
        column === HUAWEI_VPLS_VSI_COLUMNS.rd
          ? '65000:1'
          : column === HUAWEI_VPLS_VSI_COLUMNS.mtu
            ? 1500
            : 1,
      ),
    );
    const pwRows = Array.from({ length: 600 }, (_, position) => {
      const pwId = position + 1;
      const remoteIp = `10.0.${Math.floor(position / 256)}.${position % 256}`;
      const suffix = `${vsiIndex}.${pwId}.${remoteIp}`;
      return HUAWEI_VPLS_PW_WALK_COLUMNS.map((column) =>
        row(
          HUAWEI_VPLS_PW_ENTRY_OID,
          column,
          suffix,
          column === HUAWEI_VPLS_PW_COLUMNS.tunnelPolicy
            ? 'LDP'
            : column === HUAWEI_VPLS_PW_COLUMNS.inboundLabel ||
                column === HUAWEI_VPLS_PW_COLUMNS.outboundLabel
              ? 10_000 + pwId
              : column === HUAWEI_VPLS_PW_COLUMNS.upSumTime
                ? 3600
                : column === HUAWEI_VPLS_PW_COLUMNS.upStartTime
                  ? 0
                  : 2,
        ),
      );
    }).flat();
    const allRows = [...vsiRows, ...pwRows];
    const walkedOids: string[] = [];
    const walkSizes: number[] = [];
    const client: SnmpClient = {
      get: async () => [],
      walk: async (_host, oid) => {
        walkedOids.push(oid);
        const matchingRows = allRows.filter((item) => item.oid.startsWith(`${oid}.`));
        walkSizes.push(matchingRows.length);
        if (matchingRows.length >= 4096) throw new Error('SNMP walk exceeded safety limit');
        return matchingRows;
      },
    };

    expect(allRows.length).toBeGreaterThan(4096);
    const result = await new HuaweiVplsSnmpCollector(client).collect('host', {});

    expect(result.supported).toBe(true);
    expect(result.vsis).toHaveLength(1);
    expect(result.vsis[0]?.pws).toHaveLength(600);
    expect(Math.max(...walkSizes)).toBe(600);
    expect(walkedOids).toHaveLength(
      HUAWEI_VPLS_VSI_WALK_COLUMNS.length +
        HUAWEI_VPLS_AC_WALK_COLUMNS.length +
        HUAWEI_VPLS_PW_WALK_COLUMNS.length,
    );
    expect(walkedOids).not.toContain(HUAWEI_VPLS_VSI_ENTRY_OID);
    expect(walkedOids).not.toContain(HUAWEI_VPLS_PW_ENTRY_OID);
    expect(walkedOids).not.toContain(HUAWEI_VPLS_AC_ENTRY_OID);
  });

  it('detects capability from valid VSI entries, not model metadata', async () => {
    const walkedOids: string[] = [];
    const result = await new HuaweiVplsSnmpCollector(fixtureClient([], walkedOids)).collect(
      'host',
      {},
    );
    expect(result).toMatchObject({ supported: false, errors: [], vsis: [] });
    expect(walkedOids).toHaveLength(HUAWEI_VPLS_VSI_WALK_COLUMNS.length);
    expect(walkedOids.every((oid) => oid.startsWith(`${HUAWEI_VPLS_VSI_ENTRY_OID}.`))).toBe(true);
  });

  it('reports collection failure when VSI capability cannot be determined', async () => {
    const client: SnmpClient = {
      get: async () => [],
      walk: async () => {
        throw new Error('SNMP timeout');
      },
    };

    await expect(new HuaweiVplsSnmpCollector(client).collect('host', {})).rejects.toThrow(
      'Não foi possível confirmar a capability MPLS',
    );
  });
});
