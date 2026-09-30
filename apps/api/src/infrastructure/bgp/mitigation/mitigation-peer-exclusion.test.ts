import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuthUser, BgpPeerDetail, HostRecord } from '@gmj/shared';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import {
  MitigationCommandService,
  type MitigationLiveExecutorPort,
} from './mitigation-command-service';
import { MockMitigationExecutor } from './mitigation-executor';
import { BgpMitigationService } from './mitigation-service';
import type {
  MitigationPreflightInput,
  MitigationPreflightResult,
} from './huawei-mitigation-executor';
import type { MitigationActivationInput, MitigationRemovalInput } from './mitigation-executor';
import type { MitigationDiscoveryResult } from './mitigation-discovery-service';
import { registerMitigationRoutes } from '../../../mitigation-routes';
import { registerN8nRoutes } from '../../../n8n-routes';

// Exclusao PREVENTIVA por PEER BGP ("nunca mitigar este peer").
//
// Diferente da exclusao por profile (Fase 13), esta camada vive colada ao
// BgpPeer: vale para uplink/transit/IX/backbone que nunca entram no escopo da
// mitigacao (sem banda declarada => sem profile) e continua valendo se o peer
// ganhar profile depois.

const OPERATOR = { id: 'u1', username: 'operador', role: 'OPERATOR' } as unknown as AuthUser;
const POLICY = 'PL-BHNET_IPv4-IN';
const FIXED_NOW = new Date('2026-09-30T20:00:00.000Z');

function host(label = 'BHE-VTA-F1A-BGP-01'): HostRecord {
  return {
    id: 'device-1',
    hostname: label,
    displayName: label,
    name: label,
    sshEnabled: true,
  } as unknown as HostRecord;
}

/** Peer persistido: identidade estavel (device + endereco + familia + interface). */
function peerDetail(overrides: Partial<BgpPeerDetail> = {}): BgpPeerDetail {
  return {
    id: 'peer-1',
    deviceId: 'device-1',
    peerAddress: '198.18.1.152',
    addressFamily: 'IPV4',
    interface: { id: 'if-transit', name: 'Eth-Trunk1.2593', alias: 'IP-SEABORN' },
    ...overrides,
  } as unknown as BgpPeerDetail;
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

/** Executor "real" falso: conta TODA interacao (tem de ficar zerado quando bloqueado). */
class CountingLiveExecutor implements MitigationLiveExecutorPort {
  preflightCalls = 0;
  activateCalls = 0;
  removeCalls = 0;
  readRoutePolicyCalls = 0;
  devicePair: { bogonNode: number; mitigationNode: number } | null = {
    bogonNode: 1,
    mitigationNode: 2,
  };

  enabledFor(): boolean {
    return true;
  }

  async resolveActivePair() {
    return this.devicePair;
  }

  async preflight(
    _device: HostRecord,
    input: MitigationPreflightInput,
  ): Promise<MitigationPreflightResult> {
    this.preflightCalls += 1;
    return {
      ok: true,
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
      blockedReasons: [],
    };
  }

  async activate(
    _device: HostRecord,
    _input: MitigationActivationInput,
  ): Promise<{ output: string }> {
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
    return this.devicePair ? READBACK_ACTIVE : `route-policy ${POLICY} permit node 10`;
  }
}

/** Perfil do target (o peer excluido pode ou nao ter um). */
async function seedProfile(
  repository: InMemoryMitigationRepository,
  options: {
    policy?: string;
    interfaceId?: string;
    peerAddress?: string;
  } = {},
) {
  const profile = await repository.upsertProfile({
    deviceId: 'device-1',
    policyName: options.policy ?? POLICY,
    interfaceId: options.interfaceId ?? 'if-1',
    addressFamily: 'IPV4',
    detectedBandwidthBps: 10_000_000_000n,
    bandwidthSource: 'DESCRIPTION',
    prefixLimit: 100,
  });
  await repository.replaceProfilePeers(profile.id, [
    { peerId: 'peer-1', peerAddress: options.peerAddress ?? '10.200.200.222', primary: true },
  ]);
  await repository.upsertRuntime(profile.id, {
    state: 'NORMAL',
    plannedBogonNode: 1,
    plannedMitigationNode: 2,
    plannedNode: 2,
  });
  return profile.id;
}

/** Exclusao preventiva direta no repositorio (equivalente ao PATCH da UI). */
async function exclude(
  repository: InMemoryMitigationRepository,
  options: {
    peerId?: string;
    peerAddress?: string;
    reason?: 'UPLINK' | 'TRANSIT' | 'IX' | 'BACKBONE' | 'MANUAL';
    note?: string | null;
  } = {},
) {
  return repository.setPeerExclusion({
    peerId: options.peerId ?? 'peer-1',
    deviceId: 'device-1',
    peerAddress: options.peerAddress ?? '10.200.200.222',
    addressFamily: 'IPV4',
    interfaceId: 'if-1',
    excluded: true,
    reason: options.reason ?? 'TRANSIT',
    note: options.note ?? null,
  });
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

function serviceFor(
  repository: InMemoryMitigationRepository,
  options: { peer?: BgpPeerDetail; peerExclusionReady?: boolean } = {},
) {
  return new BgpMitigationService({
    repository,
    discovery: discoveryStub() as never,
    hosts: { getHost: async () => host() },
    schemaProbe: { probe: async () => ({ migrationReady: true, databaseReady: true }) },
    repositoryKind: 'DATABASE',
    peerExclusionSchemaReady: async () => options.peerExclusionReady ?? true,
    now: () => FIXED_NOW,
  });
}

async function appFor(
  service: BgpMitigationService,
  options: { peer?: BgpPeerDetail | null } = {},
): Promise<FastifyInstance> {
  const app = Fastify();
  registerMitigationRoutes(app, {
    service,
    currentUser: async () => OPERATOR,
    peers: {
      getPeerDetail: async (peerId) =>
        options.peer === null ? null : (options.peer ?? peerDetail({ id: peerId })),
    },
  });
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

describe('exclusao preventiva por peer BGP (Caminho 3)', () => {
  it('1) exclui peer SEM profile e a lista de profiles continua vazia', async () => {
    const repository = new InMemoryMitigationRepository();
    const service = serviceFor(repository);

    const saved = await service.setPeerMitigationExclusion({
      peerId: 'peer-1',
      deviceId: 'device-1',
      peerAddress: '198.18.1.152',
      addressFamily: 'IPV4',
      interfaceId: 'if-transit',
      excluded: true,
      reason: 'TRANSIT',
      note: 'Upstream IP-SEABORN',
    });

    expect(saved.excluded).toBe(true);
    expect(saved.reason).toBe('TRANSIT');
    expect(saved.note).toBe('Upstream IP-SEABORN');
    expect(saved.persisted).toBe(true);
    expect(await repository.listProfiles()).toEqual([]);
    const record = await repository.getPeerExclusion('peer-1');
    expect(record?.peerAddress).toBe('198.18.1.152');
    expect(record?.reason).toBe('TRANSIT');
  });

  it('2) a exclusao sobrevive a uma nova instancia do repository (persistencia)', async () => {
    const repository = new InMemoryMitigationRepository();
    await exclude(repository, { reason: 'IX', note: 'VS-IMPLANTAR-IXBR' });

    const outraInstancia = new InMemoryMitigationRepository(repository.storeRef);
    const record = await outraInstancia.getPeerExclusion('peer-1');
    expect(record?.reason).toBe('IX');
    expect(record?.note).toBe('VS-IMPLANTAR-IXBR');
  });

  it('3) o discovery (upsert do profile + replace de peers) preserva a exclusao do peer', async () => {
    const repository = new InMemoryMitigationRepository();
    await exclude(repository, { reason: 'TRANSIT' });

    const profileId = await seedProfile(repository);
    expect(await repository.getPeerExclusion('peer-1')).not.toBeNull();

    // Segundo "discovery": reescreve o profile e os peers do target.
    await repository.upsertProfile({
      deviceId: 'device-1',
      policyName: POLICY,
      interfaceId: 'if-1',
      addressFamily: 'IPV4',
      detectedBandwidthBps: 10_000_000_000n,
      bandwidthSource: 'DESCRIPTION',
    });
    await repository.replaceProfilePeers(profileId, [
      { peerId: 'peer-1', peerAddress: '10.200.200.222', primary: true },
    ]);

    const record = await repository.getPeerExclusion('peer-1');
    expect(record?.reason).toBe('TRANSIT');
  });

  it('4) peer que ganha profile DEPOIS continua protegido (ACTIVATE bloqueado)', async () => {
    const repository = new InMemoryMitigationRepository();
    const live = new CountingLiveExecutor();
    await exclude(repository, { reason: 'UPLINK' });

    const profileId = await seedProfile(repository);
    const result = await commands(repository, live).execute({
      requestId: 'peer-excl-4',
      action: 'ACTIVATE',
      profileId,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('MITIGATION_EXCLUDED');
    expect(result.blockedReason).toBe('PEER_MITIGATION_EXCLUDED');
  });

  it('5) ACTIVATE bloqueia ANTES do executor (zero preflight/SSH/executor/commandPreview)', async () => {
    const repository = new InMemoryMitigationRepository();
    const live = new CountingLiveExecutor();
    await exclude(repository, { reason: 'BACKBONE', note: 'BGP-RS-IMPLANTAR' });
    const profileId = await seedProfile(repository);

    const result = await commands(repository, live).execute({
      requestId: 'peer-excl-5',
      action: 'ACTIVATE',
      profileId,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('MITIGATION_EXCLUDED');
    expect(result.blockedReason).toBe('PEER_MITIGATION_EXCLUDED');
    expect(result.commandPreview).toEqual([]);
    expect(result.verification).toBeNull();
    expect(result.safeError).toContain('nunca mitigar este peer');
    expect(live.preflightCalls).toBe(0);
    expect(live.activateCalls).toBe(0);
    expect(live.readRoutePolicyCalls).toBe(0);
  });

  it('6) SIMULATE_ACTIVATE tambem e bloqueado', async () => {
    const repository = new InMemoryMitigationRepository();
    const live = new CountingLiveExecutor();
    await exclude(repository);
    const profileId = await seedProfile(repository);

    const result = await commands(repository, live).execute({
      requestId: 'peer-excl-6',
      action: 'SIMULATE_ACTIVATE',
      profileId,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('MITIGATION_EXCLUDED');
    expect(result.blockedReason).toBe('PEER_MITIGATION_EXCLUDED');
    expect(result.commandPreview).toEqual([]);
    expect(live.activateCalls).toBe(0);
    expect(live.preflightCalls).toBe(0);
  });

  it('7) o inbound do n8n recebe o mesmo bloqueio', async () => {
    const repository = new InMemoryMitigationRepository();
    const live = new CountingLiveExecutor();
    await exclude(repository);
    const profileId = await seedProfile(repository);

    app = Fastify();
    registerN8nRoutes(app, { commands: commands(repository, live), commandToken: 'tok' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/integrations/n8n/mitigation-command',
      headers: { authorization: 'Bearer tok' },
      payload: { requestId: 'peer-excl-7', action: 'ACTIVATE', profileId },
    });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.status).toBe('MITIGATION_EXCLUDED');
    expect(body.blockedReason).toBe('PEER_MITIGATION_EXCLUDED');
    expect(body.commandPreview).toEqual([]);
    expect(live.activateCalls).toBe(0);
    expect(live.preflightCalls).toBe(0);
  });

  it('8) a simulacao de trafego (rota /simulate) tambem nao vira decisao de mitigacao', async () => {
    const repository = new InMemoryMitigationRepository();
    await exclude(repository);
    const profileId = await seedProfile(repository);

    const simulation = await serviceFor(repository).simulate(profileId, {
      simulatedTrafficBps: '9500000000',
      samples: 3,
      simulatedPrefixCount: 12,
    });

    expect(simulation?.result).toBe('BLOCKED');
    expect(simulation?.blockedReason).toBe('PEER_MITIGATION_EXCLUDED');
    expect(simulation?.commandPreview).toEqual([]);
  });

  it('9) REMOVE continua PERMITIDO com o peer excluido (retirada nao pode ser impedida)', async () => {
    const repository = new InMemoryMitigationRepository();
    const live = new CountingLiveExecutor();
    const profileId = await seedProfile(repository);
    const commandService = commands(repository, live);

    const ativado = await commandService.execute({
      requestId: 'peer-excl-9a',
      action: 'ACTIVATE',
      profileId,
    });
    expect(ativado.status).toBe('ACTIVATED_VERIFIED');

    await exclude(repository, { reason: 'TRANSIT' });

    const removido = await commandService.execute({
      requestId: 'peer-excl-9b',
      action: 'REMOVE',
      profileId,
    });
    expect(removido.ok).toBe(true);
    expect(removido.status).toBe('REMOVED_VERIFIED');
    expect(removido.verified).toBe(true);
    expect(live.removeCalls).toBe(1);
  });

  it('10) desmarcar a exclusao devolve a elegibilidade', async () => {
    const repository = new InMemoryMitigationRepository();
    const live = new CountingLiveExecutor();
    await exclude(repository, { reason: 'MANUAL' });
    const profileId = await seedProfile(repository);
    const commandService = commands(repository, live);

    const bloqueado = await commandService.execute({
      requestId: 'peer-excl-10a',
      action: 'ACTIVATE',
      profileId,
    });
    expect(bloqueado.blockedReason).toBe('PEER_MITIGATION_EXCLUDED');

    const cleared = await repository.setPeerExclusion({
      peerId: 'peer-1',
      deviceId: 'device-1',
      peerAddress: '10.200.200.222',
      addressFamily: 'IPV4',
      interfaceId: 'if-1',
      excluded: false,
    });
    expect(cleared).toBeNull();
    expect(await repository.getPeerExclusion('peer-1')).toBeNull();

    const liberado = await commandService.execute({
      requestId: 'peer-excl-10b',
      action: 'ACTIVATE',
      profileId,
    });
    expect(liberado.ok).toBe(true);
    expect(liberado.status).toBe('ACTIVATED_VERIFIED');
    expect(live.preflightCalls).toBe(1);
    expect(live.activateCalls).toBe(1);
  });

  it('11) um peer excluido NAO exclui outro peer (mesmo com policy compartilhada)', async () => {
    const repository = new InMemoryMitigationRepository();
    const live = new CountingLiveExecutor();

    // Dois targets que compartilham a MESMA policy IN, com peers diferentes.
    const ceasa = await seedProfile(repository, { interfaceId: 'if-ceasa', peerAddress: '10.200.200.222' });
    await repository.setPeerExclusion({
      peerId: 'peer-1',
      deviceId: 'device-1',
      peerAddress: '198.18.1.152',
      addressFamily: 'IPV4',
      interfaceId: 'if-transit',
      excluded: true,
      reason: 'TRANSIT',
    });

    const commandService = commands(repository, live);
    const outro = await commandService.execute({
      requestId: 'peer-excl-11',
      action: 'ACTIVATE',
      profileId: ceasa,
    });
    expect(outro.ok).toBe(true);
    expect(outro.status).toBe('ACTIVATED_VERIFIED');
  });

  it('12) exclusao por endereco do peer do target (nao por policy): outro endereco nao bloqueia', async () => {
    const repository = new InMemoryMitigationRepository();
    const live = new CountingLiveExecutor();
    const profileId = await seedProfile(repository, { peerAddress: '10.200.200.222' });
    await repository.setPeerExclusion({
      peerId: 'peer-outro',
      deviceId: 'device-1',
      peerAddress: '10.200.200.226',
      addressFamily: 'IPV4',
      interfaceId: 'if-outro',
      excluded: true,
      reason: 'UPLINK',
    });

    const result = await commands(repository, live).execute({
      requestId: 'peer-excl-12',
      action: 'ACTIVATE',
      profileId,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('ACTIVATED_VERIFIED');
  });

  it('13) PATCH /api/bgp/peers/:peerId/mitigation-exclusion persiste, valida enum e limpa', async () => {
    const repository = new InMemoryMitigationRepository();
    app = await appFor(serviceFor(repository), { peer: peerDetail() });

    const salvo = await app.inject({
      method: 'PATCH',
      url: '/api/bgp/peers/peer-1/mitigation-exclusion',
      payload: { excluded: true, reason: 'IX', note: 'VS-IMPLANTAR-IXBR' },
    });
    expect(salvo.statusCode).toBe(200);
    const salvoBody = salvo.json();
    expect(salvoBody.excluded).toBe(true);
    expect(salvoBody.reason).toBe('IX');
    expect(salvoBody.note).toBe('VS-IMPLANTAR-IXBR');
    expect(salvoBody.peerAddress).toBe('198.18.1.152');
    expect(salvoBody.persisted).toBe(true);
    expect(await repository.getPeerExclusion('peer-1')).not.toBeNull();
    // Nenhum profile foi criado por causa da marcacao.
    expect(await repository.listProfiles()).toEqual([]);

    const motivoInvalido = await app.inject({
      method: 'PATCH',
      url: '/api/bgp/peers/peer-1/mitigation-exclusion',
      payload: { excluded: true, reason: 'QUALQUER' },
    });
    expect(motivoInvalido.statusCode).toBe(400);

    const limpo = await app.inject({
      method: 'PATCH',
      url: '/api/bgp/peers/peer-1/mitigation-exclusion',
      payload: { excluded: false },
    });
    expect(limpo.statusCode).toBe(200);
    const limpoBody = limpo.json();
    expect(limpoBody.excluded).toBe(false);
    expect(limpoBody.reason).toBeNull();
    expect(limpoBody.note).toBeNull();
    expect(await repository.getPeerExclusion('peer-1')).toBeNull();
  });

  it('14) PATCH responde 404 para peer inexistente e nao escreve nada', async () => {
    const repository = new InMemoryMitigationRepository();
    app = await appFor(serviceFor(repository), { peer: null });

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/bgp/peers/nao-existe/mitigation-exclusion',
      payload: { excluded: true, reason: 'UPLINK' },
    });
    expect(response.statusCode).toBe(404);
    expect(await repository.listPeerExclusions()).toEqual([]);
  });

  it('15) sem exclusao o gate por peer nao interfere no caminho normal', async () => {
    const repository = new InMemoryMitigationRepository();
    const live = new CountingLiveExecutor();
    const profileId = await seedProfile(repository);

    const result = await commands(repository, live).execute({
      requestId: 'peer-excl-15',
      action: 'SIMULATE_ACTIVATE',
      profileId,
    });

    expect(result.status).toBe('WOULD_ACTIVATE');
    expect(result.commandPreview).toHaveLength(7);
    expect(live.activateCalls).toBe(0);
  });
});