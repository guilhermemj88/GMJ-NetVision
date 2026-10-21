import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthUser, BgpMitigationProfileDto, HostRecord } from '@gmj/shared';
import { registerMitigationRoutes } from '../../../mitigation-routes';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import { BgpMitigationService } from './mitigation-service';
import type {
  MitigationDiscoveryProfile,
  MitigationDiscoveryResult,
} from './mitigation-discovery-service';
import {
  sharedPolicyAutomationBlocked,
  sharedPolicyScopeOf,
  sharedPolicyScopes,
} from './mitigation-shared-policy';
import { buildAutoShadowReport } from '../../../worker/mitigation/mitigation-auto-shadow';

// AUTO-ALL-PREDEPLOY-2: a decisao de "policy compartilhada" NAO pode depender do
// metadata do discovery. Estes testes reproduzem o E2E em que um segundo target
// da MESMA policy era aceito em AUTO porque `autoBlockedReason` vinha nulo, e
// fixam a regra nova: o escopo fisico vem dos PERFIS PERSISTIDOS.
// Nenhum teste aqui escreve em equipamento, n8n ou banco produtivo.

const OPERATOR = { id: 'u1', username: 'operador', role: 'OPERATOR' } as unknown as AuthUser;
const FIXED_NOW = new Date('2026-10-21T12:00:00.000Z');
const POLICY = 'PL-JUSTNET-IPv4-IN';

function dto(over: Partial<BgpMitigationProfileDto> & { id: string }): BgpMitigationProfileDto {
  return {
    persisted: true,
    customer: 'JUSTNET',
    deviceId: 'device-1',
    deviceName: 'BGP-01',
    interfaceId: 'if-1',
    interfaceName: 'Eth-Trunk1.2519',
    interfaceDescription: null,
    detectedBandwidthBps: '10000000000',
    bandwidthOverrideBps: null,
    effectiveBandwidthBps: '10000000000',
    policyName: POLICY,
    addressFamily: 'IPV4',
    sharedPolicy: false,
    sharedPolicyTargets: [],
    autoBlockedReason: null,
    peerAddresses: [],
    primaryPeerAddress: null,
    prefixCount: 10,
    prefixLimit: 100,
    prefixStatus: 'SAFE',
    existingNodes: [],
    mitigationNodes: [],
    plannedNode: 1,
    readiness: 'READY',
    blockedReason: null,
    snapshotAvailable: true,
    runtimeState: 'NORMAL',
    mode: 'ALERT_ONLY',
    enabled: true,
    mitigationRt: '268568:660',
    lastDiscoveryAt: null,
    ...over,
  } as unknown as BgpMitigationProfileDto;
}

describe('escopo de policy derivado dos perfis persistidos', () => {
  it('policy exclusiva => EXCLUSIVE e sem bloqueio', () => {
    const profiles = [dto({ id: 'p1' })];
    const scope = sharedPolicyScopeOf(profiles, 'p1')!;
    expect(scope).toMatchObject({ shared: false, classification: 'EXCLUSIVE', otherProfileIds: [] });
    expect(sharedPolicyAutomationBlocked(profiles[0]!, scope)).toBe(false);
  });

  it('duas interfaces do MESMO cliente => SAME_CUSTOMER (nao e ambiguidade de cliente)', () => {
    const profiles = [
      dto({ id: 'p1', interfaceId: 'if-1', interfaceName: 'Eth-Trunk1.2519' }),
      dto({ id: 'p2', interfaceId: 'if-2', interfaceName: 'Eth-Trunk1.2518' }),
    ];
    const scopes = sharedPolicyScopes(profiles);
    expect(scopes.get('p1')).toMatchObject({
      shared: true,
      classification: 'SAME_CUSTOMER',
      crossCustomer: false,
      sameCustomerInterfaces: true,
      otherProfileIds: ['p2'],
    });
    expect(scopes.get('p1')!.interfaceIds).toEqual(['if-1', 'if-2']);
  });

  it('clientes diferentes na MESMA policy => CROSS_CUSTOMER (caso BHNET CEASA x RBN)', () => {
    const profiles = [
      dto({ id: 'ceasa', customer: 'BHNET-CEASA', policyName: 'PL-BHNET_IPv4-IN', interfaceId: 'if-a' }),
      dto({ id: 'rbn', customer: 'BHNET-RBN', policyName: 'PL-BHNET_IPv4-IN', interfaceId: 'if-b' }),
    ];
    const scopes = sharedPolicyScopes(profiles);
    expect(scopes.get('ceasa')!.classification).toBe('CROSS_CUSTOMER');
    expect(scopes.get('rbn')!.classification).toBe('CROSS_CUSTOMER');
    expect(scopes.get('ceasa')!.customers).toEqual(['BHNET-CEASA', 'BHNET-RBN']);
  });

  it('mesmo nome de policy em DEVICES diferentes nao compartilha', () => {
    const profiles = [dto({ id: 'p1', deviceId: 'device-1' }), dto({ id: 'p2', deviceId: 'device-2' })];
    expect(sharedPolicyScopeOf(profiles, 'p1')!.classification).toBe('EXCLUSIVE');
    expect(sharedPolicyScopeOf(profiles, 'p2')!.classification).toBe('EXCLUSIVE');
  });

  it('perfil nao persistido (candidato sintetico) ou sem policy fica fora do mapa', () => {
    const profiles = [
      dto({ id: 'candidate:if-9', persisted: false, policyName: POLICY }),
      dto({ id: 'p-null', policyName: null }),
      dto({ id: 'p1' }),
    ];
    const scopes = sharedPolicyScopes(profiles);
    expect(scopes.has('candidate:if-9')).toBe(false);
    expect(scopes.has('p-null')).toBe(false);
    expect(scopes.get('p1')!.shared).toBe(false);
  });

  it('metadata ausente + escopo compartilhado => BLOQUEADO (lacuna que permitia AUTO)', () => {
    const profiles = [dto({ id: 'p1' }), dto({ id: 'p2', interfaceId: 'if-2' })];
    const scope = sharedPolicyScopeOf(profiles, 'p2')!;
    expect(profiles[1]!.autoBlockedReason).toBeNull();
    expect(sharedPolicyAutomationBlocked(profiles[1]!, scope)).toBe(true);
  });

  it('metadata SHARED_POLICY continua bloqueando mesmo sem irmao persistido (conservador)', () => {
    const profile = dto({ id: 'p1', autoBlockedReason: 'SHARED_POLICY' });
    expect(sharedPolicyAutomationBlocked(profile, sharedPolicyScopeOf([profile], 'p1'))).toBe(true);
  });
});

function host(id: string, label: string): HostRecord {
  return { id, hostname: label, displayName: label, name: label, sshEnabled: true } as unknown as HostRecord;
}

function discoveryRow(over: Partial<MitigationDiscoveryProfile> = {}): MitigationDiscoveryProfile {
  return {
    profileId: null,
    policyName: POLICY,
    addressFamily: 'IPV4',
    sharedPolicy: false,
    sharedPolicyTargets: [],
    autoBlockedReason: null,
    customer: 'JUSTNET',
    interfaceId: 'if-1',
    interfaceName: 'Eth-Trunk1.2519',
    interfaceDescriptionRaw: 'JUSTNET_10GB',
    detectedBandwidthBps: 10_000_000_000n,
    effectiveBandwidthBps: 10_000_000_000n,
    bandwidthSource: 'DESCRIPTION',
    peerAddresses: ['10.200.201.230'],
    prefixCount: 12,
    prefixLimit: 100,
    prefixStatus: 'SAFE',
    existingNodes: [11],
    mitigationNodes: [],
    firstNormalNode: 11,
    plannedNode: 1,
    readiness: 'READY',
    blockedReason: null,
    ...over,
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
      createdProfiles: 0,
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
  service: BgpMitigationService;
}

async function buildHarness(
  options: { sharedPolicyAllowedProfileIds?: string[]; guardEnabled?: boolean } = {},
): Promise<Harness> {
  const repository = new InMemoryMitigationRepository();
  const discovery = new FakeDiscovery();
  const hosts = new Map<string, HostRecord>([['device-1', host('device-1', 'BGP-01')]]);
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
    autoEnablement: {
      sharedPolicyGuardEnabled: options.guardEnabled ?? true,
      sharedPolicyAllowedProfileIds: options.sharedPolicyAllowedProfileIds ?? [],
      approvedFamilyPairs: [],
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
  return { app, repository, discovery, service };
}

async function seed(
  repository: InMemoryMitigationRepository,
  over: {
    policyName?: string;
    interfaceId?: string;
    addressFamily?: 'IPV4' | 'IPV6';
    mode?: 'DISABLED' | 'ALERT_ONLY' | 'AUTO';
  } = {},
) {
  return repository.upsertProfile({
    deviceId: 'device-1',
    policyName: over.policyName ?? POLICY,
    interfaceId: over.interfaceId ?? 'if-1',
    addressFamily: over.addressFamily ?? 'IPV4',
    detectedBandwidthBps: 10_000_000_000n,
    bandwidthSource: 'DESCRIPTION',
    ...(over.mode ? { mode: over.mode } : {}),
  });
}

const patchAuto = (app: FastifyInstance, id: string, body: Record<string, unknown> = {}) =>
  app.inject({ method: 'PATCH', url: `/api/bgp/mitigation/profiles/${id}`, payload: { mode: 'AUTO', ...body } });

let app: FastifyInstance | null = null;
afterEach(async () => {
  if (app) await app.close();
  app = null;
});

describe('E2E: promocao para AUTO com metadata de policy ausente', () => {
  it('reproducao: 2o target da mesma policy e RECUSADO (409 SHARED_POLICY) sem metadata', async () => {
    const harness = await buildHarness();
    app = harness.app;
    const first = await seed(harness.repository, { interfaceId: 'if-1' });
    const second = await seed(harness.repository, { interfaceId: 'if-2' });
    // Discovery rodou, mas NAO marcou SHARED_POLICY (metadata incompleto).
    harness.discovery.rows = [
      discoveryRow({ profileId: first.id, interfaceId: 'if-1' }),
      discoveryRow({ profileId: second.id, interfaceId: 'if-2', interfaceName: 'Eth-Trunk1.2518' }),
    ];
    const before = await harness.service.listProfiles();
    expect(before.find((p) => p.id === second.id)!.autoBlockedReason).toBeNull();

    const blocked = await patchAuto(app, second.id);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'SHARED_POLICY' });
    // Nada foi promovido.
    expect((await harness.repository.getProfile(second.id))!.mode).toBe('ALERT_ONLY');
  });

  it('confirmacao explicita libera a promocao (acknowledgeSharedPolicy)', async () => {
    const harness = await buildHarness();
    app = harness.app;
    await seed(harness.repository, { interfaceId: 'if-1' });
    const second = await seed(harness.repository, { interfaceId: 'if-2' });
    const ok = await patchAuto(app, second.id, { acknowledgeSharedPolicy: true });
    expect(ok.statusCode).toBe(200);
    expect((await harness.repository.getProfile(second.id))!.mode).toBe('AUTO');
  });

  it('allowlist no ENV libera a promocao', async () => {
    const harness = await buildHarness();
    app = harness.app;
    await seed(harness.repository, { interfaceId: 'if-1' });
    const second = await seed(harness.repository, { interfaceId: 'if-2' });
    const allowed = await buildHarness({ sharedPolicyAllowedProfileIds: [second.id] });
    app = allowed.app;
    await seed(allowed.repository, { interfaceId: 'if-1' });
    const target = await seed(allowed.repository, { interfaceId: 'if-3' });
    const ok = await patchAuto(app, target.id);
    expect(ok.statusCode).toBe(200);
  });

  it('policy exclusiva continua promovendo sem confirmacao (nao-regressao)', async () => {
    const harness = await buildHarness();
    app = harness.app;
    const only = await seed(harness.repository, { policyName: 'PL-SUPERNET-IPv4-IN', interfaceId: 'if-7' });
    const ok = await patchAuto(app, only.id);
    expect(ok.statusCode).toBe(200);
    expect((await harness.repository.getProfile(only.id))!.mode).toBe('AUTO');
  });

  it('IPv6 irmao na MESMA interface tambem conta como escopo compartilhado', async () => {
    const harness = await buildHarness();
    app = harness.app;
    await seed(harness.repository, { interfaceId: 'if-1', addressFamily: 'IPV4' });
    const v6 = await seed(harness.repository, { interfaceId: 'if-1', addressFamily: 'IPV6' });
    const res = await patchAuto(app, v6.id);
    expect([409]).toContain(res.statusCode);
    expect(['SHARED_POLICY', 'FAMILY_CONTENTION']).toContain(res.json().code);
  });
});

describe('relatorio de sombra expoe o escopo persistido', () => {
  it('marca sharedPolicy/sharedPolicyAutomationBlocked mesmo sem metadata de discovery', async () => {
    const harness = await buildHarness();
    app = harness.app;
    const a = await seed(harness.repository, { interfaceId: 'if-1' });
    const b = await seed(harness.repository, { interfaceId: 'if-2' });
    const report = buildAutoShadowReport({
      generatedAt: FIXED_NOW.toISOString(),
      profiles: await harness.service.listProfiles(),
      runtime: null,
    });
    const entryA = report.entries.find((entry) => entry.profileId === a.id)!;
    const entryB = report.entries.find((entry) => entry.profileId === b.id)!;
    expect(entryA).toMatchObject({ sharedPolicy: true, sharedPolicyAutomationBlocked: true });
    expect(entryB).toMatchObject({ sharedPolicy: true, sharedPolicyAutomationBlocked: true });
    expect(report.summary.total).toBe(2);
  });

  it('perfil exclusivo nao aparece como compartilhado', async () => {
    const harness = await buildHarness();
    app = harness.app;
    const only = await seed(harness.repository, { interfaceId: 'if-7', policyName: 'PL-RNJ_IPv4-IN' });
    const report = buildAutoShadowReport({
      generatedAt: FIXED_NOW.toISOString(),
      profiles: await harness.service.listProfiles(),
      runtime: null,
    });
    expect(report.entries.find((entry) => entry.profileId === only.id)).toMatchObject({
      sharedPolicy: false,
      sharedPolicyAutomationBlocked: false,
    });
  });
});
