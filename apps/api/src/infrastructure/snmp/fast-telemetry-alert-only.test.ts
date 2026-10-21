import { describe, expect, it, vi } from 'vitest';
import { InMemoryMitigationRepository } from '../bgp/mitigation/in-memory-mitigation-repository';
import type { MitigationProfileRecord } from '../bgp/mitigation/mitigation-repository';
import {
  MitigationAutoEngine,
  type MitigationAutoTargetState,
} from '../../worker/mitigation/mitigation-auto-engine';
import { SequenceTrafficSource } from '../../worker/mitigation/mitigation-traffic-source';
import { FastTrafficPoller, fastPollerConfig } from './fast-traffic-poller';
import { listFastTrafficTargets } from './fast-traffic-targets';

// FAST + ALERT_ONLY (RC7): coletar, rotear telemetria e autorizar mitigação são
// decisões SEPARADAS. Um perfil ALERT_ONLY selecionado explicitamente para
// telemetria recebe amostras de 10 s e passa por TODOS os gates de amostra —
// sem nunca emitir ACTIVATE/REMOVE. Nenhum teste aqui abre socket ou toca BGP.

const DEVICE = 'host-f1a';
const BW = 10_000_000_000n;
const NOW = new Date('2026-10-21T00:00:00.000Z');

const hosts = {
  async getHost(id: string) {
    return {
      id,
      snmpEnabled: true,
      snmp: { version: 'SNMP_V2C', host: '10.0.0.1', port: 161 },
      interfaces: [
        { id: 'if-1', name: 'Eth-Trunk1.2519', ifIndex: 287, speedBps: BW },
      ],
    };
  },
  async getDecryptedSnmpCredentials() {
    return { community: 'public' };
  },
};

function profile(
  over: Partial<MitigationProfileRecord> & { id: string },
): MitigationProfileRecord {
  return {
    deviceId: DEVICE,
    interfaceId: 'if-1',
    addressFamily: 'IPV4',
    detectedBandwidthBps: BW,
    bandwidthSource: 'DESCRIPTION',
    mode: 'ALERT_ONLY',
    enabled: true,
    mitigationExcluded: false,
    autoTrafficDirection: null,
    triggerPercent: 90,
    ...over,
  } as unknown as MitigationProfileRecord;
}

const targetsFor = (profiles: MitigationProfileRecord[], options: {
  profileIds: string[];
  telemetryProfileIds?: string[];
  direction?: (p: MitigationProfileRecord) => 'rx' | 'tx' | null;
}) =>
  listFastTrafficTargets({
    profileIds: options.profileIds,
    ...(options.telemetryProfileIds ? { telemetryProfileIds: options.telemetryProfileIds } : {}),
    allowedDeviceIds: [DEVICE],
    listProfiles: async () => profiles,
    hosts,
    direction: options.direction ?? (() => 'tx'),
  });

describe('seleção de telemetria FAST independente do modo', () => {
  it('ALERT_ONLY na lista explícita é coletado sem ser promovido', async () => {
    const p = profile({ id: 'p-alert' });
    const targets = await targetsFor([p], {
      profileIds: ['p-alert'],
      telemetryProfileIds: ['p-alert'],
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ interfaceId: 'if-1', ifIndex: 287 });
    expect(targets[0]!.profiles).toEqual([
      { profileId: 'p-alert', direction: 'tx', bandwidthBps: BW, thresholdBps: (BW * 90n) / 100n },
    ]);
    expect(p.mode).toBe('ALERT_ONLY');
  });

  it('ALERT_ONLY fora da lista explícita mantém o comportamento legado (não coleta)', async () => {
    const targets = await targetsFor([profile({ id: 'p-alert' })], { profileIds: ['p-alert'] });
    expect(targets).toEqual([]);
  });

  it('AUTO continua sendo coletado sem lista explícita (legado preservado)', async () => {
    const targets = await targetsFor([profile({ id: 'p-auto', mode: 'AUTO' })], {
      profileIds: ['p-auto'],
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]!.profiles[0]!.profileId).toBe('p-auto');
  });

  it('perfil roteado sem direção efetiva não é coletado (fail-closed)', async () => {
    const targets = await targetsFor([profile({ id: 'p-alert' })], {
      profileIds: ['p-alert'],
      telemetryProfileIds: ['p-alert'],
      direction: () => null,
    });
    expect(targets).toEqual([]);
  });

  it('IPv6 roteado permanece fora desta fase', async () => {
    const targets = await targetsFor([profile({ id: 'p-v6', addressFamily: 'IPV6' })], {
      profileIds: ['p-v6'],
      telemetryProfileIds: ['p-v6'],
    });
    expect(targets).toEqual([]);
  });

  it('exclusão, desabilitado e device fora da allowlist continuam bloqueando a coleta', async () => {
    const blocked = [
      profile({ id: 'p-excluded', mitigationExcluded: true }),
      profile({ id: 'p-disabled', enabled: false }),
      profile({ id: 'p-other-device', deviceId: 'host-outro' }),
    ];
    const targets = await targetsFor(blocked, {
      profileIds: blocked.map((p) => p.id),
      telemetryProfileIds: blocked.map((p) => p.id),
    });
    expect(targets).toEqual([]);
  });

  it('duas famílias na MESMA interface geram um único alvo (dedupe por ifIndex)', async () => {
    const targets = await targetsFor(
      [profile({ id: 'p-v4' }), profile({ id: 'p-v6-irmão', addressFamily: 'IPV6' })],
      { profileIds: ['p-v4', 'p-v6-irmão'], telemetryProfileIds: ['p-v4'] },
    );
    expect(targets).toHaveLength(1);
    expect(targets[0]!.profiles.map((p) => p.profileId)).toEqual(['p-v4']);
  });
});

describe('configuração do coletor', () => {
  it('expõe a lista explícita e a união sem duplicar ids', () => {
    const config = fastPollerConfig({
      MITIGATION_FAST_POLL_MODE: 'OBSERVE',
      MITIGATION_FAST_PROFILE_IDS: 'p-auto',
      MITIGATION_FAST_ROUTED_PROFILE_IDS: 'p-auto, p-alert',
    });
    expect(config.telemetryProfileIds).toEqual(['p-auto', 'p-alert']);
    expect(config.profileIds).toEqual(['p-auto', 'p-alert']);
  });

  it('sem lista explícita, apenas o escopo legado é observado', () => {
    const config = fastPollerConfig({
      MITIGATION_FAST_POLL_MODE: 'OBSERVE',
      MITIGATION_FAST_PROFILE_IDS: 'p-auto',
    });
    expect(config.telemetryProfileIds).toEqual([]);
    expect(config.profileIds).toEqual(['p-auto']);
  });

  it('aceita apenas roteados como escopo de coleta', () => {
    const config = fastPollerConfig({
      MITIGATION_FAST_POLL_MODE: 'OBSERVE',
      MITIGATION_FAST_ROUTED_PROFILE_IDS: 'p-alert',
    });
    expect(config.profileIds).toEqual(['p-alert']);
  });
});

describe('teto de interfaces por device', () => {
  const pollerConfig = (maxInterfacesPerDevice: number) => ({
    mode: 'OBSERVE' as const,
    profileIds: [],
    telemetryProfileIds: [],
    normalIntervalMs: 10_000,
    suspectIntervalMs: 10_000,
    maxGapMs: 45_000,
    timeoutMs: 1500,
    retries: 0,
    concurrency: 1,
    maxInterfacesPerDevice,
  });
  const manyTargets = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      deviceId: DEVICE,
      interfaceId: `if-${index}`,
      ifIndex: 300 + index,
      interfaceName: `Eth-Trunk1.${2500 + index}`,
      speedBps: BW,
      profiles: [{ profileId: `p-${index}`, direction: 'tx' as const, bandwidthBps: BW, thresholdBps: BW }],
    }));
  const poller = (limit: number, targets: ReturnType<typeof manyTargets>) =>
    new FastTrafficPoller({
      config: pollerConfig(limit),
      listTargets: async () => targets,
      reader: {
        // Contadores monotônicos: primeira leitura é BASELINE, sem taxa inventada.
        read: async (batch) =>
          batch.map((target) => ({
            deviceId: target.deviceId,
            interfaceId: target.interfaceId,
            ifIndex: target.ifIndex,
            interfaceName: target.interfaceName,
            requestStartedAt: NOW,
            collectedAt: NOW,
            inOctets: 1_000n,
            outOctets: 2_000n,
            uptimeTicks: 500_000n,
            discontinuityTicks: 0n,
            lastChangeTicks: 0n,
            adminStatus: 1,
            operStatus: 1,
            speedBps: BW,
          })),
      },
      store: { append: async () => true, latest: async () => null },
      now: () => NOW,
      logger: () => undefined,
    });

  it('default preserva o limite publicado (8)', () => {
    expect(fastPollerConfig({}).maxInterfacesPerDevice).toBe(8);
    expect(
      fastPollerConfig({ MITIGATION_FAST_MAX_INTERFACES_PER_DEVICE: '32' })
        .maxInterfacesPerDevice,
    ).toBe(32);
    expect(() =>
      fastPollerConfig({ MITIGATION_FAST_MAX_INTERFACES_PER_DEVICE: '0' }),
    ).toThrow(/MAX_INTERFACES_PER_DEVICE/);
    expect(() =>
      fastPollerConfig({ MITIGATION_FAST_MAX_INTERFACES_PER_DEVICE: '65' }),
    ).toThrow(/MAX_INTERFACES_PER_DEVICE/);
  });

  it('escopo acima do teto falha o refresh (fail-closed, sem coleta)', async () => {
    const subject = poller(8, manyTargets(12));
    await subject.runDue();
    expect(subject.status().lastError).toBe('TARGET_REFRESH_FAILED');
    expect(subject.status().entries).toEqual([]);
  });

  it('teto explícito admite os 12 perfis roteados', async () => {
    const subject = poller(12, manyTargets(12));
    await subject.runDue();
    expect(subject.status().lastError).toBeNull();
  });

  it('teto explícito continua fail-closed ao exceder', async () => {
    const subject = poller(12, manyTargets(13));
    await subject.runDue();
    expect(subject.status().lastError).toBe('TARGET_REFRESH_FAILED');
  });
});

function targetState(
  profileId: string,
  over: Partial<MitigationAutoTargetState> = {},
): MitigationAutoTargetState {
  return {
    profileId,
    deviceId: DEVICE,
    policyName: 'PL-JUSTNET-IPv4-IN',
    interfaceId: 'if-1',
    customer: 'JUSTNET',
    mode: 'ALERT_ONLY',
    direction: 'tx',
    snapshotAvailable: true,
    readiness: 'READY',
    prefixStatus: 'SAFE',
    blockedReason: null,
    mitigationExcluded: false,
    runtimeState: 'NORMAL',
    effectiveBandwidthBps: BW,
    bogonNode: 1,
    mitigationNode: 2,
    sharedPolicy: false,
    peerAddresses: ['10.200.201.230'],
    triggerPercent: 90,
    recoveryPercent: 70,
    triggerSamples: 3,
    recoverySamples: 12,
    ...over,
  };
}

async function engineHarness(
  options: {
    mode?: 'ALERT_ONLY' | 'AUTO';
    promotedBySweep?: boolean;
    executionEnabled?: boolean;
    liveWrite?: boolean;
    allowlist?: string[];
  } = {},
) {
  const repository = new InMemoryMitigationRepository();
  const record = await repository.upsertProfile({
    deviceId: DEVICE,
    policyName: 'PL-JUSTNET-IPv4-IN',
    interfaceId: 'if-1',
    addressFamily: 'IPV4',
    detectedBandwidthBps: BW,
    bandwidthSource: 'DESCRIPTION',
    prefixLimit: 100,
    mode: options.mode ?? 'ALERT_ONLY',
  });
  await repository.replaceProfilePeers(record.id, [
    { peerId: 'peer-1', peerAddress: '10.200.201.230', primary: true },
  ]);
  await repository.upsertRuntime(record.id, {
    state: 'NORMAL',
    plannedBogonNode: 1,
    plannedMitigationNode: 2,
    plannedNode: 2,
  });
  const execute = vi.fn(async () => ({
    ok: true,
    verified: true,
    status: 'ACTIVATED_VERIFIED' as const,
  }));
  const traffic = new SequenceTrafficSource();
  const engine = new MitigationAutoEngine({
    // Janela FAST: maxGapMs != null => despacho estrito e dedupe por amostra.
    sampling: { maxAgeMs: 30_000, maxGapMs: 45_000 },
    evaluationScope: 'OPERATIONAL',
    globalMode: 'AUTO',
    execution: {
      executor: 'HUAWEI',
      liveWrite: options.liveWrite ?? true,
      allowedDeviceIds: options.allowlist ?? [DEVICE],
    },
    executionControl: { enabled: options.executionEnabled ?? false },
    requireRuntimeRead: false,
    targets: {
      list: async () => [
        targetState(record.id, {
          mode: options.mode ?? 'ALERT_ONLY',
          ...(options.promotedBySweep ? { autoPromotedBySweep: true } : {}),
        }),
      ],
    },
    traffic,
    exclusions: { listPeerExclusions: async () => [] },
    runtime: {
      get: (id) => repository.getRuntime(id),
      save: async (id, patch) => {
        await repository.upsertRuntime(id, patch);
      },
    },
    commands: { execute },
    now: () => NOW,
  });

  const over = (BW * 95n) / 100n;
  const run = async (samples: { bps: bigint; key?: string; at?: Date }[]) => {
    let last: Awaited<ReturnType<typeof engine.tick>> = [];
    for (const sample of samples) {
      traffic.push(record.id, sample.bps, sample.key, sample.at ?? null);
      last = await engine.tick();
    }
    return last[0]!;
  };
  return { engine, execute, traffic, profileId: record.id, over, run };
}

describe('ALERT_ONLY com FAST nunca escreve BGP', () => {
  it('três amostras distintas acima do limiar => ALERT_TRIGGERED, zero comando', async () => {
    const h = await engineHarness();
    const decision = await h.run([
      { bps: h.over },
      { bps: h.over },
      { bps: h.over },
    ]);
    expect(decision).toMatchObject({ outcome: 'ALERT_TRIGGERED', samplesOver: 3 });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('duas amostras distintas são insuficientes (TRIGGER_PENDING, sem comando)', async () => {
    const h = await engineHarness();
    const decision = await h.run([{ bps: h.over }, { bps: h.over }]);
    expect(decision).toMatchObject({ outcome: 'TRIGGER_PENDING', reason: 'SAMPLES_INSUFFICIENT' });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('a MESMA amostra não conta duas vezes e não dispara o gatilho', async () => {
    const h = await engineHarness();
    const repeated = await h.run([
      { bps: h.over, key: 'amostra-1' },
      { bps: h.over, key: 'amostra-1' },
      { bps: h.over, key: 'amostra-2' },
    ]);
    expect(repeated.samplesOver).toBe(2);
    expect(h.execute).not.toHaveBeenCalled();
    const fired = await h.run([{ bps: h.over, key: 'amostra-3' }]);
    expect(fired).toMatchObject({ outcome: 'ALERT_TRIGGERED', samplesOver: 3 });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('ALERT_ONLY com LIVE_WRITE e allowlist armados continua sem escrita', async () => {
    const h = await engineHarness({
      liveWrite: true,
      executionEnabled: true,
      allowlist: [DEVICE],
    });
    const decision = await h.run([
      { bps: h.over },
      { bps: h.over },
      { bps: h.over },
    ]);
    expect(decision.outcome).toBe('ALERT_TRIGGERED');
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('amostra velha não autoriza nada (TELEMETRY_UNAVAILABLE)', async () => {
    const h = await engineHarness();
    const stale = new Date(NOW.getTime() - 120_000);
    const decision = await h.run([
      { bps: h.over, at: stale },
      { bps: h.over, at: stale },
      { bps: h.over, at: stale },
    ]);
    expect(decision).toMatchObject({ outcome: 'BLOCKED', reason: 'TELEMETRY_UNAVAILABLE' });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('transição futura: AUTO do sweep com EXECUTION=0 => WOULD_ACTIVATE sem escrita', async () => {
    const h = await engineHarness({
      mode: 'AUTO',
      promotedBySweep: true,
      executionEnabled: false,
    });
    const decision = await h.run([
      { bps: h.over },
      { bps: h.over },
      { bps: h.over },
    ]);
    expect(decision).toMatchObject({
      outcome: 'WOULD_ACTIVATE',
      reason: 'AUTO_EXECUTION_DISABLED',
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('transição futura: o MESMO perfil em AUTO autorizado usa o único executor', async () => {
    const h = await engineHarness({
      mode: 'AUTO',
      promotedBySweep: true,
      executionEnabled: true,
    });
    const decision = await h.run([
      { bps: h.over },
      { bps: h.over },
      { bps: h.over },
    ]);
    expect(decision).toMatchObject({
      outcome: 'ACTIVATED',
      commandStatus: 'ACTIVATED_VERIFIED',
      verified: true,
    });
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
});
