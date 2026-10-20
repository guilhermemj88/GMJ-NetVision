import { describe, expect, it, vi } from 'vitest';
import type { MitigationProfileRecord } from '../../infrastructure/bgp/mitigation/mitigation-repository';
import { deriveFastTraffic } from '../../infrastructure/snmp/fast-traffic-rate';
import { listFastTrafficTargets } from '../../infrastructure/snmp/fast-traffic-targets';
import { FastTrafficPoller, fastPollerConfig } from '../../infrastructure/snmp/fast-traffic-poller';
import type {
  FastCounterReading,
  FastTrafficObservation,
  FastTrafficStore,
  FastTrafficTarget,
} from '../../infrastructure/snmp/fast-traffic-types';
import type { FastSnmpHostPort } from '../../infrastructure/snmp/fast-snmp-reader';
import {
  FastBridgeRoutingSource,
  FastObservationSource,
  fastBridgeConfig,
  fastRoutingActive,
  type FastBridgeMapping,
  type FastBridgeProfile,
  type FastBridgeSnapshot,
} from './fast-observation-bridge';
import { MitigationAutoEngine, type MitigationAutoTargetState } from './mitigation-auto-engine';
import { samplingWindowForProfile } from './mitigation-sampling-policy';
import { defaultTarget } from '../../testing/mitigation-engine-harness';

// FAST TELEMETRY GLOBAL: roteamento de telemetria separado de autorização de
// escrita, cobertura de 19 perfis IPv4 / 18 interfaces (uma interface com dois
// perfis, caso sintético de dedupe), Justnet com 4 interfaces e 1 policy, três
// amostras distintas em 20–30 s e HOLD impedindo qualquer escrita.

const DEVICE = 'host-377c554a-8d1e-47c4-baa4-f258693b4d91';
const BASE = Date.parse('2026-10-20T12:00:00Z');
const STEP = 10_000;
const BW = 10_000_000_000n;

type Seed = {
  id: string;
  ifIndex: number;
  name: string;
  policy: string;
  bandwidth?: bigint;
  mode?: 'AUTO' | 'ALERT_ONLY';
  family?: 'IPV4' | 'IPV6';
  enabled?: boolean;
  direction?: 'TX' | 'RX' | null;
};

/** 19 perfis elegíveis em 18 interfaces (a 3528 tem dois perfis, dedupe). */
const SEEDS: Seed[] = [
  { id: 'just-2518', ifIndex: 2518, name: 'Eth-Trunk1.2518', policy: 'PL-JUSTNET-IPv4-IN' },
  { id: 'just-2519', ifIndex: 2519, name: 'Eth-Trunk1.2519', policy: 'PL-JUSTNET-IPv4-IN' },
  { id: 'just-3962', ifIndex: 3962, name: 'Eth-Trunk1.3962', policy: 'PL-JUSTNET-IPv4-IN' },
  { id: 'just-3973', ifIndex: 3973, name: 'Eth-Trunk1.3973', policy: 'PL-JUSTNET-IPv4-IN' },
  { id: 'clicking', ifIndex: 3528, name: 'Eth-Trunk1.3528', policy: 'PL-CLICKING-V4-IN', bandwidth: 20_000_000_000n },
  { id: 'clicking-2', ifIndex: 3528, name: 'Eth-Trunk1.3528', policy: 'PL-CLICKING-V4-IN-2' },
  { id: 'fast-3065', ifIndex: 3065, name: 'Eth-Trunk1.3065', policy: 'PL-FLASH-TELECOM_IPv4-IN' },
  { id: 'fast-3066', ifIndex: 3066, name: 'Eth-Trunk1.3066', policy: 'PL-FLASH-TELECOM_IPv4-IN' },
  { id: 'gm-3042', ifIndex: 3042, name: 'Eth-Trunk1.3042', policy: 'PL-GMTELECOM_IPv4-IN' },
  { id: 'hor-3011', ifIndex: 3011, name: 'Eth-Trunk1.3011', policy: 'PL-HORIZONTES_IPv4-IN', bandwidth: 40_000_000_000n },
  { id: 'hor-3013', ifIndex: 3013, name: 'Eth-Trunk1.3013', policy: 'PL-HORIZONTES_IPv4-IN', bandwidth: 40_000_000_000n },
  { id: 'liv-3031', ifIndex: 3031, name: 'Eth-Trunk1.3031', policy: 'PL-LIVINET_IPv4-IN' },
  { id: 'play-3024', ifIndex: 3024, name: 'Eth-Trunk1.3024', policy: 'PL-PLAYCONNECT_IPv4-IN' },
  { id: 'rnj-3026', ifIndex: 3026, name: 'Eth-Trunk1.3026', policy: 'PL-RNJ_IPv4-IN' },
  { id: 'rnj-3030', ifIndex: 3030, name: 'Eth-Trunk1.3030', policy: 'PL-RNJ_IPv4-IN' },
  { id: 'sup-3078', ifIndex: 3078, name: 'Eth-Trunk1.3078', policy: 'PL-SUPERNET-IPv4-IN' },
  { id: 'bhnet-3043', ifIndex: 3043, name: 'Eth-Trunk1.3043', policy: 'PL-BHNET_IPv4-IN' },
  { id: 'bhnet-3044', ifIndex: 3044, name: 'Eth-Trunk1.3044', policy: 'PL-BHNET_IPv4-IN' },
  { id: 's73-3534', ifIndex: 3534, name: 'Eth-Trunk1.3534', policy: 'PL-73S_IPv4-IN', bandwidth: 40_000_000_000n },
];

const profile = (seed: Seed): MitigationProfileRecord => ({
  id: seed.id,
  deviceId: DEVICE,
  policyName: seed.policy,
  interfaceId: `if-${seed.ifIndex}`,
  addressFamily: seed.family ?? 'IPV4',
  detectedBandwidthBps: seed.bandwidth ?? BW,
  bandwidthSource: 'DESCRIPTION',
  bandwidthOverrideBps: null,
  prefixLimit: 100,
  mode: seed.mode ?? 'AUTO',
  enabled: seed.enabled ?? true,
  triggerPercent: 90,
  recoveryPercent: 70,
  triggerSamples: 3,
  recoverySamples: 12,
  checkIntervalSeconds: 5,
  mitigationRt: '268568:660',
  autoTrafficDirection: seed.direction ?? 'TX',
  interfaceTrafficDirection: null,
  autoModeExempt: false,
  autoPromotedBySweep: true,
  mitigationExcluded: false,
  mitigationExclusionReason: null,
  mitigationExclusionNote: null,
  createdAt: new Date(BASE),
  updatedAt: new Date(BASE),
});

const hostPort = (): FastSnmpHostPort =>
  ({
    getHost: async () => ({
      id: DEVICE,
      snmpEnabled: true,
      snmp: { version: 'SNMP_V2C', host: '10.0.0.1', port: 161 },
      interfaces: SEEDS.map((seed) => ({
        id: `if-${seed.ifIndex}`,
        name: seed.name,
        ifIndex: seed.ifIndex,
        speedBps: 300_000_000_000,
      })),
    }),
  }) as unknown as FastSnmpHostPort;

describe('FAST global: seleção de alvos (19 perfis / 18 interfaces)', () => {
  const targets = () =>
    listFastTrafficTargets({
      profileIds: SEEDS.map((seed) => seed.id),
      allowedDeviceIds: [DEVICE],
      listProfiles: async () => [
        ...SEEDS.map(profile),
        // Não coletados: modo não AUTO, IPv6, desabilitado e excluído.
        profile({ ...SEEDS[0]!, id: 'alert-only', mode: 'ALERT_ONLY' }),
        profile({ ...SEEDS[0]!, id: 'ipv6', family: 'IPV6' }),
        profile({ ...SEEDS[0]!, id: 'disabled', enabled: false }),
        profile({ ...SEEDS[0]!, id: 'excluded' }),
      ].map((p, index) => (index === 22 ? { ...p, mitigationExcluded: true } : p)),
      hosts: hostPort(),
      direction: (p) => (p.autoTrafficDirection === 'TX' ? 'tx' : p.autoTrafficDirection === 'RX' ? 'rx' : null),
    });

  it('deduplica por interface e agrupa perfis que compartilham o link', async () => {
    const list = await targets();
    expect(list).toHaveLength(18);
    expect(list.flatMap((t) => t.profiles.map((p) => p.profileId))).toHaveLength(19);
    const shared = list.find((t) => t.interfaceId === 'if-3528')!;
    expect(shared.profiles).toHaveLength(2);
    // Threshold por PERFIL, não por interface.
    expect(
      shared.profiles.map((p) => p.thresholdBps).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    ).toEqual([
      9_000_000_000n,
      18_000_000_000n,
    ]);
  });

  it('Justnet entra como 4 alvos da MESMA policy, com 4 ASNs implícitos por peer', async () => {
    const justnet = (await targets()).filter((t) =>
      t.profiles.some((p) => p.profileId.startsWith('just-')),
    );
    expect(justnet).toHaveLength(4);
    expect(new Set(justnet.map((t) => t.interfaceId)).size).toBe(4);
    expect(justnet.every((t) => t.profiles.length === 1)).toBe(true);
  });

  it('exclui modo não AUTO, IPv6, desabilitado e exclusão administrativa', async () => {
    const ids = (await targets()).flatMap((t) => t.profiles.map((p) => p.profileId));
    expect(ids).not.toContain('alert-only');
    expect(ids).not.toContain('ipv6');
    expect(ids).not.toContain('disabled');
    expect(ids).not.toContain('excluded');
  });

  it('exige direção resolvida: sem direção o perfil não é coletado', async () => {
    const list = await listFastTrafficTargets({
      profileIds: ['just-2519', 'just-2518'],
      allowedDeviceIds: [DEVICE],
      listProfiles: async () => [
        profile({ ...SEEDS[1]!, direction: null }),
        profile({ ...SEEDS[0]!, direction: null }),
      ],
      hosts: hostPort(),
      direction: () => null,
    });
    expect(list).toEqual([]);
  });
});

describe('FAST global: roteamento separado da autorização de escrita', () => {
  it('sem a variável explícita mantém o desenho anterior (somente ENFORCE roteia)', () => {
    const legacy = fastBridgeConfig({
      MITIGATION_FAST_BRIDGE_MODE: 'ENFORCE',
      MITIGATION_FAST_BRIDGE_PROFILE_IDS: 'a,b',
      MITIGATION_FAST_ENFORCE_PROFILE_IDS: 'a',
      MITIGATION_FAST_BRIDGE_WRITES_ENABLED: 'true',
    });
    expect(legacy.routedExplicit).toBe(false);
    expect(fastRoutingActive(legacy, 'a')).toBe(true);
    expect(fastRoutingActive(legacy, 'b')).toBe(false);
  });

  it('lista explícita de roteamento vale em SHADOW (coleta ≠ execução)', () => {
    const shadow = fastBridgeConfig({
      MITIGATION_FAST_BRIDGE_MODE: 'SHADOW',
      MITIGATION_FAST_BRIDGE_PROFILE_IDS: 'a,b',
      MITIGATION_FAST_ROUTED_PROFILE_IDS: 'a,b',
    });
    expect(shadow.mode).toBe('SHADOW');
    expect(fastRoutingActive(shadow, 'b')).toBe(true);
    const enforce = fastBridgeConfig({
      MITIGATION_FAST_BRIDGE_MODE: 'ENFORCE',
      MITIGATION_FAST_BRIDGE_PROFILE_IDS: 'a,b',
      MITIGATION_FAST_ENFORCE_PROFILE_IDS: 'a',
      MITIGATION_FAST_ROUTED_PROFILE_IDS: 'a,b',
      MITIGATION_FAST_BRIDGE_WRITES_ENABLED: 'true',
    });
    expect(fastRoutingActive(enforce, 'a')).toBe(true);
    expect(fastRoutingActive(enforce, 'b')).toBe(true);
    expect(enforce.enforceProfileIds).toEqual(['a']);
  });

  it('recusa configurações incoerentes', () => {
    expect(() =>
      fastBridgeConfig({ MITIGATION_FAST_BRIDGE_MODE: 'OFF', MITIGATION_FAST_ROUTED_PROFILE_IDS: 'a' }),
    ).toThrow('active bridge mode');
    expect(() =>
      fastBridgeConfig({
        MITIGATION_FAST_BRIDGE_MODE: 'ENFORCE',
        MITIGATION_FAST_BRIDGE_PROFILE_IDS: 'a',
        MITIGATION_FAST_ENFORCE_PROFILE_IDS: 'a',
        MITIGATION_FAST_BRIDGE_WRITES_ENABLED: 'true',
        MITIGATION_FAST_ROUTED_PROFILE_IDS: 'b',
      }),
    ).toThrow('must belong');
    expect(() =>
      fastBridgeConfig({
        MITIGATION_FAST_BRIDGE_MODE: 'ENFORCE',
        MITIGATION_FAST_BRIDGE_PROFILE_IDS: 'a,b',
        MITIGATION_FAST_ENFORCE_PROFILE_IDS: 'a',
        MITIGATION_FAST_BRIDGE_WRITES_ENABLED: 'true',
        MITIGATION_FAST_ROUTED_PROFILE_IDS: 'b',
      }),
    ).toThrow('Enforce profiles must also be routed');
  });

  it('a janela do motor acompanha o roteamento, não o modo', () => {
    const bridge = fastBridgeConfig({
      MITIGATION_FAST_BRIDGE_MODE: 'SHADOW',
      MITIGATION_FAST_BRIDGE_PROFILE_IDS: 'a,b',
      MITIGATION_FAST_ROUTED_PROFILE_IDS: 'a,b',
    });
    const embedded = fastPollerConfig({});
    expect(
      samplingWindowForProfile('b', { legacyMaxAgeMs: 600_000, bridge, embedded }),
    ).toEqual({ maxAgeMs: 30_000, maxGapMs: 45_000 });
    expect(
      samplingWindowForProfile('other', { legacyMaxAgeMs: 600_000, bridge, embedded }),
    ).toEqual({ maxAgeMs: 600_000, maxGapMs: null });
  });

  it('o observador coleta a UNIÃO da lista legada com a lista roteada', () => {
    expect(fastPollerConfig({}).profileIds).toEqual([]);
    expect(
      fastPollerConfig({
        MITIGATION_FAST_PROFILE_IDS: 'a',
        MITIGATION_FAST_ROUTED_PROFILE_IDS: 'a,b',
      }).profileIds,
    ).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// Sequência FAST real (octetos) consumida pelo motor com janela FAST.
// ---------------------------------------------------------------------------

const mapping = (): FastBridgeMapping => ({
  id: 'if-2519',
  deviceId: DEVICE,
  name: 'Eth-Trunk1.2519',
  ifIndex: 2519,
  adminStatus: 'UP',
  operStatus: 'UP',
  speedBps: 300_000_000_000n,
});

const reading = (index: number, txBps: number, rxBps = 0): FastCounterReading => {
  // delta de octetos = bps * segundos / 8 (STEP est? em ms)
  const seconds = STEP / 1000;
  const out = 1_000_000_000_000n + BigInt(Math.round((txBps * seconds * index) / 8));
  const inn = 500_000_000_000n + BigInt(Math.round((rxBps * seconds * index) / 8));
  return {
    deviceId: DEVICE,
    interfaceId: 'if-2519',
    ifIndex: 2519,
    interfaceName: 'Eth-Trunk1.2519',
    requestStartedAt: new Date(BASE + index * STEP - 5),
    collectedAt: new Date(BASE + index * STEP),
    inOctets: inn,
    outOctets: out,
    uptimeTicks: 100_000n + BigInt(index * 100),
    discontinuityTicks: 0n,
    lastChangeTicks: 0n,
    adminStatus: 1,
    operStatus: 1,
    speedBps: 300_000_000_000n,
  };
};

const observations = (txBps: number[]): FastTrafficObservation[] => {
  const reads = txBps.map((value, index) => reading(index, value));
  return reads.map((current, index) =>
    deriveFastTraffic(
      {
        deviceId: DEVICE,
        interfaceId: 'if-2519',
        ifIndex: 2519,
        interfaceName: 'Eth-Trunk1.2519',
        speedBps: 300_000_000_000n,
        profiles: [],
      },
      current,
      index > 0 ? reads[index - 1] : undefined,
      'generation-1',
    ),
  );
};

class SequencedReader {
  index = 0;
  constructor(private readonly rows: FastTrafficObservation[]) {}
  async snapshot(): Promise<FastBridgeSnapshot> {
    return {
      mapping: mapping(),
      current: this.rows[this.index] ?? null,
      previous: this.index > 0 ? (this.rows[this.index - 1] ?? null) : null,
      collectorAvailable: true,
    };
  }
}

const routedConfig = () =>
  fastBridgeConfig({
    MITIGATION_FAST_BRIDGE_MODE: 'SHADOW',
    MITIGATION_FAST_BRIDGE_PROFILE_IDS: 'just-2519',
    MITIGATION_FAST_ROUTED_PROFILE_IDS: 'just-2519',
  });

function fastHarness(options: {
  txBps: number[];
  executionControlEnabled?: boolean;
  promotedBySweep?: boolean;
  mutate?: (row: FastTrafficObservation, index: number) => FastTrafficObservation;
  profileId?: string;
  policyName?: string;
  targetMode?: 'AUTO' | 'ALERT_ONLY';
  bridgeEnv?: Record<string, string>;
}) {
  const profileId = options.profileId ?? 'just-2519';
  const config = options.bridgeEnv ? fastBridgeConfig(options.bridgeEnv) : routedConfig();
  const rows = observations(options.txBps);
  if (options.mutate) for (let i = 0; i < rows.length; i++) rows[i] = options.mutate(rows[i]!, i);
  const reader = new SequencedReader(rows);
  let clock = BASE;
  const source = new FastObservationSource({
    config,
    reader,
    profile: () =>
      ({
        profileId,
        deviceId: DEVICE,
        interfaceId: 'if-2519',
        direction: 'tx',
        revision: 'rev-1',
      }) satisfies FastBridgeProfile,
    now: () => new Date(clock),
  });
  const legacy = {
    sampleWithId: vi.fn(async () => {
      throw new Error('LEGACY_MUST_NOT_BE_USED');
    }),
    sample: vi.fn(async () => {
      throw new Error('LEGACY_MUST_NOT_BE_USED');
    }),
  };
  const traffic = new FastBridgeRoutingSource(config, source, legacy);
  const calls: string[] = [];
  const target: MitigationAutoTargetState = defaultTarget({
    profileId,
    deviceId: DEVICE,
    interfaceId: 'if-2519',
    policyName: options.policyName ?? 'PL-JUSTNET-IPv4-IN',
    mode: options.targetMode ?? 'AUTO',
    direction: 'tx',
    directionSource: 'INTERFACE',
    autoPromotedBySweep: options.promotedBySweep ?? true,
    effectiveBandwidthBps: BW,
    triggerSamples: 3,
    configurationKey: 'rev-1',
  });
  const engine = new MitigationAutoEngine({
    sampling: () => samplingWindowForProfile(profileId, { legacyMaxAgeMs: 600_000, bridge: config, embedded: fastPollerConfig({}) }),
    requireRuntimeRead: true,
    globalMode: 'AUTO',
    execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: [DEVICE] },
    executionControl: { enabled: options.executionControlEnabled ?? true },
    targets: { list: async () => [target] },
    traffic,
    exclusions: { listPeerExclusions: async () => [] },
    runtime: {
      get: async () => ({ state: 'NORMAL', triggerCounter: 0, recoveryCounter: 0, lastSampleAt: null }),
      save: async () => undefined,
    },
    commands: {
      execute: async () => {
        calls.push(profileId);
        return { ok: true, verified: true, status: 'ACTIVATED_VERIFIED' };
      },
    },
    now: () => new Date(clock),
  });
  const at = (index: number) => {
    reader.index = index;
    clock = BASE + index * STEP;
  };
  /** Avança SOMENTE o relógio (mantém a mesma amostra) para provar staleness. */
  const nowAt = (index: number) => {
    clock = BASE + index * STEP;
  };
  const tickAt = async (index: number) => {
    at(index);
    return (await engine.tick())[0]!;
  };
  return { engine, reader, calls, at, nowAt, tickAt, legacy, rows, config, source };
}

describe('FAST global: três amostras distintas em 20–30 s', () => {
  it('primeira leitura é BASELINE; a ativação ocorre na 3ª amostra VÁLIDA (t0+30 s)', async () => {
    const h = fastHarness({ txBps: [0, 9_500_000_000, 9_500_000_000, 9_500_000_000] });
    const baseline = await h.tickAt(0);
    const first = await h.tickAt(1);
    expect(baseline.outcome).toBe('BLOCKED');
    expect(first).toMatchObject({ outcome: 'TRIGGER_PENDING', samplesOver: 1 });
    const second = await h.tickAt(2);
    expect(second).toMatchObject({ outcome: 'TRIGGER_PENDING', samplesOver: 2 });
    const third = await h.tickAt(3);
    expect(third).toMatchObject({ outcome: 'ACTIVATED', samplesOver: 3, direction: 'tx' });
    expect(h.calls).toHaveLength(1);
    expect(h.legacy.sampleWithId).not.toHaveBeenCalled();
  });

  it('amostra repetida (mesmo id) NÃO conta duas vezes', async () => {
    const h = fastHarness({ txBps: [0, 9_500_000_000, 9_500_000_000, 9_500_000_000] });
    await h.tickAt(1);
    const repeated = await h.tickAt(1);
    expect(repeated.outcome).toBe('TRIGGER_PENDING');
    expect(repeated.samplesOver).toBe(1);
    expect(h.calls).toHaveLength(0);
  });

  it('ticks concorrentes no mesmo instante contam UMA amostra', async () => {
    const h = fastHarness({ txBps: [0, 9_500_000_000, 9_500_000_000, 9_500_000_000] });
    expect((await h.tickAt(1)).samplesOver).toBe(1);
    h.at(2);
    const [a, b] = await Promise.all([h.engine.tick(), h.engine.tick()]);
    // A MESMA amostra entra uma única vez: os dois ticks veem 2 confirmações.
    expect([a[0]!.samplesOver, b[0]!.samplesOver]).toEqual([2, 2]);
    expect(h.calls).toHaveLength(0);
    expect((await h.tickAt(3)).outcome).toBe('ACTIVATED');
    expect(h.calls).toHaveLength(1);
  });

  it('amostra mais velha que 30 s vira TELEMETRY_UNAVAILABLE (sem fallback)', async () => {
    const h = fastHarness({ txBps: [0, 9_500_000_000, 9_500_000_000] });
    await h.tickAt(1);
    // Mesma amostra, 40 s depois da coleta: fora da janela FAST de 30 s.
    h.nowAt(5);
    const late = (await h.engine.tick())[0]!;
    expect(late).toMatchObject({ outcome: 'BLOCKED', reason: 'TELEMETRY_UNAVAILABLE' });
    expect(h.legacy.sampleWithId).not.toHaveBeenCalled();
  });

  it('amostra inválida (ADMIN_DOWN) nunca é aceita como zero', async () => {
    const h = fastHarness({
      txBps: [0, 9_500_000_000, 9_500_000_000],
      mutate: (row, index) => (index === 2 ? { ...row, quality: 'ADMIN_DOWN' } : row),
    });
    await h.tickAt(1);
    const invalid = await h.tickAt(2);
    expect(invalid.outcome).toBe('BLOCKED');
    expect(h.calls).toHaveLength(0);
  });
});

describe('FAST global: HOLD e AUTO manual preservado', () => {
  it('EXECUTION=0 com perfil promovido pelo sweep NÃO escreve (WOULD_ACTIVATE)', async () => {
    const h = fastHarness({
      txBps: [0, 9_500_000_000, 9_500_000_000, 9_500_000_000],
      executionControlEnabled: false,
      promotedBySweep: true,
    });
    await h.tickAt(1);
    await h.tickAt(2);
    const decision = await h.tickAt(3);
    expect(decision).toMatchObject({ outcome: 'WOULD_ACTIVATE', reason: 'AUTO_EXECUTION_DISABLED' });
    expect(h.calls).toHaveLength(0);
  });

  it('AUTO manual continua autorizado com EXECUTION=0 (compatibilidade)', async () => {
    const h = fastHarness({
      txBps: [0, 9_500_000_000, 9_500_000_000, 9_500_000_000],
      executionControlEnabled: false,
      promotedBySweep: false,
    });
    await h.tickAt(1);
    await h.tickAt(2);
    const decision = await h.tickAt(3);
    expect(decision.outcome).toBe('ACTIVATED');
    expect(h.calls).toHaveLength(1);
  });
});

describe('FAST global: segurança durante o HOLD', () => {
  // Ataque real da Justnet em 20/10 (85,5 Gbps em TX), acima do limiar de 9 G.
  const attack = [0, 85_500_000_000, 85_500_000_000, 85_500_000_000];

  it('ataque Justnet de 85,5 G: três amostras distintas ativam UMA única vez', async () => {
    const h = fastHarness({ txBps: attack });
    await h.tickAt(1);
    await h.tickAt(2);
    const decision = await h.tickAt(3);
    expect(decision).toMatchObject({ outcome: 'ACTIVATED', samplesOver: 3, direction: 'tx' });
    expect(decision.trafficBps).toBe('85500000000');
    expect(h.calls).toEqual(['just-2519']);
  });

  it('roteamento FAST ativo NÃO autoriza BGP: EXECUTION=0 bloqueia o promovido', async () => {
    const h = fastHarness({
      txBps: attack,
      executionControlEnabled: false,
      promotedBySweep: true,
    });
    // O perfil ESTÁ roteado para FAST e o ataque é real; ainda assim nada é escrito.
    expect(h.config.routedExplicit).toBe(true);
    expect(fastRoutingActive(h.config, 'just-2519')).toBe(true);
    await h.tickAt(1);
    await h.tickAt(2);
    const decision = await h.tickAt(3);
    expect(decision).toMatchObject({
      outcome: 'WOULD_ACTIVATE',
      reason: 'AUTO_EXECUTION_DISABLED',
      samplesOver: 3,
    });
    expect(h.calls).toHaveLength(0);
    expect(h.legacy.sampleWithId).not.toHaveBeenCalled();
  });

  it('ALERT_ONLY nunca executa, mesmo roteado para FAST e com ataque de 85,5 G', async () => {
    const h = fastHarness({ txBps: attack, targetMode: 'ALERT_ONLY' });
    await h.tickAt(1);
    await h.tickAt(2);
    const decision = await h.tickAt(3);
    expect(decision.outcome).toBe('ALERT_TRIGGERED');
    expect(h.calls).toHaveLength(0);
  });

  it('AUTO manual BHNET-3043 preserva o comportamento (FAST + ENFORCE, EXECUTION=0)', async () => {
    const h = fastHarness({
      txBps: [0, 9_500_000_000, 9_500_000_000, 9_500_000_000],
      profileId: 'bhnet-3043',
      policyName: 'PL-BHNET_IPv4-IN',
      promotedBySweep: false,
      executionControlEnabled: false,
      bridgeEnv: {
        MITIGATION_FAST_BRIDGE_MODE: 'ENFORCE',
        MITIGATION_FAST_BRIDGE_PROFILE_IDS: 'bhnet-3043',
        MITIGATION_FAST_ENFORCE_PROFILE_IDS: 'bhnet-3043',
        MITIGATION_FAST_ROUTED_PROFILE_IDS: 'bhnet-3043',
        MITIGATION_FAST_BRIDGE_WRITES_ENABLED: 'true',
      },
    });
    await h.tickAt(1);
    await h.tickAt(2);
    const decision = await h.tickAt(3);
    expect(decision.outcome).toBe('ACTIVATED');
    expect(h.calls).toEqual(['bhnet-3043']);
    // Consome FAST (não LEGACY): o perfil continua roteado como antes.
    expect(h.legacy.sampleWithId).not.toHaveBeenCalled();
  });
});

describe('FAST global: falha parcial do lote e reinício do observador', () => {
  it('lote SNMP incompleto não grava nenhuma amostra e o motor fica fail-closed', async () => {
    const appended: FastTrafficObservation[] = [];
    const store: FastTrafficStore = {
      append: async (o) => {
        appended.push(o);
        return true;
      },
      latest: async () => appended.at(-1) ?? null,
    };
    const target: FastTrafficTarget = {
      deviceId: DEVICE,
      interfaceId: 'if-2519',
      ifIndex: 2519,
      interfaceName: 'Eth-Trunk1.2519',
      speedBps: 300_000_000_000n,
      profiles: [{ profileId: 'just-2519', direction: 'tx', thresholdBps: 9_000_000_000n, bandwidthBps: BW }],
    };
    const poller = new FastTrafficPoller({
      config: fastPollerConfig({
        MITIGATION_FAST_POLL_MODE: 'OBSERVE',
        MITIGATION_FAST_PROFILE_IDS: 'just-2519',
      }),
      store,
      // Resposta parcial: o leitor devolve menos linhas que o lote.
      reader: { read: async () => [] },
      listTargets: async () => [target],
      now: () => new Date(BASE),
    });
    expect(poller.status().lastError).toBeNull();
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 700));
    await poller.stop();
    expect(appended).toEqual([]);
    expect(poller.status().failures).toBeGreaterThan(0);
    expect(poller.status().lastError).toBe('INCOMPLETE_RESPONSE');
  });

  it('reinício do observador recomeça em BASELINE: não reaproveita a amostra anterior', () => {
    const reads = [reading(0, 9_500_000_000), reading(1, 9_500_000_000)];
    const restarted = deriveFastTraffic(
      {
        deviceId: DEVICE,
        interfaceId: 'if-2519',
        ifIndex: 2519,
        interfaceName: 'Eth-Trunk1.2519',
        speedBps: 300_000_000_000n,
        profiles: [],
      },
      reads[1]!,
      undefined,
      'generation-2',
    );
    expect(restarted.quality).toBe('BASELINE');
    expect(restarted.rxBps).toBeNull();
    expect(restarted.txBps).toBeNull();
  });
});
