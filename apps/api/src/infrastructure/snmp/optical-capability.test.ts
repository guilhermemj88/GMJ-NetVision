import { describe, expect, it, vi } from 'vitest';
import type { SnmpVarBind } from '../../domain/ports';
import {
  HuaweiOpticalCapabilityProbe,
  opticalWalkPlan,
  type OpticalCapabilityProbeClient,
  type OpticalCapabilitySnapshot,
} from './optical-capability';
import {
  UNSUPPORTED_HUAWEI_OPTICAL_CAPABILITY,
  huaweiOpticalCapability,
} from '../topology/huawei-optical';

const F1A_CAPABILITY = huaweiOpticalCapability({
  scalarEncoding: 'CENTI_DBM',
  scalarSemantics: 'AGGREGATED_LANES',
  laneEncoding: 'INT_CENTI_DBM',
  laneBiasEncoding: 'UNSUPPORTED',
  alarmThresholdEncoding: 'CENTI_DBM',
  warningThresholdEncoding: 'CENTI_DBM',
  minMaxEncoding: 'CENTI_DBM',
});

const S6730_CAPABILITY = huaweiOpticalCapability({
  scalarEncoding: 'MICRO_WATTS',
  scalarSemantics: 'LANE_0',
  laneEncoding: 'DECIMAL_CENTI_DBM',
  laneBiasEncoding: 'DECIMAL_MA',
  alarmThresholdEncoding: 'CENTI_DBM',
  warningThresholdEncoding: 'CENTI_DBM',
  minMaxEncoding: 'UNSUPPORTED',
});

const OIDS = {
  scalar: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.8',
  warnings: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.20',
  laneBias: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.31',
  lanes: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.32',
  minMax: '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.38',
  witness: '1.3.6.1.4.1.2011.5.25.31.1.1.1.1.1',
} as const;

function probeInput(overrides: Partial<Parameters<HuaweiOpticalCapabilityProbe['capabilityFor']>[0]> = {}) {
  return {
    deviceId: 'dev-1',
    host: '10.0.0.1',
    port: 161,
    community: 'secret',
    fingerprint: 'huawei-ne8000|1.3.6.1.4.1.2011.2.360.1.5',
    expectsOpticalTable: true,
    profile: F1A_CAPABILITY,
    ...overrides,
  };
}

function mockClient(
  behavior: (oid: string, call: number) => SnmpVarBind[] | Error,
): OpticalCapabilityProbeClient & { walk: ReturnType<typeof vi.fn> } {
  let call = 0;
  const client = {
    walk: vi.fn(async (_host: string, oid: string): Promise<SnmpVarBind[]> => {
      call += 1;
      const result = behavior(oid, call);
      if (result instanceof Error) throw result;
      return result;
    }),
  };
  return client as unknown as OpticalCapabilityProbeClient & { walk: ReturnType<typeof vi.fn> };
}

describe('HuaweiOpticalCapabilityProbe (READ-ONLY, cacheada)', () => {
  it('SUPPORTED: confirma colunas reais do equipamento e cacheia por TTL', async () => {
    const client = mockClient((oid) => {
      if (oid === OIDS.scalar) return [{ oid: `${oid}.1`, value: 601 }];
      if (oid === OIDS.warnings) return [{ oid: `${oid}.1`, value: -1030 }];
      if (oid === OIDS.laneBias) return [{ oid: `${oid}.1`, value: '42.76' }];
      if (oid === OIDS.lanes) return [{ oid: `${oid}.1`, value: '29,-33,-14,14' }];
      return [];
    });
    const probe = new HuaweiOpticalCapabilityProbe(client);

    const first = await probe.capabilityFor(probeInput());
    expect(first).toMatchObject({
      state: 'SUPPORTED',
      table: true,
      scalarPower: true,
      alarmThresholds: true,
      warnings: true,
      laneBias: true,
      lanes: true,
      minMax: false,
    });
    const callsAfterFirst = client.walk.mock.calls.length;
    // Segunda chamada dentro do TTL nao dispara SNMP.
    const second = await probe.capabilityFor(probeInput());
    expect(second).toEqual(first);
    expect(client.walk.mock.calls.length).toBe(callsAfterFirst);
    expect(probe.getCached('dev-1')).toEqual(first);
  });

  it('mudanca de fingerprint (profile/versao) invalida o cache', async () => {
    const client = mockClient((oid) =>
      (oid === OIDS.scalar ? [{ oid: `${oid}.1`, value: 601 }] : []));
    const probe = new HuaweiOpticalCapabilityProbe(client);
    await probe.capabilityFor(probeInput());
    const calls = client.walk.mock.calls.length;
    await probe.capabilityFor(probeInput({ fingerprint: 'huawei-ne8000|v2' }));
    expect(client.walk.mock.calls.length).toBeGreaterThan(calls);
  });

  it('invalidate() forca nova sonda (usado no rediscovery)', async () => {
    const client = mockClient((oid) =>
      (oid === OIDS.scalar ? [{ oid: `${oid}.1`, value: 601 }] : []));
    const probe = new HuaweiOpticalCapabilityProbe(client);
    await probe.capabilityFor(probeInput());
    const calls = client.walk.mock.calls.length;
    probe.invalidate('dev-1');
    expect(probe.getCached('dev-1')).toBeNull();
    await probe.capabilityFor(probeInput());
    expect(client.walk.mock.calls.length).toBeGreaterThan(calls);
  });

  it('tabela vazia com profile esperando a MIB = RESTRICTED_VIEW (virtual-system)', async () => {
    const client = mockClient((oid) =>
      (oid === OIDS.witness ? [{ oid: `${oid}.1`, value: 1 }] : []));
    const probe = new HuaweiOpticalCapabilityProbe(client);
    const snapshot = await probe.capabilityFor(probeInput());
    expect(snapshot).toMatchObject({
      state: 'RESTRICTED_VIEW',
      table: false,
      scalarPower: false,
      warnings: false,
      laneBias: false,
      lanes: false,
      minMax: false,
    });
  });

  it('tabela vazia com profile sem optica = UNSUPPORTED (MA5800)', async () => {
    const client = mockClient(() => []);
    const probe = new HuaweiOpticalCapabilityProbe(client);
    const snapshot = await probe.capabilityFor(probeInput({
      deviceId: 'olt-1',
      expectsOpticalTable: false,
      profile: UNSUPPORTED_HUAWEI_OPTICAL_CAPABILITY,
    }));
    expect(snapshot.state).toBe('UNSUPPORTED');
    expect(snapshot.table).toBe(false);
  });

  it('falha total da sonda = UNKNOWN e NAO cacheia (default do profile no ciclo)', async () => {
    const client = mockClient(() => new Error('timeout'));
    const probe = new HuaweiOpticalCapabilityProbe(client);
    const snapshot = await probe.capabilityFor(probeInput());
    expect(snapshot.state).toBe('UNKNOWN');
    expect(probe.getCached('dev-1')).toBeNull();
    await probe.capabilityFor(probeInput());
    // Uma tentativa por chamada (nada e cacheado em UNKNOWN).
    expect(client.walk.mock.calls.length).toBe(2);
  });

  it('falha em UMA coluna usa o default do profile e nao cacheia o resultado', async () => {
    const client = mockClient((oid) => {
      if (oid === OIDS.scalar) return [{ oid: `${oid}.1`, value: 601 }];
      if (oid === OIDS.warnings) return new Error('one column timeout');
      if (oid === OIDS.laneBias) return [{ oid: `${oid}.1`, value: '42.76' }];
      return [];
    });
    const probe = new HuaweiOpticalCapabilityProbe(client);
    const snapshot = await probe.capabilityFor(probeInput({ profile: S6730_CAPABILITY }));
    // WARNING caiu no default do profile; as colunas que responderam seguem reais.
    expect(snapshot.warnings).toBe(true);
    expect(snapshot.lanes).toBe(false);
    expect(probe.getCached('dev-1')).toBeNull();
  });
});

describe('opticalWalkPlan (profile default + probe)', () => {
  const supported = (overrides: Partial<OpticalCapabilitySnapshot> = {}): OpticalCapabilitySnapshot => ({
    state: 'SUPPORTED',
    table: true,
    scalarPower: true,
    alarmThresholds: true,
    warnings: true,
    laneBias: false,
    lanes: true,
    minMax: true,
    checkedAt: new Date().toISOString(),
    ...overrides,
  });

  it('F1A: usa o que a sonda confirmou (sem bias, com warnings)', () => {
    expect(opticalWalkPlan(F1A_CAPABILITY, supported())).toEqual({
      table: true,
      scalarPower: true,
      alarmThresholds: true,
      warnings: true,
      laneBias: false,
      lanes: true,
    });
  });

  it('WARNING exige profile E sonda (nunca so um dos dois)', () => {
    expect(opticalWalkPlan(F1A_CAPABILITY, supported({ warnings: false })).warnings).toBe(false);
    expect(opticalWalkPlan(F1A_CAPABILITY, supported({ warnings: true })).warnings).toBe(true);
    // Profile sem warning (S6750) nao liga o walk nem se a sonda achar a coluna.
    const s6750 = huaweiOpticalCapability({
      scalarEncoding: 'CENTI_DBM',
      scalarSemantics: 'LANE_0',
      laneEncoding: 'DECIMAL_DBM',
      laneBiasEncoding: 'DECIMAL_MA',
      alarmThresholdEncoding: 'CENTI_DBM',
      warningThresholdEncoding: 'UNSUPPORTED',
      minMaxEncoding: 'UNSUPPORTED',
    });
    expect(opticalWalkPlan(s6750, supported({ warnings: true })).warnings).toBe(false);
  });

  it('UNKNOWN cai no default do profile (sonda nao derruba o poll)', () => {
    const unknown: OpticalCapabilitySnapshot = {
      state: 'UNKNOWN',
      table: false,
      scalarPower: false,
      alarmThresholds: false,
      warnings: false,
      laneBias: false,
      lanes: false,
      minMax: false,
      checkedAt: new Date().toISOString(),
    };
    expect(opticalWalkPlan(F1A_CAPABILITY, unknown)).toMatchObject({
      table: true,
      scalarPower: true,
      warnings: true,
      lanes: true,
    });
    expect(opticalWalkPlan(UNSUPPORTED_HUAWEI_OPTICAL_CAPABILITY, unknown)).toMatchObject({
      table: false,
      lanes: false,
      warnings: false,
    });
  });

  it('MA5800: sem tabela nao planeja nenhum walk', () => {
    expect(opticalWalkPlan(UNSUPPORTED_HUAWEI_OPTICAL_CAPABILITY, supported())).toEqual({
      table: false,
      scalarPower: false,
      alarmThresholds: false,
      warnings: false,
      laneBias: false,
      lanes: false,
    });
  });
});
