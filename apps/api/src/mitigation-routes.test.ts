import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthUser, HostRecord } from '@gmj/shared';
import { MitigationCommandService } from './infrastructure/bgp/mitigation/mitigation-command-service';
import { MockMitigationExecutor } from './infrastructure/bgp/mitigation/mitigation-executor';
import { registerMitigationRoutes } from './mitigation-routes';
import { InMemoryMitigationRepository } from './infrastructure/bgp/mitigation/in-memory-mitigation-repository';
import { BgpMitigationService } from './infrastructure/bgp/mitigation/mitigation-service';
import type { MitigationRepository } from './infrastructure/bgp/mitigation/mitigation-repository';
import { RoutingMitigationRepository } from './infrastructure/bgp/mitigation/mitigation-repository-router';

/** Prisma sem a migration aplicada: qualquer operacao estoura. */
function failingRepository(): MitigationRepository {
  const memory = new InMemoryMitigationRepository();
  return new Proxy(memory, {
    get(target, property, receiver) {
      if (typeof property === 'symbol') return Reflect.get(target, property, receiver);
      return async () => {
        throw new Error('relation "BgpMitigationProfile" does not exist');
      };
    },
  });
}
import type {
  MitigationDiscoveryProfile,
  MitigationDiscoveryResult,
} from './infrastructure/bgp/mitigation/mitigation-discovery-service';

const OPERATOR = { id: 'u1', username: 'operador', role: 'OPERATOR' } as unknown as AuthUser;
const FIXED_NOW = new Date('2026-01-01T12:00:00.000Z');

function host(id: string, label: string): HostRecord {
  return { id, hostname: label, displayName: label, name: label, sshEnabled: true } as unknown as HostRecord;
}

function discoveryRow(
  overrides: Partial<MitigationDiscoveryProfile> = {},
): MitigationDiscoveryProfile {
  return {
    profileId: null,
    policyName: 'PL-HORIZONTES_IPv4-IN',
    addressFamily: 'IPV4',
    sharedPolicy: false,
    sharedPolicyTargets: [],
    autoBlockedReason: null,
    customer: 'HORIZONTE_IP',
    interfaceId: 'if-1',
    interfaceName: 'Eth-Trunk1.3011',
    interfaceDescriptionRaw: 'HORIZONTE_IP_40GB',
    detectedBandwidthBps: 40_000_000_000n,
    effectiveBandwidthBps: 40_000_000_000n,
    bandwidthSource: 'DESCRIPTION',
    peerAddresses: ['10.200.200.106'],
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
  calls: string[] = [];
  rows: MitigationDiscoveryProfile[] = [];

  async discoverMitigationProfiles(hostRecord: HostRecord): Promise<MitigationDiscoveryResult> {
    this.calls.push(hostRecord.id);
    return {
      deviceId: hostRecord.id,
      scannedPeers: 32,
      candidateInterfaces: 8,
      ignoredNoBandwidth: 24,
      createdProfiles: 1,
      updatedProfiles: 0,
      blockedProfiles: 1,
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
}

async function buildHarness(
  options: { migrationReady?: boolean; authenticated?: boolean } = {},
): Promise<Harness> {
  const repository = new InMemoryMitigationRepository();
  const discovery = new FakeDiscovery();
  const hosts = new Map<string, HostRecord>([['device-1', host('device-1', 'BGP-01')]]);
  const app = Fastify();
  registerMitigationRoutes(app, {
    service: new BgpMitigationService({
      repository,
      discovery,
      hosts: { getHost: async (id) => hosts.get(id) ?? null },
      schemaProbe: {
        probe: async () => ({
          migrationReady: options.migrationReady ?? true,
          databaseReady: true,
        }),
      },
      repositoryKind: 'MEMORY',
      now: () => FIXED_NOW,
    }),
    currentUser: async () => (options.authenticated === false ? null : OPERATOR),
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ message: 'Invalid request', issues: error.issues });
    }
    return reply.code(500).send({ message: 'Internal server error' });
  });
  await app.ready();
  return { app, repository, discovery };
}

async function seedProfile(
  repository: InMemoryMitigationRepository,
  overrides: { prefixLimit?: number; detectedBandwidthBps?: bigint | null } = {},
) {
  const profile = await repository.upsertProfile({
    deviceId: 'device-1',
    policyName: 'PL-HORIZONTES_IPv4-IN',
    interfaceId: 'if-1',
    detectedBandwidthBps: overrides.detectedBandwidthBps ?? 40_000_000_000n,
    bandwidthSource: 'DESCRIPTION',
    prefixLimit: overrides.prefixLimit ?? 100,
  });
  await repository.replaceProfilePeers(profile.id, [
    { peerAddress: '10.200.200.10' },
    { peerAddress: '10.200.200.106', primary: true },
  ]);
  await repository.upsertRuntime(profile.id, { state: 'NORMAL', plannedBogonNode: 1, plannedMitigationNode: 2, plannedNode: 2 });
  return profile;
}

describe('API de mitigacao DDoS (SIMULATION_ONLY)', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) await app.close();
    app = null;
  });

  it('health informa modo simulacao, worker parado e migration ausente', async () => {
    const harness = await buildHarness({ migrationReady: false });
    app = harness.app;

    const response = await app.inject({ method: 'GET', url: '/api/bgp/mitigation/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mode: 'SIMULATION_ONLY',
      worker: { state: 'STOPPED' },
      migrationReady: false,
      databaseReady: true,
      repository: 'MEMORY',
    });
  });

  it('health continua 200 quando nada esta migrado', async () => {
    const harness = await buildHarness({ migrationReady: true });
    app = harness.app;

    const response = await app.inject({ method: 'GET', url: '/api/bgp/mitigation/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json().migrationReady).toBe(true);
  });

  it('lista profiles com BigInt serializado como string', async () => {
    const harness = await buildHarness();
    app = harness.app;
    await seedProfile(harness.repository);

    const response = await app.inject({ method: 'GET', url: '/api/bgp/mitigation/profiles' });
    const rows = response.json() as Record<string, unknown>[];

    expect(response.statusCode).toBe(200);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      persisted: true,
      deviceName: 'BGP-01',
      policyName: 'PL-HORIZONTES_IPv4-IN',
      detectedBandwidthBps: '40000000000',
      effectiveBandwidthBps: '40000000000',
      prefixLimit: 100,
      runtimeState: 'NORMAL',
      plannedBogonNode: 1,
      plannedMitigationNode: 2,
      plannedNode: 2,
      peerAddresses: ['10.200.200.10', '10.200.200.106'],
      primaryPeerAddress: '10.200.200.106',
    });
    expect(typeof rows[0]?.detectedBandwidthBps).toBe('string');
  });

  it('detalhe do profile e 404 quando nao existe', async () => {
    const harness = await buildHarness();
    app = harness.app;
    const profile = await seedProfile(harness.repository);

    const ok = await app.inject({
      method: 'GET',
      url: `/api/bgp/mitigation/profiles/${profile.id}`,
    });
    const missing = await app.inject({
      method: 'GET',
      url: '/api/bgp/mitigation/profiles/nao-existe',
    });

    expect(ok.statusCode).toBe(200);
    expect(ok.json().id).toBe(profile.id);
    expect(missing.statusCode).toBe(404);
  });

  it('discovery roda no servico e devolve resumo + candidato sem policy', async () => {
    const harness = await buildHarness();
    app = harness.app;
    const persisted = await seedProfile(harness.repository);
    harness.discovery.rows = [
      discoveryRow({ profileId: persisted.id }),
      discoveryRow({
        profileId: null,
        policyName: null,
        customer: 'CLIENTE_X',
        detectedBandwidthBps: 20_000_000_000n,
        effectiveBandwidthBps: 20_000_000_000n,
        readiness: 'NOT_READY',
        blockedReason: 'POLICY_NOT_FOUND',
        plannedNode: null,
      }),
    ];

    const response = await app.inject({
      method: 'POST',
      url: '/api/bgp/mitigation/discover',
      payload: { deviceId: 'device-1' },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(harness.discovery.calls).toEqual(['device-1']);
    expect(body).toMatchObject({
      deviceId: 'device-1',
      scannedPeers: 32,
      candidateInterfaces: 8,
      ignoredNoBandwidth: 24,
      createdProfiles: 1,
      blockedProfiles: 1,
    });
    expect(body.results).toHaveLength(1);
    expect(body.totals.devices).toBe(1);
    expect(body.profiles).toHaveLength(2);
    const candidate = body.profiles.find((row: { persisted: boolean }) => !row.persisted);
    expect(candidate).toMatchObject({
      policyName: null,
      customer: 'CLIENTE_X',
      readiness: 'NOT_READY',
      blockedReason: 'POLICY_NOT_FOUND',
      detectedBandwidthBps: '20000000000',
      persisted: false,
    });
    expect(String(candidate.id).startsWith('candidate:')).toBe(true);
  });

  it('discovery exige autenticacao e limita a 5 equipamentos', async () => {
    const anonymous = await buildHarness({ authenticated: false });
    const unauthorized = await anonymous.app.inject({
      method: 'POST',
      url: '/api/bgp/mitigation/discover',
      payload: { deviceId: 'device-1' },
    });
    await anonymous.app.close();

    const harness = await buildHarness();
    app = harness.app;
    const tooMany = await app.inject({
      method: 'POST',
      url: '/api/bgp/mitigation/discover',
      payload: { deviceIds: ['a', 'b', 'c', 'd', 'e', 'f'] },
    });
    const empty = await app.inject({
      method: 'POST',
      url: '/api/bgp/mitigation/discover',
      payload: {},
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(tooMany.statusCode).toBe(400);
    expect(empty.statusCode).toBe(400);
  });

  it('PATCH aceita apenas o override de banda e permite remove-lo', async () => {
    const harness = await buildHarness();
    app = harness.app;
    const profile = await seedProfile(harness.repository);

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/bgp/mitigation/profiles/${profile.id}`,
      payload: { bandwidthOverrideBps: '10000000000' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      bandwidthOverrideBps: '10000000000',
      detectedBandwidthBps: '40000000000',
      effectiveBandwidthBps: '10000000000',
    });

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/bgp/mitigation/profiles/${profile.id}`,
      payload: { bandwidthOverrideBps: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({
      bandwidthOverrideBps: null,
      effectiveBandwidthBps: '40000000000',
    });
  });

  it('PATCH aceita enabled/mode e rejeita qualquer campo arbitrario', async () => {
    const harness = await buildHarness();
    app = harness.app;
    const profile = await seedProfile(harness.repository);

    const admin = await app.inject({
      method: 'PATCH',
      url: `/api/bgp/mitigation/profiles/${profile.id}`,
      payload: { enabled: false, mode: 'ALERT_ONLY' },
    });
    expect(admin.statusCode).toBe(200);
    expect(admin.json()).toMatchObject({ enabled: false, mode: 'ALERT_ONLY' });

    for (const payload of [
      { policyName: 'PL-OUTRA-IN' },
      { mitigationRt: '1:2' },
      { node: 5 },
      { commands: ['system-view'] },
      { interfaceDescription: 'x' },
    ]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/bgp/mitigation/profiles/${profile.id}`,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });

  it('simulacao WOULD_MITIGATE com preview de comandos apenas textual', async () => {
    const harness = await buildHarness();
    app = harness.app;
    const profile = await seedProfile(harness.repository);

    const response = await app.inject({
      method: 'POST',
      url: `/api/bgp/mitigation/profiles/${profile.id}/simulate`,
      payload: { simulatedTrafficBps: '38700000000', samples: 3, simulatedPrefixCount: 12 },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toMatchObject({
      result: 'WOULD_MITIGATE',
      blockedReason: null,
      policyName: 'PL-HORIZONTES_IPv4-IN',
      thresholdBps: '36000000000',
      thresholdPercent: 90,
      effectiveBandwidthBps: '40000000000',
      utilizationPercent: 96.75,
      samples: 3,
      requiredSamples: 3,
      plannedBogonNode: 1,
      plannedMitigationNode: 2,
      plannedNode: 2,
      mitigationRt: '268568:660',
      affectedPeers: ['10.200.200.10', '10.200.200.106'],
      persisted: true,
    });
    expect(body.commandPreview).toEqual([
      'system-view',
      'route-policy PL-HORIZONTES_IPv4-IN deny node 1',
      ' if-match ip-prefix BOGONS',
      'route-policy PL-HORIZONTES_IPv4-IN permit node 2',
      ' if-match ip-prefix PREFIX8to24',
      ' apply extcommunity rt 268568:660 additive',
      'commit',
    ]);
    for (const command of body.commandPreview) {
      expect(typeof command).toBe('string');
    }
    // A simulacao nao dispara discovery/SSH nenhum.
    expect(harness.discovery.calls).toEqual([]);
  });

  it('simulacao WOULD_RECOVER quando ja mitigado e o trafego caiu', async () => {
    const harness = await buildHarness();
    app = harness.app;
    const profile = await seedProfile(harness.repository);
    await harness.repository.upsertRuntime(profile.id, { state: 'MITIGATED', plannedBogonNode: 1, plannedMitigationNode: 2, plannedNode: 2 });

    const response = await app.inject({
      method: 'POST',
      url: `/api/bgp/mitigation/profiles/${profile.id}/simulate`,
      payload: { simulatedTrafficBps: '10000000000', samples: 12, simulatedPrefixCount: 12 },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.result).toBe('WOULD_RECOVER');
    expect(body.commandPreview).toEqual([
      'system-view',
      'undo route-policy PL-HORIZONTES_IPv4-IN node 1',
      'undo route-policy PL-HORIZONTES_IPv4-IN node 2',
      'commit',
    ]);
  });

  it('simulacao BLOCKED quando os prefixos excedem o limite', async () => {
    const harness = await buildHarness();
    app = harness.app;
    const profile = await seedProfile(harness.repository);

    const response = await app.inject({
      method: 'POST',
      url: `/api/bgp/mitigation/profiles/${profile.id}/simulate`,
      payload: { simulatedTrafficBps: '38700000000', samples: 3, simulatedPrefixCount: 127 },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.result).toBe('BLOCKED');
    expect(body.blockedReason).toBe('PREFIX_LIMIT_EXCEEDED');
    expect(body.prefixStatus).toBe('EXCEEDED');
    expect(body.commandPreview).toEqual([]);
  });

  it('simulacao BLOCKED sem node seguro planejado', async () => {
    const harness = await buildHarness();
    app = harness.app;
    const profile = await seedProfile(harness.repository);
    await harness.repository.upsertRuntime(profile.id, { plannedNode: null });

    const response = await app.inject({
      method: 'POST',
      url: `/api/bgp/mitigation/profiles/${profile.id}/simulate`,
      payload: { simulatedTrafficBps: '38700000000', samples: 3, simulatedPrefixCount: 12 },
    });

    expect(response.json()).toMatchObject({
      result: 'BLOCKED',
      blockedReason: 'NO_SAFE_TEMPORARY_NODE',
      commandPreview: [],
    });
  });

  it('prefix count desconhecido bloqueia a simulacao (falha fechada)', async () => {
    const harness = await buildHarness();
    app = harness.app;
    const profile = await seedProfile(harness.repository);

    const response = await app.inject({
      method: 'POST',
      url: `/api/bgp/mitigation/profiles/${profile.id}/simulate`,
      payload: { simulatedTrafficBps: '38700000000', samples: 3 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      result: 'BLOCKED',
      blockedReason: 'PREFIX_UNKNOWN',
      prefixStatus: 'UNKNOWN',
      commandPreview: [],
    });
  });

  it('simulacao exige autenticacao e 404 para profile inexistente', async () => {
    const anonymous = await buildHarness({ authenticated: false });
    const unauthorized = await anonymous.app.inject({
      method: 'POST',
      url: '/api/bgp/mitigation/profiles/qualquer/simulate',
      payload: { simulatedTrafficBps: '1000000000', samples: 1 },
    });
    await anonymous.app.close();

    const harness = await buildHarness();
    app = harness.app;
    const missing = await app.inject({
      method: 'POST',
      url: '/api/bgp/mitigation/profiles/nao-existe/simulate',
      payload: { simulatedTrafficBps: '1000000000', samples: 1 },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(missing.statusCode).toBe(404);
  });

  it('nao existe endpoint generico de execucao de comandos', async () => {
    const harness = await buildHarness();
    app = harness.app;

    for (const url of [
      '/api/bgp/mitigation/execute',
      '/api/bgp/mitigation/commands',
      '/api/bgp/mitigation/profiles/x/apply',
    ]) {
      const response = await app.inject({ method: 'POST', url, payload: { commands: [] } });
      expect(response.statusCode).toBe(404);
    }
  });

  it('simulacoes e eventos listam o historico persistido', async () => {
    const harness = await buildHarness();
    app = harness.app;
    const profile = await seedProfile(harness.repository);
    await app.inject({
      method: 'POST',
      url: `/api/bgp/mitigation/profiles/${profile.id}/simulate`,
      payload: { simulatedTrafficBps: '38700000000', samples: 3, simulatedPrefixCount: 12 },
    });

    const simulations = await app.inject({
      method: 'GET',
      url: '/api/bgp/mitigation/simulations',
    });
    const events = await app.inject({ method: 'GET', url: '/api/bgp/mitigation/events' });

    expect(simulations.statusCode).toBe(200);
    expect(simulations.json()).toHaveLength(1);
    expect(simulations.json()[0]).toMatchObject({
      result: 'WOULD_MITIGATE',
      policyName: 'PL-HORIZONTES_IPv4-IN',
      simulatedTrafficBps: '38700000000',
    });
    expect(events.statusCode).toBe(200);
    expect(events.json()).toHaveLength(1);
    expect(events.json()[0]).toMatchObject({ type: 'SIMULATION', success: true });
  });

  it('sem migration aplicada a leitura devolve lista vazia sem quebrar', async () => {
    const repository = new InMemoryMitigationRepository();
    const failingListProfiles: MitigationRepository = new Proxy(repository, {
      get(target, property, receiver) {
        if (property === 'listProfiles') {
          return async () => {
            throw new Error('relation "BgpMitigationProfile" does not exist');
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const app2 = Fastify();
    registerMitigationRoutes(app2, {
      service: new BgpMitigationService({
        repository: failingListProfiles,
        discovery: new FakeDiscovery(),
        hosts: { getHost: async () => null },
        schemaProbe: { probe: async () => ({ migrationReady: false, databaseReady: true }) },
        repositoryKind: 'DATABASE',
      }),
    });
    app2.setErrorHandler((_error, _request, reply) =>
      reply.code(500).send({ message: 'Internal server error' }),
    );
    await app2.ready();

    const response = await app2.inject({ method: 'GET', url: '/api/bgp/mitigation/profiles' });
    const health = await app2.inject({ method: 'GET', url: '/api/bgp/mitigation/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    expect(health.json()).toMatchObject({ migrationReady: false, databaseReady: true });
    await app2.close();
  });

  it('descoberta funciona sem migration: guarda em memoria, lista e simula', async () => {
    const memory = new InMemoryMitigationRepository();
    const repository = new RoutingMitigationRepository(
      failingRepository(),
      memory,
      async () => false,
    );
    const discovery = {
      async discoverMitigationProfiles(hostRecord: HostRecord): Promise<MitigationDiscoveryResult> {
        const profile = await repository.upsertProfile({
          deviceId: hostRecord.id,
          policyName: 'PL-HORIZONTES_IPv4-IN',
          interfaceId: 'if-1',
          detectedBandwidthBps: 40_000_000_000n,
          bandwidthSource: 'DESCRIPTION',
        });
        await repository.replaceProfilePeers(profile.id, [
          { peerAddress: '10.200.200.106', primary: true },
        ]);
        await repository.upsertRuntime(profile.id, { state: 'NORMAL', plannedBogonNode: 1, plannedMitigationNode: 2, plannedNode: 2 });
        return {
          deviceId: hostRecord.id,
          scannedPeers: 1,
          candidateInterfaces: 1,
          ignoredNoBandwidth: 0,
          createdProfiles: 1,
          updatedProfiles: 0,
          blockedProfiles: 0,
          outOfScopeProfiles: [],
          ambiguousPeers: [],
          warnings: [],
          profiles: [discoveryRow({ profileId: profile.id })],
        };
      },
    };
    const app3 = Fastify();
    registerMitigationRoutes(app3, {
      service: new BgpMitigationService({
        repository,
        discovery,
        hosts: { getHost: async () => host('device-1', 'BGP-01') },
        schemaProbe: { probe: async () => ({ migrationReady: false, databaseReady: true }) },
        repositoryKind: 'DATABASE',
        now: () => FIXED_NOW,
      }),
      currentUser: async () => OPERATOR,
    });
    app3.setErrorHandler((_error, _request, reply) =>
      reply.code(500).send({ message: 'Internal server error' }),
    );
    await app3.ready();

    const discovered = await app3.inject({
      method: 'POST',
      url: '/api/bgp/mitigation/discover',
      payload: { deviceId: 'device-1' },
    });
    expect(discovered.statusCode).toBe(200);
    expect(discovered.json().profiles[0]).toMatchObject({
      persisted: true,
      policyName: 'PL-HORIZONTES_IPv4-IN',
      detectedBandwidthBps: '40000000000',
    });

    const listed = await app3.inject({ method: 'GET', url: '/api/bgp/mitigation/profiles' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);
    const profileId = listed.json()[0].id as string;
    expect(listed.json()[0]).toMatchObject({ deviceName: 'BGP-01', runtimeState: 'NORMAL' });

    const simulated = await app3.inject({
      method: 'POST',
      url: `/api/bgp/mitigation/profiles/${profileId}/simulate`,
      payload: { simulatedTrafficBps: '38700000000', samples: 3, simulatedPrefixCount: 12 },
    });
    expect(simulated.statusCode).toBe(200);
    expect(simulated.json()).toMatchObject({
      result: 'WOULD_MITIGATE',
      persisted: false,
      commandPreview: expect.arrayContaining(['commit']),
    });

    await app3.close();
  });

describe('comando INTERNO da UI (mesma camada do n8n)', () => {
  async function buildCommandsApp(authenticated = true) {
    const repository = new InMemoryMitigationRepository();
    const executor = new MockMitigationExecutor();
    executor.seedPolicy('PL-HORIZONTES_IPv4-IN', [11]);
    const profile = await repository.upsertProfile({
      deviceId: 'device-1',
      policyName: 'PL-HORIZONTES_IPv4-IN',
      interfaceId: 'if-3011',
      addressFamily: 'IPV4',
      detectedBandwidthBps: 40_000_000_000n,
      bandwidthSource: 'DESCRIPTION',
      prefixLimit: 100,
    });
    await repository.replaceProfilePeers(profile.id, [{ peerAddress: '10.200.200.106', primary: true }]);
    await repository.upsertRuntime(profile.id, { state: 'NORMAL', plannedBogonNode: 1, plannedMitigationNode: 2, plannedNode: 2 });

    const commands = new MitigationCommandService({
      repository,
      hosts: { getHost: async () => host('device-1', 'BGP-01') },
      executor,
      now: () => FIXED_NOW,
    });

    const app = Fastify();
    registerMitigationRoutes(app, {
      service: new BgpMitigationService({
        repository,
        discovery: new FakeDiscovery(),
        hosts: { getHost: async () => host('device-1', 'BGP-01') },
        schemaProbe: { probe: async () => ({ migrationReady: false, databaseReady: true }) },
        repositoryKind: 'DATABASE',
        now: () => FIXED_NOW,
      }),
      commands,
      currentUser: async () => (authenticated ? OPERATOR : null),
    });
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) return reply.code(400).send({ message: 'Invalid request' });
      return reply.code(500).send({ message: 'Internal server error' });
    });
    await app.ready();
    return { app, repository, executor, profileId: profile.id };
  }

  it('exige sessao do NetVision (nao usa token do n8n)', async () => {
    const anonymous = await buildCommandsApp(false);
    const response = await anonymous.app.inject({
      method: 'POST',
      url: `/api/bgp/mitigation/profiles/${anonymous.profileId}/command`,
      payload: { requestId: 'r1', action: 'STATUS' },
    });
    expect(response.statusCode).toBe(401);
    await anonymous.app.close();
  });

  it('delega ao mesmo servico: ACTIVATE devolve ACTIVATED_VERIFIED e usa o mock', async () => {
    const harness = await buildCommandsApp();
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/bgp/mitigation/profiles/${harness.profileId}/command`,
      payload: { requestId: 'ui-1', action: 'ACTIVATE' },
    });
    const body = response.json();
    expect(body).toMatchObject({ ok: true, status: 'ACTIVATED_VERIFIED', verified: true, node: 2, bogonNode: 1, mitigationNode: 2 });
    expect(body.verification.command).toBe('display route-policy PL-HORIZONTES_IPv4-IN');
    // executor e o MOCK (nada de SSH real)
    expect(harness.executor.calls).toContain('commit');
    expect((await harness.repository.getRuntime(harness.profileId))?.state).toBe('MITIGATED');
    await harness.app.close();
  });

  it('schema estrito: rejeita node/cli/policy vindos da UI', async () => {
    const harness = await buildCommandsApp();
    for (const extra of [{ node: 3 }, { cli: 'system-view' }, { policy: 'X' }]) {
      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/bgp/mitigation/profiles/${harness.profileId}/command`,
        payload: { requestId: 'ui-2', action: 'STATUS', ...extra },
      });
      expect(response.statusCode, JSON.stringify(extra)).toBe(400);
    }
    await harness.app.close();
  });

  it('idempotencia tambem vale na UI', async () => {
    const harness = await buildCommandsApp();
    const first = await harness.app.inject({
      method: 'POST',
      url: `/api/bgp/mitigation/profiles/${harness.profileId}/command`,
      payload: { requestId: 'ui-dup', action: 'ACTIVATE' },
    });
    const calls = harness.executor.calls.length;
    const second = await harness.app.inject({
      method: 'POST',
      url: `/api/bgp/mitigation/profiles/${harness.profileId}/command`,
      payload: { requestId: 'ui-dup', action: 'ACTIVATE' },
    });
    expect(first.json().idempotent).toBe(false);
    expect(second.json().idempotent).toBe(true);
    expect(harness.executor.calls.length).toBe(calls);
    await harness.app.close();
  });
});
});
