import { describe, expect, it } from 'vitest';
import type { MitigationProfileMode } from '../../infrastructure/bgp/mitigation/mitigation-types';
import { computeAutoStateView } from '../../infrastructure/bgp/mitigation/mitigation-auto-authorization';
import { InMemoryMitigationRepository } from '../../infrastructure/bgp/mitigation/in-memory-mitigation-repository';
import { resolveTelemetryDirection } from '../../infrastructure/bgp/mitigation/mitigation-telemetry';
import { MitigationAutoDescriptionSweep } from '../../infrastructure/bgp/mitigation/mitigation-auto-description-sweep';
import { MitigationAutoEngine, type MitigationAutoTargetState } from './mitigation-auto-engine';
import { InterfaceTrafficSource } from './mitigation-traffic-source';
import type {
  InterfaceTrafficReader,
  InterfaceTrafficRow,
} from '../../infrastructure/bgp/mitigation/prisma-interface-traffic-reader';

// AUTO-ALL: elegibilidade, telemetria por interface, HOLDs e rollback.
//
// Fixtures espelham a PRODUCAO de 20/10/2026: 15 perfis IPv4 READY (9 clientes,
// incluindo a JUSTNET com 4 interfaces, 5 peers e 4 ASNs), 4 AUTO existentes,
// 1 perfil IPv4 bloqueado por readiness e 16 perfis IPv6 (fora da fase).
// Nenhum teste abre socket, chama Huawei ou escreve BGP: o executor e fake.

const DEVICE = 'host-f1a';
const BW = 10_000_000_000n;
const PAIR = { bogonNode: 1, mitigationNode: 2 };

type Seed = {
  customer: string;
  interfaceName: string;
  policy: string;
  family?: 'IPV4' | 'IPV6';
  mode?: MitigationProfileMode;
  readiness?: 'READY' | 'NOT_READY';
  peers?: { peerId: string; peerAddress: string }[];
};

/** Os 15 IPv4 READY pendentes de autorizacao (dados reais de producao). */
const READY_V4: Seed[] = [
  { customer: 'CLICKING', interfaceName: 'Eth-Trunk1.3528', policy: 'PL-CLICKING-V4-IN', peers: [{ peerId: 'peer-click', peerAddress: '10.0.0.1' }] },
  { customer: 'FLASH-TELECOM', interfaceName: 'Eth-Trunk1.3065', policy: 'PL-FLASH-TELECOM_IPv4-IN', peers: [{ peerId: 'peer-flash-a', peerAddress: '10.0.1.1' }] },
  { customer: 'FLASH-TELECOM', interfaceName: 'Eth-Trunk1.3066', policy: 'PL-FLASH-TELECOM_IPv4-IN', peers: [{ peerId: 'peer-flash-b', peerAddress: '10.0.1.2' }] },
  { customer: 'GMTELECOM', interfaceName: 'Eth-Trunk1.3042', policy: 'PL-GMTELECOM_IPv4-IN', peers: [{ peerId: 'peer-gm', peerAddress: '10.0.2.1' }] },
  { customer: 'HORIZONTES', interfaceName: 'Eth-Trunk1.3011', policy: 'PL-HORIZONTES_IPv4-IN', peers: [{ peerId: 'peer-hor-a', peerAddress: '10.0.3.1' }] },
  { customer: 'HORIZONTES', interfaceName: 'Eth-Trunk1.3013', policy: 'PL-HORIZONTES_IPv4-IN', peers: [{ peerId: 'peer-hor-b', peerAddress: '10.0.3.2' }] },
  { customer: 'JUSTNET', interfaceName: 'Eth-Trunk1.2518', policy: 'PL-JUSTNET-IPv4-IN', peers: [{ peerId: 'peer-as271217', peerAddress: '10.200.201.226' }] },
  {
    customer: 'JUSTNET',
    interfaceName: 'Eth-Trunk1.2519',
    policy: 'PL-JUSTNET-IPv4-IN',
    peers: [
      { peerId: 'peer-as262663', peerAddress: '10.200.201.230' },
      { peerId: 'peer-as64608', peerAddress: '10.200.201.254' },
    ],
  },
  { customer: 'JUSTNET', interfaceName: 'Eth-Trunk1.3962', policy: 'PL-JUSTNET-IPv4-IN', peers: [{ peerId: 'peer-as264886-a', peerAddress: '10.200.201.66' }] },
  { customer: 'JUSTNET', interfaceName: 'Eth-Trunk1.3973', policy: 'PL-JUSTNET-IPv4-IN', peers: [{ peerId: 'peer-as264886-b', peerAddress: '10.200.201.70' }] },
  { customer: 'LIVINET', interfaceName: 'Eth-Trunk1.3031', policy: 'PL-LIVINET_IPv4-IN', peers: [{ peerId: 'peer-liv', peerAddress: '10.0.4.1' }] },
  { customer: 'PLAYCONNECT', interfaceName: 'Eth-Trunk1.3024', policy: 'PL-PLAYCONNECT_IPv4-IN', peers: [{ peerId: 'peer-play', peerAddress: '10.0.5.1' }] },
  { customer: 'RNJ', interfaceName: 'Eth-Trunk1.3026', policy: 'PL-RNJ_IPv4-IN', peers: [{ peerId: 'peer-rnj-a', peerAddress: '10.0.6.1' }] },
  { customer: 'RNJ', interfaceName: 'Eth-Trunk1.3030', policy: 'PL-RNJ_IPv4-IN', peers: [{ peerId: 'peer-rnj-b', peerAddress: '10.0.6.2' }] },
  { customer: 'SUPERNET', interfaceName: 'Eth-Trunk1.3078', policy: 'PL-SUPERNET-IPv4-IN', peers: [{ peerId: 'peer-sup', peerAddress: '10.0.7.1' }] },
];

const BLOCKED: Seed = {
  customer: 'WFREDES',
  interfaceName: 'Eth-Trunk1.1052',
  policy: 'PL-WFREDES-V4-IN',
  readiness: 'NOT_READY',
  peers: [{ peerId: 'peer-wf', peerAddress: '10.0.8.1' }],
};

const AUTO_ALREADY: Seed[] = [
  { customer: '73S', interfaceName: 'Eth-Trunk1.3534', policy: 'PL-73S_IPv4-IN', mode: 'AUTO', peers: [{ peerId: 'peer-73s', peerAddress: '10.0.9.1' }] },
  { customer: 'AGLINK', interfaceName: 'Eth-Trunk1.3058', policy: 'PL-AGLINK_IPv4-IN', mode: 'AUTO', peers: [{ peerId: 'peer-agl', peerAddress: '10.0.10.1' }] },
  { customer: 'BHNET', interfaceName: 'Eth-Trunk1.3043', policy: 'PL-BHNET_IPv4-IN', mode: 'AUTO', peers: [{ peerId: 'peer-bh-a', peerAddress: '10.0.11.1' }] },
  { customer: 'BHNET', interfaceName: 'Eth-Trunk1.3044', policy: 'PL-BHNET_IPv4-IN', mode: 'AUTO', peers: [{ peerId: 'peer-bh-b', peerAddress: '10.0.11.2' }] },
];

const V6: Seed[] = Array.from({ length: 16 }, (_, index) => ({
  customer: `V6-${index + 1}`,
  interfaceName: `Eth-Trunk9.${1000 + index}`,
  policy: `PL-V6-${index + 1}_IPv6-IN`,
  family: 'IPV6' as const,
  peers: [{ peerId: `peer-v6-${index + 1}`, peerAddress: `2001:db8::${index + 1}` }],
}));

type Profile = {
  id: string;
  seed: Seed;
  interfaceId: string;
  mode: MitigationProfileMode;
  promoted: boolean;
  passedNodes: boolean;
};

class Fixture {
  readonly repo = new InMemoryMitigationRepository();
  readonly profiles: Profile[] = [];

  async seed(
    seeds: Seed[],
    options: { mode?: MitigationProfileMode; readiness?: 'READY' | 'NOT_READY' } = {},
  ) {
    for (const seed of seeds) {
      const record = await this.repo.upsertProfile({
        deviceId: DEVICE,
        policyName: seed.policy,
        interfaceId: `if-${seed.interfaceName}`,
        addressFamily: seed.family ?? 'IPV4',
        detectedBandwidthBps: BW,
        bandwidthSource: 'DESCRIPTION',
        mode: seed.mode ?? options.mode ?? 'ALERT_ONLY',
      });
      if (seed.peers?.length)
        await this.repo.replaceProfilePeers(
          record.id,
          seed.peers.map((peer) => ({ ...peer, primary: true })),
        );
      await this.repo.upsertRuntime(record.id, {
        state: 'NORMAL',
        plannedBogonNode: PAIR.bogonNode,
        plannedMitigationNode: PAIR.mitigationNode,
        plannedNode: PAIR.mitigationNode,
      });
      this.profiles.push({
        id: record.id,
        seed: { ...seed, readiness: seed.readiness ?? options.readiness ?? 'READY' },
        interfaceId: `if-${seed.interfaceName}`,
        mode: seed.mode ?? options.mode ?? 'ALERT_ONLY',
        promoted: false,
        passedNodes: true,
      });
    }
  }

  async autoStateOf(id: string) {
    const record = (await this.repo.getProfile(id))!;
    const entry = this.profiles.find((p) => p.id === id)!;
    return computeAutoStateView({
      mode: record.mode,
      enabled: record.enabled,
      autoModeExempt: record.autoModeExempt,
      mitigationExcluded: record.mitigationExcluded,
      bandwidthSource: record.bandwidthSource,
      effectiveBandwidthBps: record.bandwidthOverrideBps ?? record.detectedBandwidthBps,
      snapshotAvailable: true,
      readiness: entry.seed.readiness ?? 'READY',
      plannedBogonNode: entry.passedNodes ? PAIR.bogonNode : null,
      plannedMitigationNode: entry.passedNodes ? PAIR.mitigationNode : null,
    });
  }

  async sweep(batchSize: 0 | number | 'unlimited') {
    const sweep = new MitigationAutoDescriptionSweep({
      enabled: true,
      families: ['IPV4'],
      batchSize,
      listProfiles: async () =>
        Promise.all(
          (await this.repo.listProfiles()).map(async (record) => {
            const state = await this.autoStateOf(record.id);
            return {
              id: record.id,
              persisted: true,
              addressFamily: record.addressFamily,
              policyName: record.policyName,
              interfaceName: record.interfaceId,
              mode: record.mode,
              autoModeExempt: record.autoModeExempt,
              promotedBySweep: record.autoPromotedBySweep,
              autoState: state.autoState,
              autoStateReason: state.autoStateReason,
            };
          }),
        ),
      setMode: (id, mode) => this.repo.setProfileMode(id, mode),
      setProvenance: (id, promoted) => this.repo.setProfileAutoPromotedBySweep(id, promoted),
    });
    return sweep.run();
  }

  idsFor(seeds: Seed[]) {
    return seeds.map(
      (seed) =>
        this.profiles.find(
          (p) => p.seed.customer === seed.customer && p.seed.interfaceName === seed.interfaceName,
        )!.id,
    );
  }
}

describe('AUTO-ALL: elegibilidade de todos os perfis IPv4 READY', () => {
  it('promove exatamente os 15 perfis READY (WFREDES e IPv6 ficam fora)', async () => {
    const f = new Fixture();
    await f.seed(READY_V4);
    await f.seed([BLOCKED]);
    await f.seed(AUTO_ALREADY);
    await f.seed(V6);

    const result = await f.sweep('unlimited');
    expect(result.held).toBe(false);
    expect(result.heldByBatch).toBe(0);
    expect(result.promoted).toHaveLength(15);
    const expected = new Set(f.idsFor(READY_V4));
    expect(new Set(result.promoted)).toEqual(expected);

    for (const profile of f.profiles) {
      const record = (await f.repo.getProfile(profile.id))!;
      if (expected.has(profile.id)) {
        expect(record.mode).toBe('AUTO');
        expect(record.autoPromotedBySweep).toBe(true);
      } else {
        expect(record.autoPromotedBySweep).toBe(false);
        expect(record.mode).toBe(profile.seed.mode ?? 'ALERT_ONLY');
      }
    }
    // Nenhum perfil IPv6 ou bloqueado foi promovido.
    expect(result.promoted.some((id) => f.idsFor(V6).includes(id))).toBe(false);
    expect(result.promoted).not.toContain(f.idsFor([BLOCKED])[0]);
  });

  it('HOLD de lote (BATCH_SIZE=0) preserva a autorizacao sem promover ninguem', async () => {
    const f = new Fixture();
    await f.seed(READY_V4);
    await f.seed([BLOCKED]);
    await f.seed(AUTO_ALREADY);
    await f.seed(V6);

    const before = new Map<string, MitigationProfileMode>();
    for (const record of await f.repo.listProfiles()) before.set(record.id, record.mode);

    const result = await f.sweep(0);
    expect(result.held).toBe(true);
    expect(result.promoted).toEqual([]);
    expect(result.heldByBatch).toBe(15);
    for (const record of await f.repo.listProfiles()) expect(record.mode).toBe(before.get(record.id));
  });

  it('BATCH_SIZE e RITMO: lote de 5 promove os 15 em 3 ciclos e nao limita o total', async () => {
    const f = new Fixture();
    await f.seed(READY_V4);
    await f.seed([BLOCKED]);
    await f.seed(AUTO_ALREADY);
    await f.seed(V6);

    const first = await f.sweep(5);
    expect(first.promoted).toHaveLength(5);
    expect(first.heldByBatch).toBe(10);
    const second = await f.sweep(5);
    expect(second.promoted).toHaveLength(5);
    expect(second.heldByBatch).toBe(5);
    const third = await f.sweep(5);
    expect(third.promoted).toHaveLength(5);
    expect(third.heldByBatch).toBe(0);
    // Idempotente: um 4o ciclo nao promove nem demove ninguem.
    const fourth = await f.sweep(5);
    expect(fourth.promoted).toEqual([]);
    expect(fourth.demoted).toEqual([]);
    for (const id of f.idsFor(READY_V4)) {
      const record = (await f.repo.getProfile(id))!;
      expect(record.mode).toBe('AUTO');
      expect(record.autoPromotedBySweep).toBe(true);
    }
    expect(fourth.promotedTotal).toBe(15);
  });

  it('os QUATRO AUTO atuais mantem a direcao do ENV mesmo com direcao de interface', async () => {
    const f = new Fixture();
    await f.seed(AUTO_ALREADY);
    // Os 4 perfis AUTO de producao tem direcao fixada por ENV (override legado).
    const envDirections: Record<string, 'rx' | 'tx'> = {
      [f.profiles[0]!.id]: 'tx',
      [f.profiles[1]!.id]: 'rx',
      [f.profiles[2]!.id]: 'tx',
      [f.profiles[3]!.id]: 'rx',
    };
    for (const profile of f.profiles)
      await f.repo.setInterfaceAutoTrafficDirection(profile.interfaceId, 'TX');
    for (const profile of f.profiles) {
      const record = (await f.repo.getProfile(profile.id))!;
      const resolved = resolveTelemetryDirection(
        record.id,
        record.autoTrafficDirection,
        envDirections,
        record.interfaceTrafficDirection,
      );
      // ENV (override explicito) vence a heranca: nada muda silenciosamente.
      expect(resolved.source).toBe('ENV');
      expect(resolved.direction).toBe(envDirections[record.id]!.toUpperCase());
      expect(record.mode).toBe('AUTO');
    }
  });

  it('novo perfil descoberto no futuro e promovido no ciclo seguinte', async () => {
    const f = new Fixture();
    await f.seed(READY_V4);
    await f.sweep('unlimited');
    await f.seed([
      {
        customer: 'NOVO-CLIENTE',
        interfaceName: 'Eth-Trunk1.4000',
        policy: 'PL-NOVO_IPv4-IN',
        peers: [{ peerId: 'peer-novo', peerAddress: '10.0.12.1' }],
      },
    ]);
    const result = await f.sweep('unlimited');
    expect(result.promoted).toHaveLength(1);
    const record = (await f.repo.getProfile(result.promoted[0]!))!;
    expect(record.mode).toBe('AUTO');
    expect(record.autoPromotedBySweep).toBe(true);
  });

  it('perder elegibilidade demove para ALERT_ONLY sem remover mitigacao ativa', async () => {
    const f = new Fixture();
    await f.seed(READY_V4);
    const result = await f.sweep('unlimited');
    const target = result.promoted[0]!;
    // Mitigacao ativa registrada ANTES da perda de elegibilidade.
    await f.repo.upsertRuntime(target, { state: 'MITIGATED' });
    // Banda deixa de vir da DESCRIPTION -> autoState OFF.
    await f.repo.clearProfileDetectedBandwidth(target);

    const demoted = await f.sweep('unlimited');
    expect(demoted.demoted).toContain(target);
    const record = (await f.repo.getProfile(target))!;
    expect(record.mode).toBe('ALERT_ONLY');
    expect(record.autoPromotedBySweep).toBe(false);
    // Runtime/MITIGATED intocado: o sweep nao tem porta de comando nem de REMOVE.
    expect((await f.repo.getRuntime(target))?.state).toBe('MITIGATED');
  });

  it('excecao manual (EXEMPT) devolve AUTO para ALERT_ONLY sem remover mitigacao', async () => {
    const f = new Fixture();
    await f.seed(READY_V4.slice(0, 1));
    const [id] = await f.sweep('unlimited').then((r) => r.promoted);
    await f.repo.setProfileAutoModeExempt(id!, true);
    await f.repo.upsertRuntime(id!, { state: 'MITIGATED' });
    const result = await f.sweep('unlimited');
    expect(result.demoted).toContain(id);
    expect((await f.repo.getProfile(id!))!.mode).toBe('ALERT_ONLY');
    expect((await f.repo.getRuntime(id!))?.state).toBe('MITIGATED');
  });

  it('telemetria por interface e herdada pelo perfil e nao interfere na promocao', async () => {
    const f = new Fixture();
    await f.seed(READY_V4.filter((seed) => seed.customer === 'JUSTNET'));
    const justnet = f.profiles.filter((p) => p.seed.customer === 'JUSTNET');
    for (const profile of justnet)
      await f.repo.setInterfaceAutoTrafficDirection(profile.interfaceId, 'TX');
    const result = await f.sweep('unlimited');
    expect(result.promoted).toHaveLength(4);
    for (const profile of justnet) {
      const record = (await f.repo.getProfile(profile.id))!;
      expect(record.mode).toBe('AUTO');
      expect(record.autoTrafficDirection).toBeNull();
      expect(record.interfaceTrafficDirection).toBe('TX');
      expect(
        resolveTelemetryDirection(record.id, record.autoTrafficDirection, {}, record.interfaceTrafficDirection),
      ).toEqual({ direction: 'TX', source: 'INTERFACE' });
    }
  });
});

type Direction = { profile?: 'RX' | 'TX' | null; env?: 'rx' | 'tx'; iface?: 'RX' | 'TX' | null };

const RUNTIME_NOW = new Date('2026-10-20T18:00:00.000Z');
/** Primeira amostra 9 min antes do relogio do motor; cada nova +10 s (maxAge 10 min). */
const BASE_SAMPLE_AT = new Date(RUNTIME_NOW.getTime() - 540_000);

class FakeTrafficReader implements InterfaceTrafficReader {
  rows = new Map<string, InterfaceTrafficRow>();
  async latestTraffic(interfaceId: string): Promise<InterfaceTrafficRow | null> {
    return this.rows.get(interfaceId) ?? null;
  }
}

/**
 * Reproduz o processo real: a direcao EFETIVA do target alimenta a unica fonte
 * de telemetria. Sem direcao resolvida a fonte devolve `null` (fail-closed),
 * exatamente como `InterfaceTrafficSource` em producao.
 */
async function engineHarness(options: {
  direction: Direction;
  mode?: MitigationProfileMode;
  promotedBySweep?: boolean;
  executionControlEnabled?: boolean;
  command?: 'OK' | 'FAIL';
}) {
  const repo = new InMemoryMitigationRepository();
  const profile = await repo.upsertProfile({
    deviceId: DEVICE,
    policyName: 'PL-TEST-IPv4-IN',
    interfaceId: 'if-test',
    addressFamily: 'IPV4',
    detectedBandwidthBps: BW,
    bandwidthSource: 'DESCRIPTION',
    mode: options.mode ?? 'AUTO',
    autoPromotedBySweep: options.promotedBySweep ?? false,
  });
  if (options.direction.profile)
    await repo.setProfileAutoTrafficDirection(profile.id, options.direction.profile);
  if (options.direction.iface)
    await repo.setInterfaceAutoTrafficDirection('if-test', options.direction.iface);
  await repo.upsertRuntime(profile.id, {
    state: 'NORMAL',
    plannedBogonNode: PAIR.bogonNode,
    plannedMitigationNode: PAIR.mitigationNode,
    plannedNode: PAIR.mitigationNode,
  });

  const calls: string[] = [];
  const reader = new FakeTrafficReader();
  let resolved: 'rx' | 'tx' | null = null;
  const traffic = new InterfaceTrafficSource(reader, {
    resolveDirection: () => resolved,
    maxAgeMs: 600_000,
    now: () => RUNTIME_NOW,
  });

  const engine = new MitigationAutoEngine({
    sampling: { maxAgeMs: 600_000, maxGapMs: 45_000 },
    globalMode: 'AUTO',
    execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [DEVICE] },
    executionControl: { enabled: options.executionControlEnabled ?? true },
    targets: {
      list: async (): Promise<MitigationAutoTargetState[]> => {
        const record = (await repo.getProfile(profile.id))!;
        const resolvedDirection = resolveTelemetryDirection(
          record.id,
          record.autoTrafficDirection,
          options.direction.env ? { [record.id]: options.direction.env } : {},
          record.interfaceTrafficDirection,
        );
        resolved = resolvedDirection.direction
          ? (resolvedDirection.direction.toLowerCase() as 'rx' | 'tx')
          : null;
        const runtime = await repo.getRuntime(record.id);
        return [
          {
            profileId: record.id,
            deviceId: record.deviceId,
            policyName: record.policyName,
            interfaceId: record.interfaceId,
            customer: 'TESTE',
            mode: record.mode,
            addressFamily: 'IPV4',
            direction: resolved,
            directionSource: resolvedDirection.source,
            sharedPolicyAutomationBlocked: false,
            autoPromotedBySweep: record.autoPromotedBySweep === true,
            snapshotAvailable: true,
            readiness: 'READY',
            prefixStatus: 'SAFE',
            blockedReason: null,
            mitigationExcluded: false,
            runtimeState: runtime?.state ?? null,
            effectiveBandwidthBps: record.detectedBandwidthBps,
            bogonNode: PAIR.bogonNode,
            mitigationNode: PAIR.mitigationNode,
            sharedPolicy: true,
            peerAddresses: ['10.200.201.230'],
            triggerPercent: 90,
            recoveryPercent: 70,
            triggerSamples: 3,
            recoverySamples: 12,
          },
        ];
      },
    },
    traffic,
    exclusions: { listPeerExclusions: async () => [] },
    runtime: {
      get: async (id) => {
        const runtime = await repo.getRuntime(id);
        return runtime
          ? {
              state: runtime.state,
              triggerCounter: runtime.triggerCounter,
              recoveryCounter: runtime.recoveryCounter,
              lastSampleAt: runtime.lastSampleAt,
            }
          : null;
      },
      save: async (id, patch) => {
        await repo.upsertRuntime(id, patch);
      },
    },
    commands: {
      execute: async ({ profileId }) => {
        calls.push(profileId);
        if (options.command === 'FAIL')
          return {
            ok: false,
            verified: false,
            status: 'PREFLIGHT_BLOCKED',
            blockedReason: 'preflight_policy_changed',
          };
        // O servico canonico e quem grava o runtime; aqui o fake faz o mesmo.
        await repo.upsertRuntime(profileId, { state: 'MITIGATED' });
        return { ok: true, verified: true, status: 'ACTIVATED_VERIFIED' };
      },
    },
    now: () => RUNTIME_NOW,
  });

  const over = (BW * 95n) / 100n;
  // Relogio das amostras SEMPRE crescente: cada feed e uma leitura nova do
  // equipamento (o motor rejeita timestamp reordenado como amostra distinta).
  let feeds = 0;
  const feed = (value: bigint) => {
    feeds += 1;
    const direction = resolved;
    reader.rows.set('if-test', {
      interfaceId: 'if-test',
      rxBps: direction === 'rx' ? Number(value) : 0,
      txBps: direction === 'tx' ? Number(value) : 0,
      timestamp: new Date(BASE_SAMPLE_AT.getTime() + feeds * 10_000),
    });
  };
  /** Cada tick consome uma amostra NOVA do equipamento (timestamp crescente). */
  const run = async (times: number, value = over) => {
    let last: Awaited<ReturnType<typeof engine.tick>> = [];
    for (let index = 0; index < times; index += 1) {
      await engine.tick(); // resolve a direcao corrente no `targets.list`
      feed(value);
      last = await engine.tick();
    }
    return last[0]!;
  };
  return { repo, profile, engine, calls, run, feed, over };
}

describe('AUTO-ALL: telemetria, direcao e execucao', () => {
  it('sem direcao nenhuma: TELEMETRY_UNAVAILABLE e zero comando', async () => {
    const h = await engineHarness({ direction: {} });
    const decision = await h.run(3);
    expect(decision).toMatchObject({ outcome: 'BLOCKED', reason: 'TELEMETRY_UNAVAILABLE' });
    expect(h.calls).toEqual([]);
  });

  it('direcao herdada da INTERFACE (TX) dispara o threshold e ativa uma vez', async () => {
    const h = await engineHarness({ direction: { iface: 'TX' } });
    const decision = await h.run(3);
    expect(decision).toMatchObject({
      outcome: 'ACTIVATED',
      direction: 'tx',
      directionSource: 'INTERFACE',
      verified: true,
    });
    expect(h.calls).toHaveLength(1);
    expect((await h.repo.getRuntime(h.profile.id))?.state).toBe('MITIGATED');
  });

  it('override do perfil vence a interface e o ENV continua valendo', async () => {
    const profile = await engineHarness({ direction: { profile: 'TX', iface: 'RX', env: 'rx' } });
    expect((await profile.run(3)).directionSource).toBe('PROFILE');
    const env = await engineHarness({ direction: { env: 'tx', iface: 'RX' } });
    const decision = await env.run(3);
    expect(decision).toMatchObject({ directionSource: 'ENV', outcome: 'ACTIVATED' });
  });

  it('RX permanece monitor-only: alerta, nunca escreve', async () => {
    const h = await engineHarness({ direction: { iface: 'RX' } });
    const decision = await h.run(3);
    expect(decision).toMatchObject({ outcome: 'ALERT_TRIGGERED', reason: 'RX_MONITOR_ONLY' });
    expect(h.calls).toEqual([]);
    expect((await h.repo.getRuntime(h.profile.id))?.state).not.toBe('MITIGATED');
  });

  it('AUTO promovido pelo sweep com EXECUTION=0 fica em WOULD_ACTIVATE', async () => {
    const h = await engineHarness({
      direction: { iface: 'TX' },
      promotedBySweep: true,
      executionControlEnabled: false,
    });
    const decision = await h.run(3);
    expect(decision).toMatchObject({ outcome: 'WOULD_ACTIVATE', reason: 'AUTO_EXECUTION_DISABLED' });
    expect(h.calls).toEqual([]);
  });

  // SAFETY-GATES-03 (M8): o contrato anterior ("AUTO manual continua autorizado
  // com EXECUTION=0") foi REVOGADO. O kill switch vale para toda origem AUTO.
  it('AUTO manual com EXECUTION=0 tambem fica em WOULD_ACTIVATE (kill switch global)', async () => {
    const h = await engineHarness({
      direction: { iface: 'TX' },
      promotedBySweep: false,
      executionControlEnabled: false,
    });
    expect(await h.run(3)).toMatchObject({
      outcome: 'WOULD_ACTIVATE',
      reason: 'AUTO_EXECUTION_DISABLED',
    });
    expect(h.calls).toHaveLength(0);
  });

  it('falha de preflight vira FAILED sem mitigar o runtime', async () => {
    const h = await engineHarness({ direction: { iface: 'TX' }, command: 'FAIL' });
    const decision = await h.run(3);
    expect(decision).toMatchObject({ outcome: 'FAILED', reason: 'PREFLIGHT_FAILED' });
    expect((await h.repo.getRuntime(h.profile.id))?.state).not.toBe('MITIGATED');
  });

  it('rollback dos parametros: limpar direcao volta a bloquear; ALERT_ONLY volta a alertar', async () => {
    const h = await engineHarness({ direction: { iface: 'TX' }, mode: 'ALERT_ONLY' });
    expect((await h.run(3)).outcome).toBe('ALERT_TRIGGERED');
    expect(h.calls).toEqual([]);
    await h.repo.setInterfaceAutoTrafficDirection('if-test', null);
    const blocked = await h.run(3);
    expect(blocked).toMatchObject({ outcome: 'BLOCKED', reason: 'TELEMETRY_UNAVAILABLE' });
    await h.repo.setProfileMode(h.profile.id, 'AUTO');
    await h.repo.setInterfaceAutoTrafficDirection('if-test', 'TX');
    expect((await h.run(3)).outcome).toBe('ACTIVATED');
  });
});
