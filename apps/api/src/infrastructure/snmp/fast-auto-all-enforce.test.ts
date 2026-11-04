import { describe, expect, it } from 'vitest';
import {
  describeAutoAllEligibility,
  listFastTrafficTargets,
  type FastTrafficSelectionDeps,
} from './fast-traffic-targets';
import { fastPollerConfig } from './fast-traffic-poller';
import type { MitigationProfileRecord } from '../bgp/mitigation/mitigation-repository';

const DEVICE = 'device-f1a';
const BW = 10_000_000_000n; // 10 Gbps contratados

function iface(id: string, ifIndex: number, name: string) {
  return { id, ifIndex, name, speedBps: '300000000000' };
}

interface ProfileOverrides {
  id?: string;
  mode?: 'AUTO' | 'MANUAL' | 'HOLD' | 'ALERT_ONLY';
  enabled?: boolean;
  addressFamily?: 'IPV4' | 'IPV6';
  mitigationExcluded?: boolean;
  deviceId?: string;
  interfaceId?: string | null;
  bandwidth?: bigint | null;
  triggerPercent?: number;
}

function profile(o: ProfileOverrides = {}): MitigationProfileRecord {
  return {
    id: o.id ?? 'p-1',
    deviceId: o.deviceId ?? DEVICE,
    mode: o.mode ?? 'AUTO',
    enabled: o.enabled ?? true,
    addressFamily: o.addressFamily ?? 'IPV4',
    mitigationExcluded: o.mitigationExcluded ?? false,
    interfaceId: o.interfaceId === undefined ? 'if-1' : o.interfaceId,
    detectedBandwidthBps: o.bandwidth === undefined ? BW : o.bandwidth,
    bandwidthOverrideBps: null,
    triggerPercent: o.triggerPercent ?? 90,
    customer: 'cliente',
    policyName: 'POLICY',
  } as unknown as MitigationProfileRecord;
}

function deps(
  profiles: MitigationProfileRecord[],
  options: Partial<FastTrafficSelectionDeps> = {},
): FastTrafficSelectionDeps {
  return {
    profileIds: [],
    autoAllEnforce: true,
    allowedDeviceIds: [DEVICE],
    listProfiles: async () => profiles,
    hosts: {
      getHost: async (id: string) =>
        id === DEVICE
          ? {
              snmpEnabled: true,
              snmp: { version: 'SNMP_V2C' },
              interfaces: [iface('if-1', 236, 'Eth-Trunk1.3058'), iface('if-2', 109, 'Eth-Trunk1.1000')],
            }
          : null,
    },
    direction: () => 'tx',
    ...options,
  } as FastTrafficSelectionDeps;
}

describe('AUTO-ALL ENFORCE: descoberta de escopo', () => {
  it('descobre todos os perfis AUTO elegiveis sem lista estatica', async () => {
    const profiles = Array.from({ length: 23 }, (_, i) =>
      profile({ id: `p-${i}`, interfaceId: i % 2 === 0 ? 'if-1' : 'if-2' }),
    );
    const targets = await listFastTrafficTargets(deps(profiles));
    // Duas interfaces agrupam os 23 perfis: nada e truncado em 3.
    expect(targets).toHaveLength(2);
    expect(targets.reduce((n, t) => n + t.profiles.length, 0)).toBe(23);
  });

  it('MANUAL, HOLD e ALERT_ONLY ficam fora do ENFORCE', async () => {
    const targets = await listFastTrafficTargets(
      deps([
        profile({ id: 'auto' }),
        profile({ id: 'manual', mode: 'MANUAL' }),
        profile({ id: 'hold', mode: 'HOLD' }),
        profile({ id: 'alert', mode: 'ALERT_ONLY' }),
      ]),
    );
    const ids = targets.flatMap((t) => t.profiles.map((p) => p.profileId));
    expect(ids).toEqual(['auto']);
  });

  it('compatibilidade: sem autoAllEnforce a lista explicita continua valendo', async () => {
    const profiles = [profile({ id: 'a' }), profile({ id: 'b' })];
    const explicit = await listFastTrafficTargets(
      deps(profiles, { autoAllEnforce: false, profileIds: ['a'] }),
    );
    expect(explicit.flatMap((t) => t.profiles.map((p) => p.profileId))).toEqual(['a']);
  });

  it('explica o motivo do bloqueio por cliente (codigos estaveis)', async () => {
    const rows = await describeAutoAllEligibility(
      deps([
        profile({ id: 'ok' }),
        profile({ id: 'desligado', enabled: false }),
        profile({ id: 'sem-dir' }),
        profile({ id: 'sem-banda', bandwidth: 0n }),
        profile({ id: 'excluido', mitigationExcluded: true }),
      ], {
        direction: (p) => (p.id === 'sem-dir' ? null : 'tx'),
      }),
    );
    const byId = new Map(rows.map((r) => [r.profileId, r]));
    expect(byId.get('ok')!.eligible).toBe(true);
    expect(byId.get('ok')!.reasons).toEqual([]);
    expect(byId.get('desligado')!.reasons).toContain('PROFILE_DISABLED');
    expect(byId.get('sem-dir')!.reasons).toContain('DIRECTION_UNRESOLVED');
    expect(byId.get('sem-banda')!.reasons).toContain('BANDWIDTH_UNKNOWN');
    expect(byId.get('excluido')!.reasons).toContain('MITIGATION_EXCLUDED');
  });

  it('device fora da allowlist e interface desconhecida bloqueiam', async () => {
    const rows = await describeAutoAllEligibility(
      deps([
        profile({ id: 'outro-device', deviceId: 'device-x' }),
        profile({ id: 'sem-interface', interfaceId: 'if-9' }),
      ]),
    );
    const byId = new Map(rows.map((r) => [r.profileId, r]));
    expect(byId.get('outro-device')!.reasons).toContain('DEVICE_NOT_ALLOWED');
    expect(byId.get('sem-interface')!.reasons).toContain('INTERFACE_UNKNOWN');
  });

  it('limiar usa a banda CONTRATADA, nao a capacidade fisica da interface', async () => {
    const [target] = await listFastTrafficTargets(deps([profile({ bandwidth: 10_000_000_000n })]));
    // 90% de 10 Gbps = 9 Gbps, e nao 90% de 300 Gbps.
    expect(target!.profiles[0]!.thresholdBps).toBe(9_000_000_000n);
  });

  it('isolamento: cada perfil carrega o proprio limiar e direcao', async () => {
    const [target] = await listFastTrafficTargets(
      deps([
        profile({ id: 'a', bandwidth: 1_000_000_000n, triggerPercent: 90 }),
        profile({ id: 'b', bandwidth: 4_000_000_000n, triggerPercent: 80 }),
      ], {
        direction: (p) => (p.id === 'a' ? 'tx' : 'rx'),
      }),
    );
    const a = target!.profiles.find((p) => p.profileId === 'a')!;
    const b = target!.profiles.find((p) => p.profileId === 'b')!;
    expect(a.thresholdBps).toBe(900_000_000n);
    expect(b.thresholdBps).toBe(3_200_000_000n);
    expect(a.direction).toBe('tx');
    expect(b.direction).toBe('rx');
  });
});

describe('AUTO-ALL ENFORCE: configuracao fail-closed', () => {
  it('exige modo ENFORCE', () => {
    expect(() =>
      fastPollerConfig({ MITIGATION_FAST_POLL_MODE: 'OBSERVE', MITIGATION_FAST_AUTO_ALL_ENFORCE_ENABLED: '1' }),
    ).toThrow('AUTO_ALL_ENFORCE_REQUIRES_ENFORCE');
  });

  it('nao aceita lista vazia sem AUTO-ALL nem flag de observacao', () => {
    expect(() => fastPollerConfig({ MITIGATION_FAST_POLL_MODE: 'ENFORCE' })).toThrow(
      'MITIGATION_FAST_PROFILE_IDS is required',
    );
  });

  it('AUTO-ALL dispensa lista estatica e mantem cadencia de 5 s', () => {
    const config = fastPollerConfig({
      MITIGATION_FAST_POLL_MODE: 'ENFORCE',
      MITIGATION_FAST_AUTO_ALL_ENFORCE_ENABLED: '1',
      MITIGATION_FAST_NORMAL_SECONDS: '5',
    });
    expect(config.autoAllEnforce).toBe(true);
    expect(config.profileIds).toEqual([]);
    expect(config.normalIntervalMs).toBe(5_000);
    expect(config.maxGapMs).toBe(15_000);
  });

  it('AUTO-ALL nao se mistura com observacao total', () => {
    expect(() =>
      fastPollerConfig({
        MITIGATION_FAST_POLL_MODE: 'OBSERVE',
        MITIGATION_FAST_ALL_IPV4_OBSERVATION_ENABLED: '1',
        MITIGATION_FAST_AUTO_ALL_ENFORCE_ENABLED: '1',
      }),
    ).toThrow('AUTO_ALL_ENFORCE_REQUIRES_ENFORCE');
  });
});
