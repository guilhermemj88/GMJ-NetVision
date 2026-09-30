import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthUser, HostRecord } from '@gmj/shared';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import { MitigationCommandService, type MitigationLiveExecutorPort } from './mitigation-command-service';
import { MockMitigationExecutor } from './mitigation-executor';
import { BgpMitigationService } from './mitigation-service';
import type { MitigationPreflightInput, MitigationPreflightResult } from './huawei-mitigation-executor';
import type { MitigationActivationInput, MitigationRemovalInput } from './mitigation-executor';
import type { MitigationDiscoveryResult } from './mitigation-discovery-service';
import { registerMitigationRoutes } from '../../../mitigation-routes';
import { registerN8nRoutes } from '../../../n8n-routes';

const OPERATOR = { id: 'u1', username: 'operador', role: 'OPERATOR' } as unknown as AuthUser;
const POLICY = 'PL-BHNET_IPv4-IN';
const FIXED_NOW = new Date('2026-09-30T18:00:00.000Z');

function host(label = 'BHE-VTA-F1A-BGP-01'): HostRecord {
  return {
    id: 'device-1',
    hostname: label,
    displayName: label,
    name: label,
    sshEnabled: true,
  } as unknown as HostRecord;
}

function discoveryStub(): { discoverMitigationProfiles: () => Promise<MitigationDiscoveryResult> } {
  return {
    async discoverMitigationProfiles() {
      return {
        deviceId: 'device-1',
        scannedPeers: 0,
        candidateInterfaces: 0,
        ignoredNoBandwidth: 0,
        createdProfiles: 0,
        updatedProfiles: 0,
        blockedProfiles: 0,
        outOfScopeProfiles: [],
        ambiguousPeers: [],
        warnings: [],
        profiles: [],
      };
    },
  };
}

const READBACK_ACTIVE = [
  `route-policy ${POLICY} deny node 1`,
  ' if-match ip-prefix BOGONS',
  `route-policy ${POLICY} permit node 2`,
  ' if-match ip-prefix PREFIX8to24',
  ' apply extcommunity rt 268568:660 additive',
  `route-policy ${POLICY} permit node 10`,
].join('\n');

/** Executor "real" falso: conta toda interacao (nenhuma pode acontecer quando excluido). */
class CountingLiveExecutor implements MitigationLiveExecutorPort {
  preflightCalls = 0;
  activateCalls = 0;
  removeCalls = 0;
  readRoutePolicyCalls = 0;
  devicePair: { bogonNode: number; mitigationNode: number } | null = { bogonNode: 1, mitigationNode: 2 };
  preflightOk = true;

  enabledFor(): boolean {
    return true;
  }

  async resolveActivePair() {
    return this.devicePair;
  }

  async preflight(_device: HostRecord, input: MitigationPreflightInput): Promise<MitigationPreflightResult> {
    this.preflightCalls += 1;
    return {
      ok: this.preflightOk,
      mode: input.mode,
      deviceId: 'device-1',
      deviceName: 'BHE-VTA-F1A-BGP-01',
      deviceHost: '10.0.0.1',
      policyName: input.policyName,
      existingNodes: [10, 100],
      bogonNode: input.bogonNode,
      mitigationNode: input.mitigationNode,
      bogonPrefixList: input.bogonPrefixList,
      bogonPrefixListExists: true,
      targetPrefixList: input.targetPrefixList,
      targetPrefixListExists: true,
      rt: input.rt,
      sshReadBackOk: true,
      bogonNodeExists: true,
      bogonNodeMatches: true,
      mitigationNodeExists: true,
      mitigationNodeMatches: true,
      partial: false,
      readBackNodes: [1, 2, 10, 100],
      readBackSummary: 'par ativo',
      readBackExcerpt: '',
      checks: [],
      blockedReasons: this.preflightOk ? [] : ['preflight falhou'],
    };
  }

  async activate(_device: HostRecord, _input: MitigationActivationInput): Promise<{ output: string }> {
    this.activateCalls += 1;
    return { output: 'ok' };
  }

  async remove(_device: HostRecord, _input: MitigationRemovalInput): Promise<{ output: string }> {
    this.removeCalls += 1;
    this.devicePair = null;
    return { output: 'ok' };
  }

  async readRoutePolicy(): Promise<string> {
    this.readRoutePolicyCalls += 1;
    return this.devicePair ? READBACK_ACTIVE : 'route-policy PL-BHNET_IPv4-IN permit node 10';
  }
}

async function seed(options: {
  excluded?: boolean;
  reason?: 'UPLINK' | 'TRANSIT' | 'IX' | 'BACKBONE' | 'MANUAL';
  note?: string | null;
  policy?: string;
  customer?: string;
} = {}) {
  const repository = new InMemoryMitigationRepository();
  const profile = await repository.upsertProfile({
    deviceId: 'device-1',
    policyName: options.policy ?? POLICY,
    interfaceId: 'if-1',
    addressFamily: 'IPV4',
    detectedBandwidthBps: 10_000_000_000n,
    bandwidthSource: 'DESCRIPTION',
    prefixLimit: 100,
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
  if (options.excluded) {
    await repository.setProfileExclusion(profile.id, {
      excluded: true,
      reason: options.reason ?? 'UPLINK',
      note: options.note ?? null,
    });
  }
  return { repository, profileId: profile.id, policy: options.policy ?? POLICY };
}

function commands(repository: InMemoryMitigationRepository, live?: CountingLiveExecutor) {
  return new MitigationCommandService({
    repository,
    hosts: { getHost: async () => host() },
    executor: new MockMitigationExecutor(),
    ...(live ? { live } : {}),
    now: () => FIXED_NOW,
  });
}

function serviceFor(repository: InMemoryMitigationRepository) {
  return new BgpMitigationService({
    repository,
    discovery: discoveryStub() as never,
    hosts: { getHost: async () => host() },
    schemaProbe: { probe: async () => ({ migrationReady: true, databaseReady: true }) },
    repositoryKind: 'DATABASE',
    now: () => FIXED_NOW,
  });
}

async function appFor(service: BgpMitigationService): Promise<FastifyInstance> {
  const app = Fastify();
  registerMitigationRoutes(app, { service, currentUser: async () => OPERATOR });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ message: 'Invalid request' });
    return reply.code(500).send({ message: 'Internal server error' });
  });
  await app.ready();
  return app;
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  if (app) await app.close();
  app = null;
});

describe('exclusao permanente de peers da mitigacao (Fase 13)', () => {
  it('1) profile nasce com mitigationExcluded=false', async () => {
    const { repository, profileId } = await seed();
    const record = await repository.getProfile(profileId);
    expect(record?.mitigationExcluded).toBe(false);
    expect(record?.mitigationExclusionReason).toBeNull();
    expect(record?.mitigationExclusionNote).toBeNull();
  });

  it('2) ativar exclusao persiste motivo e observacao', async () => {
    const { repository, profileId } = await seed();
    await repository.setProfileExclusion(profileId, {
      excluded: true,
      reason: 'UPLINK',
      note: 'Upstream principal',
    });
    const record = await repository.getProfile(profileId);
    expect(record?.mitigationExcluded).toBe(true);
    expect(record?.mitigationExclusionReason).toBe('UPLINK');
    expect(record?.mitigationExclusionNote).toBe('Upstream principal');
  });

  it('3) exclusao sobrevive a uma nova instancia do repository (persistencia)', async () => {
    const { repository, profileId } = await seed();
    await repository.setProfileExclusion(profileId, { excluded: true, reason: 'TRANSIT' });
    const outraInstancia = new InMemoryMitigationRepository(repository.storeRef);
    const record = await outraInstancia.getProfile(profileId);
    expect(record?.mitigationExcluded).toBe(true);
    expect(record?.mitigationExclusionReason).toBe('TRANSIT');
  });

  it('4+5) ACTIVATE em target excluido e bloqueado ANTES de qualquer interacao com o executor', async () => {
    const live = new CountingLiveExecutor();
    const { repository, profileId } = await seed({ excluded: true, reason: 'IX' });
    const result = await commands(repository, live).execute({
      requestId: 'excl-act-1',
      action: 'ACTIVATE',
      profileId,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('MITIGATION_EXCLUDED');
    expect(result.blockedReason).toBe('MITIGATION_EXCLUDED');
    expect(result.commandPreview).toEqual([]);
    expect(result.safeError).toContain('administrativamente');
    expect(live.preflightCalls).toBe(0);
    expect(live.activateCalls).toBe(0);
    expect(live.readRoutePolicyCalls).toBe(0);
  });

  it('6) o mesmo gate vale para o inbound do n8n (ACTIVATE)', async () => {
    const { repository, profileId } = await seed({ excluded: true, reason: 'BACKBONE' });
    const l = new CountingLiveExecutor();
    app = Fastify();
    registerN8nRoutes(app, { commands: commands(repository, l), commandToken: 'tok' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/n8n/mitigation-command',
      headers: { authorization: 'Bearer tok' },
      payload: { requestId: 'n8n-act-1', action: 'ACTIVATE', profileId },
    });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.status).toBe('MITIGATION_EXCLUDED');
    expect(body.blockedReason).toBe('MITIGATION_EXCLUDED');
    expect(l.activateCalls).toBe(0);
  });

  it('7) simulacao acima do threshold NAO vira decisao operacional de mitigacao', async () => {
    const { repository, profileId } = await seed({ excluded: true, reason: 'MANUAL' });
    const simulation = await serviceFor(repository).simulate(profileId, {
      simulatedTrafficBps: '9500000000',
      samples: 3,
      simulatedPrefixCount: 12,
    });
    expect(simulation?.result).toBe('BLOCKED');
    expect(simulation?.blockedReason).toBe('MITIGATION_EXCLUDED');
    expect(simulation?.commandPreview).toEqual([]);
  });

  it('8) desmarcar a exclusao devolve o caminho normal de preflight', async () => {
    const live = new CountingLiveExecutor();
    const { repository, profileId } = await seed({ excluded: true, reason: 'UPLINK' });
    const commandService = commands(repository, live);

    const bloqueado = await commandService.execute({
      requestId: 'excl-8a',
      action: 'ACTIVATE',
      profileId,
    });
    expect(bloqueado.status).toBe('MITIGATION_EXCLUDED');

    await repository.setProfileExclusion(profileId, { excluded: false });
    const record = await repository.getProfile(profileId);
    expect(record?.mitigationExcluded).toBe(false);
    expect(record?.mitigationExclusionReason).toBeNull();
    expect(record?.mitigationExclusionNote).toBeNull();

    const liberado = await commandService.execute({
      requestId: 'excl-8b',
      action: 'ACTIVATE',
      profileId,
    });
    expect(liberado.ok).toBe(true);
    expect(liberado.status).toBe('ACTIVATED_VERIFIED');
    expect(live.preflightCalls).toBe(1);
    expect(live.activateCalls).toBe(1);
  });

  it('9) REMOVE continua PERMITIDO com o target excluido (retirada nao pode ser impedida)', async () => {
    const live = new CountingLiveExecutor();
    const { repository, profileId } = await seed();
    const commandService = commands(repository, live);

    const ativado = await commandService.execute({
      requestId: 'excl-9a',
      action: 'ACTIVATE',
      profileId,
    });
    expect(ativado.status).toBe('ACTIVATED_VERIFIED');

    // Operador exclui DEPOIS de existir mitigacao ativa.
    await repository.setProfileExclusion(profileId, { excluded: true, reason: 'TRANSIT' });

    const removido = await commandService.execute({
      requestId: 'excl-9b',
      action: 'REMOVE',
      profileId,
    });
    expect(removido.ok).toBe(true);
    expect(removido.status).toBe('REMOVED_VERIFIED');
    expect(removido.pairSource).toBe('DEVICE');
    expect(live.removeCalls).toBe(1);
  });

  it('10) exclusao e por TARGET: outro target da MESMA policy continua elegivel', async () => {
    const repository = new InMemoryMitigationRepository();
    const ceasa = await repository.upsertProfile({
      deviceId: 'device-1',
      policyName: POLICY,
      interfaceId: 'if-ceasa',
      addressFamily: 'IPV4',
      detectedBandwidthBps: 10_000_000_000n,
      bandwidthSource: 'DESCRIPTION',
    });
    await repository.replaceProfilePeers(ceasa.id, [{ peerAddress: '10.200.200.222', primary: true }]);
    await repository.upsertRuntime(ceasa.id, { state: 'NORMAL', plannedBogonNode: 1, plannedMitigationNode: 2, plannedNode: 2 });

    const rbn = await repository.upsertProfile({
      deviceId: 'device-1',
      policyName: POLICY,
      interfaceId: 'if-rbn',
      addressFamily: 'IPV4',
      detectedBandwidthBps: 10_000_000_000n,
      bandwidthSource: 'DESCRIPTION',
    });
    await repository.replaceProfilePeers(rbn.id, [{ peerAddress: '10.200.200.10', primary: true }]);
    await repository.upsertRuntime(rbn.id, { state: 'NORMAL', plannedBogonNode: 1, plannedMitigationNode: 2, plannedNode: 2 });

    await repository.setProfileExclusion(ceasa.id, { excluded: true, reason: 'UPLINK' });

    const live = new CountingLiveExecutor();
    const commandService = commands(repository, live);

    const outro = await commandService.execute({
      requestId: 'excl-10a',
      action: 'ACTIVATE',
      profileId: rbn.id,
    });
    expect(outro.ok).toBe(true);
    expect(outro.status).toBe('ACTIVATED_VERIFIED');

    const excluido = await commandService.execute({
      requestId: 'excl-10b',
      action: 'ACTIVATE',
      profileId: ceasa.id,
    });
    expect(excluido.status).toBe('MITIGATION_EXCLUDED');
  });

  it('11) PATCH /exclusion valida enum, persiste e limpa ao desmarcar', async () => {
    const { repository, profileId } = await seed();
    app = await appFor(serviceFor(repository));

    const salvo = await app.inject({
      method: 'PATCH',
      url: `/api/bgp/mitigation/profiles/${profileId}/exclusion`,
      payload: { excluded: true, reason: 'UPLINK', note: 'Upstream principal' },
    });
    expect(salvo.statusCode).toBe(200);
    const salvoBody = salvo.json();
    expect(salvoBody.mitigationExcluded).toBe(true);
    expect(salvoBody.mitigationExclusionReason).toBe('UPLINK');
    expect(salvoBody.mitigationExclusionNote).toBe('Upstream principal');

    const motivoInvalido = await app.inject({
      method: 'PATCH',
      url: `/api/bgp/mitigation/profiles/${profileId}/exclusion`,
      payload: { excluded: true, reason: 'QUALQUER' },
    });
    expect(motivoInvalido.statusCode).toBe(400);

    const limpo = await app.inject({
      method: 'PATCH',
      url: `/api/bgp/mitigation/profiles/${profileId}/exclusion`,
      payload: { excluded: false },
    });
    expect(limpo.statusCode).toBe(200);
    const limpoBody = limpo.json();
    expect(limpoBody.mitigationExcluded).toBe(false);
    expect(limpoBody.mitigationExclusionReason).toBeNull();
    expect(limpoBody.mitigationExclusionNote).toBeNull();

    const inexistente = await app.inject({
      method: 'PATCH',
      url: '/api/bgp/mitigation/profiles/nao-existe/exclusion',
      payload: { excluded: true, reason: 'MANUAL' },
    });
    expect(inexistente.statusCode).toBe(404);
  });

  it('12) sem exclusao o gate nao interfere (preflight/executor seguem normais)', async () => {
    const live = new CountingLiveExecutor();
    const { repository, profileId } = await seed();
    const result = await commands(repository, live).execute({
      requestId: 'excl-12',
      action: 'SIMULATE_ACTIVATE',
      profileId,
    });
    expect(result.status).toBe('WOULD_ACTIVATE');
    expect(result.commandPreview).toHaveLength(7);
    expect(live.activateCalls).toBe(0);
  });
});
