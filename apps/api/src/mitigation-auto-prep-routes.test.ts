import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthUser, HostRecord } from '@gmj/shared';
import { registerMitigationRoutes } from './mitigation-routes';
import { InMemoryMitigationRepository } from './infrastructure/bgp/mitigation/in-memory-mitigation-repository';
import { BgpMitigationService } from './infrastructure/bgp/mitigation/mitigation-service';
import type {
  MitigationDiscoveryProfile,
  MitigationDiscoveryResult,
} from './infrastructure/bgp/mitigation/mitigation-discovery-service';
import { buildAutoShadowReport } from './worker/mitigation/mitigation-auto-shadow';
import type { MitigationAutoRuntimeStatus } from './worker/mitigation/mitigation-auto-runtime';
import type { MitigationAutoDecision } from './worker/mitigation/mitigation-auto-engine';

// AUTO-ALL-PREP-1: PATCH de direcao por perfil + gates de configuracao para
// promover um perfil a AUTO + endpoint de SOMBRA (somente leitura).
// Nenhum teste aqui escreve em equipamento, n8n ou banco produtivo.

const OPERATOR = { id: 'u1', username: 'operador', role: 'OPERATOR' } as unknown as AuthUser;
const FIXED_NOW = new Date('2026-10-13T12:00:00.000Z');

function host(id: string, label: string): HostRecord {
  return { id, hostname: label, displayName: label, name: label, sshEnabled: true } as unknown as HostRecord;
}

function discoveryRow(overrides: Partial<MitigationDiscoveryProfile> = {}): MitigationDiscoveryProfile {
  return {
    profileId: null,
    policyName: 'PL-BHNET_IPv4-IN',
    addressFamily: 'IPV4',
    sharedPolicy: false,
    sharedPolicyTargets: [],
    autoBlockedReason: null,
    customer: 'BHNET-CEASA',
    interfaceId: 'if-1',
    interfaceName: 'Eth-Trunk1.3043',
    interfaceDescriptionRaw: 'BHNET-CEASA_10GB',
    detectedBandwidthBps: 10_000_000_000n,
    effectiveBandwidthBps: 10_000_000_000n,
    bandwidthSource: 'DESCRIPTION',
    peerAddresses: ['10.200.200.222'],
    prefixCount: 12,
    prefixLimit: 100,
    prefixStatus: 'SAFE',
    existingNodes: [11],
    mitigationNodes: [],
    firstNormalNode: 11,
    plannedNode: 1,
    readiness: 'READY',
    blockedReason: null,
    ...overrides,
  };
}

class FakeDiscovery {
  rows: MitigationDiscoveryProfile[] = [];
  async discoverMitigationProfiles(hostRecord: HostRecord): Promise<MitigationDiscoveryResult> {
    return {
      deviceId: hostRecord.id,
      scannedPeers: 32,
      candidateInterfaces: 8,
      ignoredNoBandwidth: 24,
      createdProfiles: this.rows.length,
      updatedProfiles: 0,
      blockedProfiles: 0,
      outOfScopeProfiles: [],
      ambiguousPeers: [],
      profiles: this.rows,
      warnings: [],
    };
  }
}

interface Harness {
  app: FastifyInstance;
  repository: InMemoryMitigationRepository;
  discovery: FakeDiscovery;
  runtimeStatus: { current: MitigationAutoRuntimeStatus | null };
}

async function buildHarness(
  options: {
    autoShadow?: boolean;
    sharedPolicyAllowedProfileIds?: string[];
    approvedFamilyPairs?: [string, string][];
  } = {},
): Promise<Harness> {
  const repository = new InMemoryMitigationRepository();
  const discovery = new FakeDiscovery();
  const hosts = new Map<string, HostRecord>([['device-1', host('device-1', 'BGP-01')]]);
  const runtimeStatus: { current: MitigationAutoRuntimeStatus | null } = { current: null };
  const service = new BgpMitigationService({
    repository,
    discovery,
    hosts: { getHost: async (id) => hosts.get(id) ?? null },
    schemaProbe: { probe: async () => ({ migrationReady: true, databaseReady: true }) },
    repositoryKind: 'MEMORY',
    interfaceMetadataRefresher: { refresh: async () => ({ interfaces: 203 }) },
    now: () => FIXED_NOW,
  });
  const app = Fastify();
  registerMitigationRoutes(app, {
    service,
    ...(options.autoShadow
      ? {
          autoShadow: async () =>
            buildAutoShadowReport({
              generatedAt: FIXED_NOW.toISOString(),
              profiles: await service.listProfiles(),
              runtime: runtimeStatus.current,
            }),
        }
      : {}),
    autoEnablement: {
      sharedPolicyGuardEnabled: true,
      sharedPolicyAllowedProfileIds: options.sharedPolicyAllowedProfileIds ?? [],
      approvedFamilyPairs: options.approvedFamilyPairs ?? [],
    },
    currentUser: async () => OPERATOR,
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ message: 'Invalid request', issues: error.issues });
    }
    return reply.code(500).send({ message: 'Internal server error' });
  });
  await app.ready();
  return { app, repository, discovery, runtimeStatus };
}

async function seedProfile(
  repository: InMemoryMitigationRepository,
  overrides: {
    addressFamily?: 'IPV4' | 'IPV6';
    policyName?: string;
    interfaceId?: string;
    mode?: 'DISABLED' | 'ALERT_ONLY' | 'AUTO';
    direction?: 'RX' | 'TX' | null;
  } = {},
) {
  const profile = await repository.upsertProfile({
    deviceId: 'device-1',
    policyName: overrides.policyName ?? 'PL-BHNET_IPv4-IN',
    interfaceId: overrides.interfaceId ?? 'if-1',
    addressFamily: overrides.addressFamily ?? 'IPV4',
    detectedBandwidthBps: 10_000_000_000n,
    bandwidthSource: 'DESCRIPTION',
    ...(overrides.mode ? { mode: overrides.mode } : {}),
  });
  await repository.replaceProfilePeers(profile.id, [
    { peerAddress: '10.200.200.222', primary: true },
  ]);
  await repository.upsertRuntime(profile.id, {
    state: 'NORMAL',
    plannedBogonNode: 1,
    plannedMitigationNode: 2,
    plannedNode: 2,
  });
  if (overrides.direction !== undefined) {
    await repository.setProfileAutoTrafficDirection(profile.id, overrides.direction);
  }
  return profile;
}

function decision(over: Partial<MitigationAutoDecision> = {}): MitigationAutoDecision {
  return {
    at: FIXED_NOW.toISOString(),
    profileId: 'p-1',
    deviceId: 'device-1',
    customer: 'BHNET-CEASA',
    outcome: 'ALERT_TRIGGERED',
    reason: null,
    trafficBps: '9500000000',
    thresholdBps: '9000000000',
    recoveryThresholdBps: '7000000000',
    samplesOver: 3,
    samplesBelow: 0,
    requiredSamples: 3,
    runtimeState: 'NORMAL',
    sharedPolicy: false,
    addressFamily: 'IPV4',
    direction: 'tx',
    directionSource: 'PROFILE',
    sharedPolicyAutomationBlocked: false,
    requestId: null,
    commandStatus: null,
    verified: false,
    notification: { published: false, skipped: true },
    detail: null,
    ...over,
  };
}

describe('AUTO-ALL-PREP-1: direcao por perfil no PATCH', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it('1) define e limpa a direcao (RX/TX) com validacao estrita', async () => {
    const harness = await buildHarness();
    app = harness.app;
    const profile = await seedProfile(harness.repository);

    const set = await app.inject({
      method: 'PATCH',
      url: `/api/bgp/mitigation/profiles/${profile.id}`,
      payload: { autoTrafficDirection: 'TX' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ autoTrafficDirection: 'TX' });

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/bgp/mitigation/profiles/${profile.id}`,
      payload: { autoTrafficDirection: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ autoTrafficDirection: null });

    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/bgp/mitigation/profiles/${profile.id}`,
      payload: { autoTrafficDirection: 'AMBOS' },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('2) rediscovery NAO sobrescreve a direcao escolhida pelo operador', async () => {
    const harness = await buildHarness();
    app = harness.app;
    const profile = await seedProfile(harness.repository, { direction: 'RX' });
    harness.discovery.rows = [
      discoveryRow({ profileId: profile.id, policyName: profile.policyName }),
    ];

    const discovered = await app.inject({
      method: 'POST',
      url: '/api/bgp/mitigation/discover',
      payload: { deviceId: 'device-1' },
    });
    expect(discovered.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/api/bgp/mitigation/profiles' });
    const rows = list.json() as { id: string; autoTrafficDirection: string | null }[];
    expect(rows.find((row) => row.id === profile.id)?.autoTrafficDirection).toBe('RX');
  });
});

describe('AUTO-ALL-PREP-1: gates de configuracao para promover a AUTO', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it('3) policy compartilhada exige confirmacao explicita (409 SHARED_POLICY)', async () => {
    const harness = await buildHarness();
    app = harness.app;
    const profile = await seedProfile(harness.repository);
    harness.discovery.rows = [
      discoveryRow({
        profileId: profile.id,
        sharedPolicy: true,
        sharedPolicyTargets: [
          {
            interfaceId: 'if-2',
            interfaceName: 'Eth-Trunk1.3044',
            customer: 'BHNET-RBN',
            peerAddress: '10.200.200.226',
            addressFamily: 'IPV4',
            prefixCount: 8,
            prefixStatus: 'SAFE',
          },
        ],
        autoBlockedReason: 'SHARED_POLICY',
      }),
    ];
    await app.inject({
      method: 'POST',
      url: '/api/bgp/mitigation/discover',
      payload: { deviceId: 'device-1' },
    });

    const blocked = await app.inject({
      method: 'PATCH',
      url: `/api/bgp/mitigation/profiles/${profile.id}`,
      payload: { mode: 'AUTO' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'SHARED_POLICY' });

    const acknowledged = await app.inject({
      method: 'PATCH',
      url: `/api/bgp/mitigation/profiles/${profile.id}`,
      payload: { mode: 'AUTO', acknowledgeSharedPolicy: true },
    });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json()).toMatchObject({ mode: 'AUTO' });
  });

  it('4) allowlist do ENV libera a promocao sem confirmacao', async () => {
    // O espelho em memoria gera ids deterministas (`profile-1`): a allowlist do
    // ENV e por ID, exatamente como no drop-in do systemd.
    const harness = await buildHarness({ sharedPolicyAllowedProfileIds: ['profile-1'] });
    app = harness.app;
    const profile = await seedProfile(harness.repository);
    expect(profile.id).toBe('profile-1');
    harness.discovery.rows = [
      discoveryRow({ profileId: profile.id, sharedPolicy: true, autoBlockedReason: 'SHARED_POLICY' }),
    ];
    await app.inject({
      method: 'POST',
      url: '/api/bgp/mitigation/discover',
      payload: { deviceId: 'device-1' },
    });

    const allowed = await app.inject({
      method: 'PATCH',
      url: `/api/bgp/mitigation/profiles/${profile.id}`,
      payload: { mode: 'AUTO' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({ mode: 'AUTO' });
  });

  it('5) par IPv4/IPv6 no mesmo escopo exige aprovacao (409 FAMILY_CONTENTION)', async () => {
    const harness = await buildHarness();
    app = harness.app;
    const v4 = await seedProfile(harness.repository, {
      addressFamily: 'IPV4',
      policyName: 'PL-BHNET_IPv4-IN',
      direction: 'TX',
      mode: 'AUTO',
    });
    const v6 = await seedProfile(harness.repository, {
      addressFamily: 'IPV6',
      policyName: 'PL-BHNET_IPv6-IN',
    });

    const blocked = await app.inject({
      method: 'PATCH',
      url: `/api/bgp/mitigation/profiles/${v6.id}`,
      payload: { mode: 'AUTO' },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'FAMILY_CONTENTION' });

    const acknowledged = await app.inject({
      method: 'PATCH',
      url: `/api/bgp/mitigation/profiles/${v6.id}`,
      payload: { mode: 'AUTO', acknowledgeFamilyContention: true },
    });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json()).toMatchObject({ mode: 'AUTO' });
    expect(v4.id).not.toBe(v6.id);
  });
});

describe('AUTO-ALL-PREP-1: relatorio de SOMBRA (somente leitura)', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it('6) devolve por perfil: direcao, amostras, WOULD_ACTIVATE e entrega LOG_ONLY', async () => {
    const harness = await buildHarness({ autoShadow: true });
    app = harness.app;
    const auto = await seedProfile(harness.repository, {
      policyName: 'PL-BHNET_IPv4-IN',
      direction: 'TX',
      mode: 'AUTO',
    });
    const shadow = await seedProfile(harness.repository, {
      addressFamily: 'IPV6',
      policyName: 'PL-BHNET_IPv6-IN',
      direction: 'RX',
    });
    harness.runtimeStatus.current = {
      state: 'RUNNING',
      evaluationIntervalMs: 5000,
      startedAt: FIXED_NOW.toISOString(),
      lastTickAt: FIXED_NOW.toISOString(),
      lastSuccessfulTickAt: FIXED_NOW.toISOString(),
      lastError: null,
      tickCount: 1,
      skippedTicks: 0,
      lastDecision: null,
      decisions: [
        decision({ profileId: auto.id, outcome: 'NO_ACTION', reason: 'THRESHOLD_NOT_EXCEEDED' }),
        decision({ profileId: shadow.id, addressFamily: 'IPV6', direction: 'rx' }),
      ],
      lastAutoActivateAt: null,
      lastAutoActivateProfileId: null,
    } as MitigationAutoRuntimeStatus;

    const response = await app.inject({
      method: 'GET',
      url: '/api/bgp/mitigation/auto/shadow',
    });
    expect(response.statusCode).toBe(200);
    const report = response.json() as {
      engine: { state: string };
      summary: Record<string, number>;
      entries: {
        profileId: string;
        direction: string | null;
        directionSource: string | null;
        samplesOver: number;
        requiredSamples: number;
        wouldActivate: boolean;
        notificationDelivery: string;
      }[];
    };
    expect(report.engine.state).toBe('RUNNING');
    expect(report.summary.total).toBe(2);
    expect(report.summary.directionConfigured).toBe(2);
    expect(report.summary.shadowActive).toBe(1);
    const shadowEntry = report.entries.find((entry) => entry.profileId === shadow.id)!;
    expect(shadowEntry).toMatchObject({
      direction: 'RX',
      directionSource: 'PROFILE',
      samplesOver: 3,
      requiredSamples: 3,
      wouldActivate: true,
      notificationDelivery: 'LOG_ONLY',
    });
  });

  it('7) endpoint de sombra nao existe quando o processo nao hospeda o motor', async () => {
    const harness = await buildHarness();
    app = harness.app;
    const response = await app.inject({ method: 'GET', url: '/api/bgp/mitigation/auto/shadow' });
    expect(response.statusCode).toBe(404);
  });
});
