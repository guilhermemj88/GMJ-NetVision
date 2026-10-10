import type { BgpDashboardPeer, HostRecord } from '@gmj/shared';
import { describe, expect, it } from 'vitest';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import { BgpMitigationService } from './mitigation-service';
import type { MitigationDiscoveryResult } from './mitigation-discovery-service';
import type { MitigationInterfaceMetadataRefresher } from './mitigation-interface-refresher';
import { persistedPeersToBgpOutcome } from './mitigation-persisted-peers';

// DESCOBRIR CLIENTES × FRESHNESS DE INTERFACE.
// O clique MANUAL renova o metadata (SNMP IF-MIB + display interface description)
// ANTES de classificar, recarrega o HostRecord, reusa a correlacao peer->interface
// persistida e nunca dispara um SSH por peer. Reidratacao/AUTO nunca pagam isso.

const DEVICE = 'device-1';
const POLICY = 'PL-FLASH-TELECOM_IPv4-IN';
const IFACE_ID = 'if-3066';

function hostRecord(hostname: string): HostRecord {
  return {
    id: DEVICE,
    hostname,
    displayName: 'BHE-VTA-F1A-BGP-01',
    sshEnabled: true,
    ssh: { host: '10.0.0.1', port: 22, username: 'operator' },
  } as unknown as HostRecord;
}

function telecomPeer(alias: string): BgpDashboardPeer {
  return {
    peerAddress: '10.200.201.22',
    addressFamily: 'IPV4',
    remoteAs: '263420',
    stateCode: 6,
    state: 'ESTABLISHED',
    receivedPrefixes: 1,
    displayName: 'FAST TELECOM_IPv4',
    interface: { id: IFACE_ID, name: 'Eth-Trunk1.3066', alias, description: 'TO FAST TELECOM' },
  } as unknown as BgpDashboardPeer;
}

function discoveryRow(): Record<string, unknown> {
  return {
    profileId: 'profile-fast',
    policyName: POLICY,
    addressFamily: 'IPV4',
    sharedPolicy: false,
    sharedPolicyTargets: [],
    autoBlockedReason: null,
    customer: 'FAST TELECOM',
    interfaceId: IFACE_ID,
    interfaceName: 'Eth-Trunk1.3066',
    interfaceDescriptionRaw: 'FAST TELECOM_10G',
    detectedBandwidthBps: 10_000_000_000n,
    effectiveBandwidthBps: 10_000_000_000n,
    bandwidthSource: 'DESCRIPTION',
    peerAddresses: ['10.200.201.22'],
    prefixCount: 1,
    prefixLimit: 100,
    prefixStatus: 'SAFE',
    existingNodes: [10, 999],
    mitigationNodes: [],
    bogonNodes: [],
    bogonPrefixList: 'BOGONS',
    targetPrefixList: 'PREFIX8to24',
    firstNormalNode: 10,
    plannedNode: 2,
    plannedBogonNode: 1,
    plannedMitigationNode: 2,
    readiness: 'READY',
    blockedReason: null,
  };
}

interface Harness {
  service: BgpMitigationService;
  repository: InMemoryMitigationRepository;
  order: string[];
  refreshCalls: string[];
  liveDiscoveryCalls: { value: number };
  discoveryHosts: HostRecord[];
  outcomeAliases: (string | null)[];
}

function buildHarness(options: { failRefresh?: boolean } = {}): Harness {
  const repository = new InMemoryMitigationRepository();
  const order: string[] = [];
  const refreshCalls: string[] = [];
  const liveDiscoveryCalls = { value: 0 };
  const discoveryHosts: HostRecord[] = [];
  const outcomeAliases: (string | null)[] = [];

  let hostCurrent = hostRecord('stale.example');
  let aliasCurrent = 'FAST TELECOM';

  const refresher: MitigationInterfaceMetadataRefresher = {
    async refresh(device) {
      order.push('refresh');
      refreshCalls.push(device.id);
      if (options.failRefresh) throw new Error('SSH timeout durante display interface description');
      // O fluxo real persiste via replaceInterfaces; aqui o efeito e observavel
      // pelo recarregamento do HostRecord e pelo proximo listForDevice.
      hostCurrent = hostRecord('fresh.example');
      aliasCurrent = 'FAST TELECOM_10G';
      return { interfaces: 203 };
    },
  };

  const persistedPeers = {
    async listForDevice(): Promise<BgpDashboardPeer[]> {
      order.push('persistedPeers');
      return [telecomPeer(aliasCurrent)];
    },
  };

  const result: MitigationDiscoveryResult = {
    deviceId: DEVICE,
    scannedPeers: 110,
    candidateInterfaces: 20,
    ignoredNoBandwidth: 71,
    createdProfiles: 1,
    updatedProfiles: 0,
    blockedProfiles: 0,
    outOfScopeProfiles: [],
    ambiguousPeers: [],
    warnings: [],
    profiles: [discoveryRow() as never],
  };

  const discovery = {
    async discoverMitigationProfiles() {
      liveDiscoveryCalls.value += 1;
      return result;
    },
    async discoverFromBgpOutcome(device: HostRecord, outcome: { peers: readonly { interfaceAlias: string | null }[] }) {
      order.push('discovery');
      discoveryHosts.push(device);
      outcomeAliases.push(outcome.peers[0]?.interfaceAlias ?? null);
      return result;
    },
  };

  const service = new BgpMitigationService({
    repository,
    discovery: discovery as never,
    hosts: { getHost: async () => hostCurrent },
    persistedPeers,
    interfaceMetadataRefresher: refresher,
    schemaProbe: { probe: async () => ({ migrationReady: true, databaseReady: true }) },
    repositoryKind: 'MEMORY',
  });

  return { service, repository, order, refreshCalls, liveDiscoveryCalls, discoveryHosts, outcomeAliases };
}

describe('DESCOBRIR CLIENTES: refresh de metadata antes do discovery', () => {
  it('manual: refresh 1x/device ANTES do persistedPeers, com HostRecord recarregado', async () => {
    const h = buildHarness();
    const response = await h.service.discover([DEVICE], { refreshInterfaceMetadata: true });

    expect(h.refreshCalls).toEqual([DEVICE]);
    expect(h.order).toEqual(['refresh', 'persistedPeers', 'discovery']);
    // HostRecord recarregado: o discovery recebe o objeto NOVO, nunca o stale.
    expect(h.discoveryHosts).toHaveLength(1);
    expect(h.discoveryHosts[0]?.hostname).toBe('fresh.example');
    const warnings = response.warnings.join('\n');
    expect(warnings).toContain('Interfaces atualizadas via SNMP/SSH antes do discovery (203 interfaces).');
  });

  it('warning da correlacao reutilizada cita route lookup (nunca sugerir SSH novo por peer)', () => {
    const outcome = persistedPeersToBgpOutcome([telecomPeer('FAST TELECOM_10G')]);
    expect(outcome?.warnings.join('\n')).toContain('sem route lookup SSH por peer');
  });

  it('FAST TELECOM: o MESMO request enxerga o alias novo persistido pelo refresh', async () => {
    const h = buildHarness();
    const response = await h.service.discover([DEVICE], { refreshInterfaceMetadata: true });

    // O peer lido DEPOIS do refresh carrega FAST TELECOM_10G (era FAST TELECOM).
    expect(h.outcomeAliases).toEqual(['FAST TELECOM_10G']);
    expect(response.results[0]?.scannedPeers).toBe(110);
    expect(h.liveDiscoveryCalls.value).toBe(0);
  });

  it('refresh falhou: warning explicito, NENHUMA classificacao e profiles intactos', async () => {
    const h = buildHarness({ failRefresh: true });
    const seeded = await h.repository.upsertProfile({
      deviceId: DEVICE,
      policyName: POLICY,
      interfaceId: IFACE_ID,
      addressFamily: 'IPV4',
      detectedBandwidthBps: 10_000_000_000n,
      bandwidthSource: 'DESCRIPTION',
    });
    await h.repository.upsertRuntime(seeded.id, { state: 'NORMAL', plannedNode: 2 });

    const response = await h.service.discover([DEVICE], { refreshInterfaceMetadata: true });

    expect(response.results).toEqual([]);
    expect(h.order).toEqual(['refresh']);
    const warnings = response.warnings.join('\n');
    expect(warnings).toContain('falha ao atualizar interfaces do equipamento');
    expect(warnings).toContain('metadata possivelmente desatualizado');
    // Nunca out-of-scope/DISABLED por leitura falha: profile e runtime intactos.
    const profiles = await h.repository.listProfiles();
    expect(profiles).toHaveLength(1);
    expect((await h.repository.getRuntime(seeded.id))?.state).toBe('NORMAL');
  });

  it('sem refresher configurado o manual falha visivel e nao classifica', async () => {
    const h = buildHarness();
    const service = new BgpMitigationService({
      repository: h.repository,
      discovery: { async discoverMitigationProfiles() { throw new Error('nao deveria rodar'); } } as never,
      hosts: { getHost: async () => hostRecord('stale.example') } as never,
      schemaProbe: { probe: async () => ({ migrationReady: true, databaseReady: true }) },
      repositoryKind: 'MEMORY',
    });

    const response = await service.discover([DEVICE], { refreshInterfaceMetadata: true });
    expect(response.results).toEqual([]);
    expect(response.warnings.join('\n')).toContain('refresh de interfaces indisponivel');
  });

  it('sem a opcao explicita (reidratacao/AUTO) NUNCA chama o refresh', async () => {
    const h = buildHarness();
    const response = await h.service.discover([DEVICE]);
    expect(h.refreshCalls).toEqual([]);
    expect(h.order).toEqual(['persistedPeers', 'discovery']);
    expect(response.warnings.join('\n')).not.toContain('Interfaces atualizadas');
  });

  it('rehydrateSnapshots usa refreshInterfaceMetadata=false', async () => {
    const h = buildHarness();
    await h.repository.upsertProfile({
      deviceId: DEVICE,
      policyName: POLICY,
      interfaceId: IFACE_ID,
      addressFamily: 'IPV4',
      detectedBandwidthBps: 10_000_000_000n,
      bandwidthSource: 'DESCRIPTION',
    });

    const summary = await h.service.rehydrateSnapshots();
    expect(summary).toEqual({ devices: 1, succeeded: 1, failed: 0 });
    expect(h.refreshCalls).toEqual([]);
    expect(h.order).toEqual(['persistedPeers', 'discovery']);
  });

  it('multi-device manual: cada device atualizado exatamente uma vez', async () => {
    const repository = new InMemoryMitigationRepository();
    const order: string[] = [];
    const refreshes: string[] = [];
    const result = (deviceId: string): MitigationDiscoveryResult => ({
      deviceId,
      scannedPeers: 5,
      candidateInterfaces: 1,
      ignoredNoBandwidth: 0,
      createdProfiles: 0,
      updatedProfiles: 0,
      blockedProfiles: 0,
      outOfScopeProfiles: [],
      ambiguousPeers: [],
      warnings: [],
      profiles: [],
    });
    const service = new BgpMitigationService({
      repository,
      discovery: {
        async discoverMitigationProfiles(device: HostRecord) {
          order.push(`discovery:${device.id}`);
          return result(device.id);
        },
        async discoverFromBgpOutcome(device: HostRecord) {
          order.push(`discovery:${device.id}`);
          return result(device.id);
        },
      } as never,
      hosts: {
        getHost: async (id: string) => ({ ...hostRecord(`${id}.example`), id }) as unknown as HostRecord,
      } as never,
      persistedPeers: {
        async listForDevice(deviceId: string) {
          order.push(`peers:${deviceId}`);
          return [telecomPeer('FAST TELECOM_10G')];
        },
      },
      interfaceMetadataRefresher: {
        async refresh(device) {
          refreshes.push(device.id);
          return { interfaces: 1 };
        },
      },
      schemaProbe: { probe: async () => ({ migrationReady: true, databaseReady: true }) },
      repositoryKind: 'MEMORY',
    });

    await service.discover(['device-1', 'device-1', 'device-2'], { refreshInterfaceMetadata: true });
    expect(refreshes).toEqual(['device-1', 'device-2']);
    expect(order).toEqual([
      'peers:device-1',
      'discovery:device-1',
      'peers:device-2',
      'discovery:device-2',
    ]);
  });
});
