import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import type { BgpDiscoveryOutcome, DiscoveredBgpPeer } from '../bgp-discovery-service';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import {
  BgpMitigationDiscoveryService,
  aggregatePrefixCount,
  type MitigationDiscoveryResult,
} from './mitigation-discovery-service';
import type { BgpMitigationConfigSource } from './mitigation-config-source';

const DEVICE = { id: 'device-1', interfaces: [] } as unknown as HostRecord;

/**
 * Dump no formato REAL do VRP: a policy de import vive DENTRO de
 * `ipv4-family unicast`, nunca no bloco global do `bgp`.
 */
function bgpV4(...peerLines: string[]): string {
  return ['bgp 64500', ' ipv4-family unicast', ...peerLines.map((line) => ` ${line}`)].join('\n');
}

const BGP_CONFIG = bgpV4(
  'peer 10.200.200.106 route-policy PL-HORIZONTES_IPv4-IN import',
  'peer 10.200.200.10 route-policy PL-HORIZONTES_IPv4-IN import',
  'peer 10.200.200.30 route-policy PL-OUTRA_IPv4-IN import',
  'peer 10.200.200.40 route-policy PL-HORIZONTES_IPv4-IN export',
  'peer 10.200.200.50 route-policy PL-BUSY-IN import',
);

const RP_CONFIG = [
  'route-policy PL-HORIZONTES_IPv4-IN permit node 11',
  'route-policy PL-HORIZONTES_IPv4-IN permit node 12',
  'route-policy PL-OUTRA_IPv4-IN permit node 7',
  'route-policy PL-OUTRA_IPv4-IN permit node 8',
  'route-policy PL-BUSY-IN permit node 1',
  ' apply extcommunity rt 268568:660 additive',
  'route-policy PL-BUSY-IN permit node 2',
  ' apply extcommunity rt 268568:660 additive',
  'route-policy PL-BUSY-IN permit node 3',
  ' apply extcommunity rt 268568:660 additive',
  'route-policy PL-BUSY-IN permit node 4',
  ' apply extcommunity rt 268568:660 additive',
  'route-policy PL-BUSY-IN permit node 5',
  ' apply extcommunity rt 268568:660 additive',
  'route-policy PL-BUSY-IN permit node 6',
  ' apply extcommunity rt 268568:660 additive',
  'route-policy PL-BUSY-IN permit node 7',
  ' apply extcommunity rt 268568:660 additive',
  'route-policy PL-BUSY-IN permit node 8',
  ' apply extcommunity rt 268568:660 additive',
  'route-policy PL-BUSY-IN permit node 9',
  ' apply extcommunity rt 268568:660 additive',
  'route-policy PL-BUSY-IN permit node 11',
].join('\n');

function makePeer(
  overrides: Partial<DiscoveredBgpPeer> & Pick<DiscoveredBgpPeer, 'peerAddress'>,
): DiscoveredBgpPeer {
  return {
    addressFamily: 'IPV4',
    remoteAs: 6939n,
    stateCode: 6,
    state: 'ESTABLISHED' as DiscoveredBgpPeer['state'],
    sessionUptimeSeconds: 3600,
    cliReceivedPrefixes: 12n,
    bgpPeerDescription: null,
    interfaceId: 'if-1',
    interfaceName: '100GE0/1/48',
    interfaceAlias: 'HORIZONTE_IP_40GB',
    interfaceDescription: 'HORIZONTE_IP_40GB',
    displayName: 'HORIZONTE_IP_40GB',
    correlationStatus: 'MATCHED',
    correlationError: null,
    ...overrides,
  };
}

function outcomeOf(peers: DiscoveredBgpPeer[]): BgpDiscoveryOutcome {
  return { peers, localAs: 64500n, localAsAmbiguous: false, ipv6Supported: true, warnings: [] };
}

interface Harness {
  service: BgpMitigationDiscoveryService;
  repository: InMemoryMitigationRepository;
  config: { bgp: string | null; routePolicy: string | null };
  configSource: BgpMitigationConfigSource & { calls: number };
}

function createHarness(options: { prefixLimit?: number; bgp?: string | null; routePolicy?: string | null } = {}): Harness {
  const repository = new InMemoryMitigationRepository();
  const config = {
    bgp: options.bgp === undefined ? BGP_CONFIG : options.bgp,
    routePolicy: options.routePolicy === undefined ? RP_CONFIG : options.routePolicy,
  };
  const configSource: BgpMitigationConfigSource & { calls: number } = {
    calls: 0,
    async readMitigationConfig() {
      configSource.calls += 1;
      return {
        bgpConfiguration: config.bgp,
        routePolicyConfiguration: config.routePolicy,
        warnings: [],
      };
    },
  };
  const service = new BgpMitigationDiscoveryService({
    bgpDiscovery: {
      discover: async () => {
        throw new Error('discover nao deveria ser chamado neste teste');
      },
    },
    configSource,
    repository,
    ...(options.prefixLimit === undefined ? {} : { prefixLimit: options.prefixLimit }),
  });
  return { service, repository, config, configSource };
}

async function discover(
  harness: Harness,
  peers: DiscoveredBgpPeer[],
  device: HostRecord = DEVICE,
): Promise<MitigationDiscoveryResult> {
  return harness.service.discoverFromBgpOutcome(device, outcomeOf(peers));
}

describe('discovery de candidatos a mitigacao', () => {
  it('1) peer com HORIZONTE_IP_40GB vira profile 40G pronto', async () => {
    const harness = createHarness();

    const result = await discover(harness, [makePeer({ peerAddress: '10.200.200.106' })]);

    expect(result.scannedPeers).toBe(1);
    expect(result.candidateInterfaces).toBe(1);
    expect(result.createdProfiles).toBe(1);
    expect(result.ignoredNoBandwidth).toBe(0);
    const profile = result.profiles[0]!;
    expect(profile.policyName).toBe('PL-HORIZONTES_IPv4-IN');
    expect(profile.customer).toBe('HORIZONTE_IP');
    expect(profile.detectedBandwidthBps).toBe(40_000_000_000n);
    expect(profile.effectiveBandwidthBps).toBe(40_000_000_000n);
    expect(profile.interfaceDescriptionRaw).toBe('HORIZONTE_IP_40GB');
    expect(profile.readiness).toBe('READY');
    expect(profile.blockedReason).toBeNull();
  });

  it('2) peer com CLICKING_IP_20GB vira profile 20G', async () => {
    const harness = createHarness();

    const result = await discover(harness, [
      makePeer({
        peerAddress: '10.200.200.106',
        interfaceAlias: 'CLICKING_IP_20GB',
        interfaceDescription: 'CLICKING_IP_20GB',
      }),
    ]);

    expect(result.createdProfiles).toBe(1);
    expect(result.profiles[0]?.detectedBandwidthBps).toBe(20_000_000_000n);
    expect(result.profiles[0]?.customer).toBe('CLICKING_IP');
  });

  it('3) UPLINK-ELETRONET fica fora do escopo', async () => {
    const harness = createHarness();

    const result = await discover(harness, [
      makePeer({
        peerAddress: '10.200.200.106',
        interfaceAlias: 'UPLINK-ELETRONET',
        interfaceDescription: 'UPLINK-ELETRONET',
      }),
    ]);

    expect(result.ignoredNoBandwidth).toBe(1);
    expect(result.createdProfiles).toBe(0);
    expect(result.profiles).toHaveLength(0);
  });

  it('4) interface 100GE0/1/48 com alias UPLINK continua fora do escopo', async () => {
    const harness = createHarness();

    const result = await discover(harness, [
      makePeer({
        peerAddress: '10.200.200.106',
        interfaceName: '100GE0/1/48',
        interfaceAlias: 'UPLINK',
        interfaceDescription: 'UPLINK',
      }),
    ]);

    expect(result.ignoredNoBandwidth).toBe(1);
    expect(result.createdProfiles).toBe(0);
  });

  it('5) speedBps de 100G nao substitui a banda contratada', async () => {
    const harness = createHarness();
    const device = {
      id: 'device-1',
      interfaces: [
        {
          id: 'if-1',
          name: '100GE0/1/48',
          alias: 'UPLINK-TUDDO',
          description: 'UPLINK-TUDDO',
          speedBps: 100_000_000_000,
        },
      ],
    } as unknown as HostRecord;

    const result = await discover(
      harness,
      [
        makePeer({
          peerAddress: '10.200.200.106',
          interfaceAlias: 'UPLINK-TUDDO',
          interfaceDescription: 'UPLINK-TUDDO',
        }),
      ],
      device,
    );

    expect(result.ignoredNoBandwidth).toBe(1);
    expect(result.createdProfiles).toBe(0);
  });

  it('6) banda sem policy IN fica NOT_READY com POLICY_NOT_FOUND (sem profile inventado)', async () => {
    const harness = createHarness();

    const result = await discover(harness, [makePeer({ peerAddress: '10.200.200.99' })]);

    expect(result.createdProfiles).toBe(0);
    expect(result.blockedProfiles).toBe(1);
    const entry = result.profiles[0]!;
    expect(entry.policyName).toBeNull();
    expect(entry.readiness).toBe('NOT_READY');
    expect(entry.blockedReason).toBe('POLICY_NOT_FOUND');
    expect(entry.detectedBandwidthBps).toBe(40_000_000_000n);
    expect(await harness.repository.listProfiles({ deviceId: DEVICE.id })).toHaveLength(0);
  });

  it('7) policy IN encontrada e persistida com prefixLimit default', async () => {
    const harness = createHarness();

    await discover(harness, [makePeer({ peerAddress: '10.200.200.106' })]);

    const profiles = await harness.repository.listProfiles({ deviceId: DEVICE.id });
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.policyName).toBe('PL-HORIZONTES_IPv4-IN');
    expect(profiles[0]?.prefixLimit).toBe(100);
    expect(profiles[0]?.mode).toBe('ALERT_ONLY');
    expect(profiles[0]?.enabled).toBe(true);
  });

  it('8) policy OUT nunca e usada como IN', async () => {
    const harness = createHarness();

    const result = await discover(harness, [makePeer({ peerAddress: '10.200.200.40' })]);

    expect(result.createdProfiles).toBe(0);
    expect(result.profiles[0]?.policyName).toBeNull();
    expect(result.profiles[0]?.blockedReason).toBe('POLICY_NOT_FOUND');
  });

  it('9) dois peers na mesma policy viram um profile com dois peers', async () => {
    const harness = createHarness();

    const result = await discover(harness, [
      makePeer({ peerAddress: '10.200.200.10' }),
      makePeer({ peerAddress: '10.200.200.106' }),
    ]);

    expect(result.createdProfiles).toBe(1);
    const profiles = await harness.repository.listProfiles({ deviceId: DEVICE.id });
    expect(profiles).toHaveLength(1);
    const peers = await harness.repository.listProfilePeers(profiles[0]!.id);
    expect(peers.map((peer) => peer.peerAddress).sort()).toEqual([
      '10.200.200.10',
      '10.200.200.106',
    ]);
    expect(peers.filter((peer) => peer.primary)).toHaveLength(1);
    expect(peers.find((peer) => peer.primary)?.peerAddress).toBe('10.200.200.10');
  });

  it('10) prefix count confortavel e SAFE e 80-100% e WARNING sem bloquear', async () => {
    const harness = createHarness();

    const safe = await discover(harness, [
      makePeer({ peerAddress: '10.200.200.106', cliReceivedPrefixes: 50n }),
    ]);
    expect(safe.profiles[0]?.prefixStatus).toBe('SAFE');
    expect(safe.profiles[0]?.readiness).toBe('READY');

    const warning = await discover(harness, [
      makePeer({ peerAddress: '10.200.200.106', cliReceivedPrefixes: 100n }),
    ]);
    expect(warning.profiles[0]?.prefixStatus).toBe('WARNING');
    expect(warning.profiles[0]?.readiness).toBe('READY');
  });

  it('11) prefix count acima de 100 bloqueia', async () => {
    const harness = createHarness();

    const result = await discover(harness, [
      makePeer({ peerAddress: '10.200.200.106', cliReceivedPrefixes: 1000n }),
    ]);

    expect(result.profiles[0]?.prefixStatus).toBe('EXCEEDED');
    expect(result.profiles[0]?.readiness).toBe('NOT_READY');
    expect(result.profiles[0]?.blockedReason).toBe('PREFIX_LIMIT_EXCEEDED');
  });

  it('12) prefix count desconhecido fica UNKNOWN informativo e NAO bloqueia', async () => {
    const harness = createHarness();

    const result = await discover(harness, [
      makePeer({ peerAddress: '10.200.200.106', cliReceivedPrefixes: null }),
    ]);

    expect(result.profiles[0]?.prefixStatus).toBe('UNKNOWN');
    expect(result.profiles[0]?.readiness).toBe('READY');
    expect(result.profiles[0]?.blockedReason).toBeNull();
    expect(result.blockedProfiles).toBe(0);
  });

  it('13) nodes 1 e 2 livres planejam o par BOGONS 1 + mitigacao 2', async () => {
    const harness = createHarness();

    const result = await discover(harness, [makePeer({ peerAddress: '10.200.200.106' })]);

    expect(result.profiles[0]?.existingNodes).toEqual([11, 12]);
    expect(result.profiles[0]?.firstNormalNode).toBe(11);
    expect(result.profiles[0]?.plannedNode).toBe(2);
  });

  it('14) node 1 ocupado empurra o par para BOGONS 2 + mitigacao 3', async () => {
    const harness = createHarness({
      bgp: bgpV4('peer 10.200.200.50 route-policy PL-PARCIAL-IN import'),
      routePolicy: [
        'route-policy PL-PARCIAL-IN permit node 1',
        ' if-match ip-prefix PREFIX8to24',
        ' apply extcommunity rt 268568:660 additive',
        'route-policy PL-PARCIAL-IN permit node 11',
      ].join('\n'),
    });

    const result = await discover(harness, [makePeer({ peerAddress: '10.200.200.50' })]);

    expect(result.profiles[0]?.existingNodes).toEqual([1, 11]);
    expect(result.profiles[0]?.firstNormalNode).toBe(11);
    expect(result.profiles[0]?.plannedNode).toBe(3);
    expect(result.profiles[0]?.readiness).toBe('READY');
  });

  it('15) nodes 1..9 ocupados bloqueiam por falta de node seguro', async () => {
    const harness = createHarness();

    const result = await discover(harness, [makePeer({ peerAddress: '10.200.200.50' })]);

    expect(result.profiles[0]?.plannedNode).toBeNull();
    expect(result.profiles[0]?.readiness).toBe('NOT_READY');
    expect(result.profiles[0]?.blockedReason).toBe('NO_SAFE_TEMPORARY_NODE');
  });

  it('16) rodar o discovery duas vezes nao duplica profile', async () => {
    const harness = createHarness();

    const first = await discover(harness, [makePeer({ peerAddress: '10.200.200.106' })]);
    const second = await discover(harness, [makePeer({ peerAddress: '10.200.200.106' })]);

    expect(first.createdProfiles).toBe(1);
    expect(second.createdProfiles).toBe(0);
    expect(second.updatedProfiles).toBe(1);
    expect(await harness.repository.listProfiles({ deviceId: DEVICE.id })).toHaveLength(1);
  });

  it('17) bandwidthOverrideBps manual sobrevive ao rerun', async () => {
    const harness = createHarness();
    await discover(harness, [makePeer({ peerAddress: '10.200.200.106' })]);
    const [profile] = await harness.repository.listProfiles({ deviceId: DEVICE.id });
    await harness.repository.setProfileBandwidthOverride(profile!.id, 10_000_000_000n);

    const result = await discover(harness, [makePeer({ peerAddress: '10.200.200.106' })]);

    const stored = await harness.repository.getProfile(profile!.id);
    expect(stored?.bandwidthOverrideBps).toBe(10_000_000_000n);
    expect(stored?.detectedBandwidthBps).toBe(40_000_000_000n);
    expect(result.profiles[0]?.effectiveBandwidthBps).toBe(10_000_000_000n);
  });

  it('18) descricao 40G -> 50G atualiza a banda detectada sem apagar o override', async () => {
    const harness = createHarness();
    await discover(harness, [makePeer({ peerAddress: '10.200.200.106' })]);
    const [profile] = await harness.repository.listProfiles({ deviceId: DEVICE.id });
    await harness.repository.setProfileBandwidthOverride(profile!.id, 10_000_000_000n);

    await discover(harness, [
      makePeer({
        peerAddress: '10.200.200.106',
        interfaceAlias: 'HORIZONTE_IP_50GB',
        interfaceDescription: 'HORIZONTE_IP_50GB',
      }),
    ]);

    const stored = await harness.repository.getProfile(profile!.id);
    expect(stored?.detectedBandwidthBps).toBe(50_000_000_000n);
    expect(stored?.bandwidthOverrideBps).toBe(10_000_000_000n);
  });

  it('19) interface que perdeu a banda sai do escopo com runtime DISABLED', async () => {
    const harness = createHarness();
    await discover(harness, [makePeer({ peerAddress: '10.200.200.106' })]);
    const [profile] = await harness.repository.listProfiles({ deviceId: DEVICE.id });

    const result = await discover(harness, [
      makePeer({
        peerAddress: '10.200.200.106',
        interfaceAlias: 'HORIZONTE_IP',
        interfaceDescription: 'HORIZONTE_IP',
      }),
    ]);

    expect(result.ignoredNoBandwidth).toBe(1);
    expect(result.outOfScopeProfiles).toEqual(['PL-HORIZONTES_IPv4-IN']);
    expect((await harness.repository.getRuntime(profile!.id))?.state).toBe('DISABLED');
    // historico preservado: o profile continua existindo
    expect(await harness.repository.getProfile(profile!.id)).not.toBeNull();
  });

  it('20) policy alterada reconcilia: novo profile criado e o antigo vira DISABLED', async () => {
    const harness = createHarness();
    await discover(harness, [makePeer({ peerAddress: '10.200.200.30' })]);
    const [antigo] = await harness.repository.listProfiles({ deviceId: DEVICE.id });
    expect(antigo?.policyName).toBe('PL-OUTRA_IPv4-IN');

    // O equipamento mudou a policy de import do mesmo peer.
    harness.config.bgp = bgpV4('peer 10.200.200.30 route-policy PL-HORIZONTES_IPv4-IN import');

    const result = await discover(harness, [makePeer({ peerAddress: '10.200.200.30' })]);

    const profiles = await harness.repository.listProfiles({ deviceId: DEVICE.id });
    expect(profiles.map((profile) => profile.policyName).sort()).toEqual([
      'PL-HORIZONTES_IPv4-IN',
      'PL-OUTRA_IPv4-IN',
    ]);
    expect(result.outOfScopeProfiles).toEqual(['PL-OUTRA_IPv4-IN']);
    expect((await harness.repository.getRuntime(antigo!.id))?.state).toBe('DISABLED');

    const novo = profiles.find((profile) => profile.policyName === 'PL-HORIZONTES_IPv4-IN');
    const peers = await harness.repository.listProfilePeers(novo!.id);
    expect(peers.map((peer) => peer.peerAddress)).toEqual(['10.200.200.30']);
  });

  it('21) correlacao ambigua nao infere interface nem cria profile', async () => {
    const harness = createHarness();

    const result = await discover(harness, [
      makePeer({
        peerAddress: '10.200.200.106',
        interfaceId: null,
        interfaceName: null,
        interfaceAlias: null,
        interfaceDescription: null,
        correlationStatus: 'AMBIGUOUS',
      }),
    ]);

    expect(result.ambiguousPeers).toEqual(['10.200.200.106']);
    expect(result.createdProfiles).toBe(0);
    expect(await harness.repository.listProfiles({ deviceId: DEVICE.id })).toHaveLength(0);
  });

  it('23) a configuracao BGP e lida de forma agregada (uma vez por device)', async () => {
    const harness = createHarness();
    const peers = [
      makePeer({ peerAddress: '10.200.200.10' }),
      makePeer({ peerAddress: '10.200.200.106' }),
      makePeer({ peerAddress: '10.200.200.30' }),
    ];
    const service = new BgpMitigationDiscoveryService({
      bgpDiscovery: { discover: async () => outcomeOf(peers) },
      configSource: harness.configSource,
      repository: harness.repository,
    });

    const result = await service.discoverMitigationProfiles(DEVICE);

    expect(result.scannedPeers).toBe(3);
    expect(harness.configSource.calls).toBe(1);
  });
});

describe('agregacao de prefix count', () => {
  it('usa o maior contador e falha fechado quando algum peer e desconhecido', () => {
    expect(aggregatePrefixCount([10n, 42n, 7n])).toBe(42);
    expect(aggregatePrefixCount([10n, null])).toBeNull();
    expect(aggregatePrefixCount([])).toBeNull();
  });
});

// ---- ajustes de seguranca pos-revisao -------------------------------------

const RT_MITIGACAO = '268568:660';
const RT_NORMAL = '268568:110';

/** PL-BUSY-IN com os nodes 1..9 ja mitigados e o node 11 normal. */
const RP_BUSY_IN = [
  ...Array.from({ length: 9 }, (_unused, index) => [
    `route-policy PL-BUSY-IN permit node ${index + 1}`,
    ` apply extcommunity rt ${RT_MITIGACAO} additive`,
  ]).flat(),
  'route-policy PL-BUSY-IN permit node 11',
].join('\n');

/** PL-BUSY-IN ainda liberada: so o node normal 11 existe. */
const RP_BUSY_FREE = 'route-policy PL-BUSY-IN permit node 11';

const BGP_BUSY = bgpV4('peer 10.200.200.50 route-policy PL-BUSY-IN import');

interface RtFixture {
  bgp: string;
  routePolicy: string;
}

function rtFixture(policyName: string, body: string[]): RtFixture {
  return {
    bgp: bgpV4(`peer 10.200.200.10 route-policy ${policyName} import`),
    routePolicy: body.join('\n'),
  };
}

describe('node de mitigacao e definido pela RT do motor (nao por qualquer RT)', () => {
  it('node normal 11 com RT 268568:110 NAO e mitigacao, continua firstNormalNode e candidato 1', async () => {
    const harness = createHarness(
      rtFixture('PL-MISTA-IN', [
        'route-policy PL-MISTA-IN permit node 11',
        ' if-match ip-prefix PREFIX-HORIZONTES-IPV4',
        ' apply local-preference 4000',
        ` apply extcommunity rt ${RT_NORMAL} additive`,
      ]),
    );

    const result = await discover(harness, [makePeer({ peerAddress: '10.200.200.10' })]);
    const profile = result.profiles[0]!;

    expect(profile.mitigationNodes).toEqual([]);
    expect(profile.existingNodes).toEqual([11]);
    expect(profile.firstNormalNode).toBe(11);
    expect(profile.plannedNode).toBe(2);
    expect(profile.readiness).toBe('READY');
  });

  it('node 1 com RT 268568:660 E node de mitigacao e empurra o candidato para 2', async () => {
    const harness = createHarness(
      rtFixture('PL-MIT-IN', [
        'route-policy PL-MIT-IN permit node 1',
        ' if-match ip-prefix PREFIX8to24',
        ` apply extcommunity rt ${RT_MITIGACAO} additive`,
        'route-policy PL-MIT-IN permit node 11',
      ]),
    );

    const result = await discover(harness, [makePeer({ peerAddress: '10.200.200.10' })]);
    const profile = result.profiles[0]!;

    expect(profile.mitigationNodes).toEqual([1]);
    expect(profile.firstNormalNode).toBe(11);
    expect(profile.plannedNode).toBe(3);
  });

  it('node com duas RTs incluindo a de mitigacao E node de mitigacao', async () => {
    const harness = createHarness(
      rtFixture('PL-DUPLA-IN', [
        'route-policy PL-DUPLA-IN permit node 1',
        ' if-match ip-prefix PREFIX8to24',
        ` apply extcommunity rt ${RT_NORMAL} additive`,
        ` apply extcommunity rt ${RT_MITIGACAO} additive`,
        'route-policy PL-DUPLA-IN permit node 11',
      ]),
    );

    const result = await discover(harness, [makePeer({ peerAddress: '10.200.200.10' })]);
    const profile = result.profiles[0]!;

    expect(profile.mitigationNodes).toEqual([1]);
    expect(profile.plannedNode).toBe(3);
  });

  it('node sem RT nenhuma NAO e node de mitigacao', async () => {
    const harness = createHarness(
      rtFixture('PL-SEM-RT-IN', [
        'route-policy PL-SEM-RT-IN permit node 1',
        ' if-match community-filter X',
        'route-policy PL-SEM-RT-IN permit node 11',
      ]),
    );

    const result = await discover(harness, [makePeer({ peerAddress: '10.200.200.10' })]);
    const profile = result.profiles[0]!;

    expect(profile.mitigationNodes).toEqual([]);
    expect(profile.firstNormalNode).toBe(1);
    expect(profile.plannedNode).toBeNull();
    expect(profile.blockedReason).toBe('NO_SAFE_TEMPORARY_NODE');
  });

  it('a RT de mitigacao e configuravel (outra RT nao classifica)', async () => {
    const harness = createHarness();
    const fixture = rtFixture('PL-CUSTOM-IN', [
      'route-policy PL-CUSTOM-IN permit node 1',
      ` apply extcommunity rt ${RT_MITIGACAO} additive`,
      'route-policy PL-CUSTOM-IN permit node 11',
    ]);
    harness.config.bgp = fixture.bgp;
    harness.config.routePolicy = fixture.routePolicy;
    const service = new BgpMitigationDiscoveryService({
      bgpDiscovery: { discover: async () => outcomeOf([makePeer({ peerAddress: '10.200.200.10' })]) },
      configSource: harness.configSource,
      repository: harness.repository,
      mitigationRt: '9999:1',
    });

    const result = await service.discoverMitigationProfiles(DEVICE);

    // Com outra RT configurada, o node 1 (que tem 268568:660) volta a ser normal.
    expect(result.profiles[0]?.mitigationNodes).toEqual([]);
    expect(result.profiles[0]?.firstNormalNode).toBe(1);
  });
});

describe('profile NOT_READY nunca e persistido como runtime NORMAL', () => {
  async function runtimeAfterSingleDiscovery(
    peer: DiscoveredBgpPeer,
    options: { bgp?: string; routePolicy?: string } = {},
  ) {
    const harness = createHarness(options);
    await discover(harness, [peer]);
    const [profile] = await harness.repository.listProfiles({ deviceId: DEVICE.id });
    if (!profile) throw new Error('profile nao foi persistido');
    const runtime = await harness.repository.getRuntime(profile.id);
    return { harness, profile, runtime };
  }

  it('PREFIX_UNKNOWN e informativo: runtime segue NORMAL', async () => {
    const { runtime } = await runtimeAfterSingleDiscovery(
      makePeer({ peerAddress: '10.200.200.106', cliReceivedPrefixes: null }),
    );
    expect(runtime?.state).toBe('NORMAL');
    expect(runtime?.state).not.toBe('RECONCILIATION_REQUIRED');
  });

  it('PREFIX_EXCEEDED', async () => {
    const { runtime } = await runtimeAfterSingleDiscovery(
      makePeer({ peerAddress: '10.200.200.106', cliReceivedPrefixes: 1000n }),
    );
    expect(runtime?.state).toBe('RECONCILIATION_REQUIRED');
    expect(runtime?.state).not.toBe('NORMAL');
  });

  it('policy compartilhada em interfaces diferentes NAO vira INTERFACE_AMBIGUOUS', async () => {
    const harness = createHarness();

    // Mesma policy, duas interfaces: sao DOIS targets (nao ambiguidade).
    const result = await discover(harness, [
      makePeer({ peerAddress: '10.200.200.10', interfaceId: 'if-1', interfaceName: 'Eth-Trunk1.3011' }),
      makePeer({ peerAddress: '10.200.200.106', interfaceId: 'if-2', interfaceName: 'Eth-Trunk1.3013' }),
    ]);

    expect(result.profiles).toHaveLength(2);
    for (const row of result.profiles) {
      expect(row.blockedReason).not.toBe('INTERFACE_AMBIGUOUS');
      expect(row.readiness).toBe('READY');
      expect(row.sharedPolicy).toBe(true);
      // Decisao operacional: policy compartilhada e AVISO, nao bloqueio.
      expect(row.autoBlockedReason).toBeNull();
      expect(row.addressFamily).toBe('IPV4');
    }
    // cada target tem sua interface e nenhum fica RECONCILIATION_REQUIRED
    const interfaces = result.profiles.map((row) => row.interfaceName).sort();
    expect(new Set(interfaces).size).toBe(2);
    for (const row of result.profiles) {
      const runtime = await harness.repository.getRuntime(row.profileId!);
      expect(runtime?.state).toBe('NORMAL');
    }
  });

  it('NO_SAFE_TEMPORARY_NODE', async () => {
    const { runtime } = await runtimeAfterSingleDiscovery(
      makePeer({ peerAddress: '10.200.200.50' }),
      { bgp: BGP_BUSY, routePolicy: RP_BUSY_IN },
    );
    expect(runtime?.state).toBe('RECONCILIATION_REQUIRED');
    expect(runtime?.state).not.toBe('NORMAL');
  });
});

describe('plannedNode nao sobrevive a condicao que deixou de existir', () => {
  it('e limpo quando os nodes 1..9 ficam ocupados', async () => {
    const harness = createHarness({ bgp: BGP_BUSY, routePolicy: RP_BUSY_FREE });
    const first = await discover(harness, [makePeer({ peerAddress: '10.200.200.50' })]);
    expect(first.profiles[0]?.plannedNode).toBe(2);
    const [profile] = await harness.repository.listProfiles({ deviceId: DEVICE.id });
    expect((await harness.repository.getRuntime(profile!.id))?.plannedNode).toBe(2);

    harness.config.routePolicy = RP_BUSY_IN;
    const second = await discover(harness, [makePeer({ peerAddress: '10.200.200.50' })]);

    expect(second.profiles[0]?.blockedReason).toBe('NO_SAFE_TEMPORARY_NODE');
    expect(second.profiles[0]?.plannedNode).toBeNull();
    expect((await harness.repository.getRuntime(profile!.id))?.plannedNode).toBeNull();
  });

  it('e limpo quando a policy muda e o profile antigo sai de escopo', async () => {
    const harness = createHarness();
    await discover(harness, [makePeer({ peerAddress: '10.200.200.30' })]);
    const [antigo] = await harness.repository.listProfiles({ deviceId: DEVICE.id });
    expect((await harness.repository.getRuntime(antigo!.id))?.plannedNode).toBe(2);

    harness.config.bgp = bgpV4('peer 10.200.200.30 route-policy PL-HORIZONTES_IPv4-IN import');
    const result = await discover(harness, [makePeer({ peerAddress: '10.200.200.30' })]);

    expect(result.outOfScopeProfiles).toEqual(['PL-OUTRA_IPv4-IN']);
    const runtimeAntigo = await harness.repository.getRuntime(antigo!.id);
    expect(runtimeAntigo?.state).toBe('DISABLED');
    expect(runtimeAntigo?.plannedNode).toBeNull();
  });

  it('e limpo quando o read-back da route-policy falha', async () => {
    const harness = createHarness();
    await discover(harness, [makePeer({ peerAddress: '10.200.200.106' })]);
    const [profile] = await harness.repository.listProfiles({ deviceId: DEVICE.id });
    expect((await harness.repository.getRuntime(profile!.id))?.plannedNode).toBe(2);

    harness.config.routePolicy = null;
    const result = await discover(harness, [makePeer({ peerAddress: '10.200.200.106' })]);

    expect(result.profiles[0]?.blockedReason).toBe('READBACK_FAILED');
    expect((await harness.repository.getRuntime(profile!.id))?.plannedNode).toBeNull();
    expect((await harness.repository.getRuntime(profile!.id))?.state).toBe(
      'RECONCILIATION_REQUIRED',
    );
  });
});

describe('retorno ao estado operacional apropriado', () => {
  it('volta a READY e retorna a NORMAL quando o bloqueio desaparece', async () => {
    const harness = createHarness({ bgp: BGP_BUSY, routePolicy: RP_BUSY_FREE });
    await discover(harness, [makePeer({ peerAddress: '10.200.200.50' })]);
    const [profile] = await harness.repository.listProfiles({ deviceId: DEVICE.id });
    expect((await harness.repository.getRuntime(profile!.id))?.state).toBe('NORMAL');

    harness.config.routePolicy = RP_BUSY_IN;
    await discover(harness, [makePeer({ peerAddress: '10.200.200.50' })]);
    expect((await harness.repository.getRuntime(profile!.id))?.state).toBe(
      'RECONCILIATION_REQUIRED',
    );

    harness.config.routePolicy = RP_BUSY_FREE;
    const third = await discover(harness, [makePeer({ peerAddress: '10.200.200.50' })]);

    expect(third.profiles[0]?.readiness).toBe('READY');
    const runtime = await harness.repository.getRuntime(profile!.id);
    expect(runtime?.state).toBe('NORMAL');
    expect(runtime?.plannedNode).toBe(2);
  });

  it('nao sobrescreve um estado operacional em andamento (MITIGATED)', async () => {
    const harness = createHarness();
    await discover(harness, [makePeer({ peerAddress: '10.200.200.106' })]);
    const [profile] = await harness.repository.listProfiles({ deviceId: DEVICE.id });
    await harness.repository.upsertRuntime(profile!.id, { state: 'MITIGATED' });

    const result = await discover(harness, [makePeer({ peerAddress: '10.200.200.106' })]);

    expect(result.profiles[0]?.readiness).toBe('READY');
    expect((await harness.repository.getRuntime(profile!.id))?.state).toBe('MITIGATED');
  });
});


describe('caso real HORIZONTES: policy compartilhada e familias separadas', () => {
  const bgp = bgpV4(
    'peer 10.200.200.106 route-policy PL-HORIZONTES_IPv4-IN import',
    'peer 10.200.200.10 route-policy PL-HORIZONTES_IPv4-IN import',
  );
  const routePolicy = 'route-policy PL-HORIZONTES_IPv4-IN permit node 11';

  it('dois peers IPv4 em interfaces diferentes viram DOIS targets (nunca INTERFACE_AMBIGUOUS)', async () => {
    const harness = createHarness({ bgp, routePolicy });
    const peers = [
      makePeer({
        peerAddress: '10.200.200.106',
        addressFamily: 'IPV4',
        interfaceId: 'if-3011',
        interfaceName: 'Eth-Trunk1.3011',
        interfaceAlias: 'HORIZONTE_IP_40GB',
        interfaceDescription: 'HORIZONTE_IP_40GB',
        cliReceivedPrefixes: 12n,
      }),
      makePeer({
        peerAddress: '2804:532c:0:1::66',
        addressFamily: 'IPV6',
        interfaceId: 'if-3011',
        interfaceName: 'Eth-Trunk1.3011',
        interfaceAlias: 'HORIZONTE_IP_40GB',
        interfaceDescription: 'HORIZONTE_IP_40GB',
        cliReceivedPrefixes: 1n,
      }),
      makePeer({
        peerAddress: '10.200.200.10',
        addressFamily: 'IPV4',
        interfaceId: 'if-3013',
        interfaceName: 'Eth-Trunk1.3013',
        interfaceAlias: 'HORIZONTE_IP_02_40GB',
        interfaceDescription: 'HORIZONTE_IP_02_40GB',
        cliReceivedPrefixes: 8n,
      }),
      makePeer({
        peerAddress: '2804:532c:0:1::76',
        addressFamily: 'IPV6',
        interfaceId: 'if-3013',
        interfaceName: 'Eth-Trunk1.3013',
        interfaceAlias: 'HORIZONTE_IP_02_40GB',
        interfaceDescription: 'HORIZONTE_IP_02_40GB',
        cliReceivedPrefixes: null,
      }),
    ];

    const result = await discover(harness, peers);
    const alvo1 = result.profiles.find((row) => row.peerAddresses.includes('10.200.200.106'));
    const alvo2 = result.profiles.find((row) => row.peerAddresses.includes('10.200.200.10'));

    // TARGET 1 - HORIZONTE_IP / Eth-Trunk1.3011 / IPv4
    expect(alvo1).toBeDefined();
    expect(alvo1?.addressFamily).toBe('IPV4');
    expect(alvo1?.interfaceName).toBe('Eth-Trunk1.3011');
    expect(alvo1?.customer).toBe('HORIZONTE_IP');
    expect(alvo1?.policyName).toBe('PL-HORIZONTES_IPv4-IN');
    expect(alvo1?.peerAddresses).toEqual(['10.200.200.106']);
    expect(alvo1?.detectedBandwidthBps).toBe(40_000_000_000n);
    expect(alvo1?.readiness).toBe("READY");
    expect(alvo1?.blockedReason).toBeNull();
    expect(alvo1?.prefixCount).toBe(12);
    expect(alvo1?.prefixStatus).toBe('SAFE');
    expect(alvo1?.sharedPolicy).toBe(true);
    expect(alvo1?.autoBlockedReason).toBeNull();
    expect(alvo1?.sharedPolicyTargets).toHaveLength(1);
    expect(alvo1?.sharedPolicyTargets[0]).toMatchObject({
      interfaceName: 'Eth-Trunk1.3013',
      peerAddress: '10.200.200.10',
      addressFamily: 'IPV4',
      prefixCount: 8,
    });

    // TARGET 2 - HORIZONTE_IP_02 / Eth-Trunk1.3013 / IPv4
    expect(alvo2).toBeDefined();
    expect(alvo2?.addressFamily).toBe('IPV4');
    expect(alvo2?.interfaceName).toBe('Eth-Trunk1.3013');
    expect(alvo2?.prefixCount).toBe(8);
    expect(alvo2?.readiness).toBe("READY");
    expect(alvo2?.sharedPolicy).toBe(true);

    // nenhum dos dois pode ficar ambiguo por causa da policy compartilhada
    expect(alvo1?.blockedReason).not.toBe('INTERFACE_AMBIGUOUS');
    expect(alvo2?.blockedReason).not.toBe('INTERFACE_AMBIGUOUS');

    // o IPv6 sem policy nao pode contaminar o target IPv4
    const ipv6 = result.profiles.filter((row) => row.addressFamily === 'IPV6');
    expect(ipv6).toHaveLength(2);
    for (const row of ipv6) expect(row.blockedReason).toBe('POLICY_NOT_FOUND');
    expect(result.profiles).toHaveLength(4);
  });
});

describe('persistencia best effort no discovery', () => {
  it('mantem a analise quando a escrita no banco falha (sem migration)', async () => {
    const harness = createHarness();
    // Espelha o Prisma sem a tabela: leitura vazia, escrita estourando.
    const failing = new Proxy(harness.repository, {
      get(target, property, receiver) {
        if (typeof property === 'symbol') return Reflect.get(target, property, receiver);
        if (property === 'listProfiles') return async () => [];
        return async () => {
          throw new Error('relation "BgpMitigationProfile" does not exist');
        };
      },
    }) as unknown as typeof harness.repository;
    const service = new BgpMitigationDiscoveryService({
      bgpDiscovery: {
        discover: async () => outcomeOf([makePeer({ peerAddress: '10.200.200.106' })]),
      },
      configSource: harness.configSource,
      repository: failing,
    });

    const result = await service.discoverMitigationProfiles(DEVICE);

    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]).toMatchObject({
      profileId: null,
      policyName: 'PL-HORIZONTES_IPv4-IN',
      detectedBandwidthBps: 40_000_000_000n,
      readiness: 'READY',
    });
    expect(result.createdProfiles).toBe(0);
    expect(result.warnings.join(' ')).toContain('nao foi possivel persistir');
  });
});

describe('regra PREFIX_UNKNOWN informativo (casos A-H)', () => {
  it('A) prefixCount=null + policy valida + nodes validos => READY', async () => {
    const harness = createHarness();
    const result = await discover(harness, [
      makePeer({ peerAddress: '10.200.200.106', cliReceivedPrefixes: null }),
    ]);
    const profile = result.profiles[0]!;
    expect(profile.policyName).toBe('PL-HORIZONTES_IPv4-IN');
    expect(profile.prefixStatus).toBe('UNKNOWN');
    expect(profile.readiness).toBe('READY');
    expect(profile.blockedReason).toBeNull();
    expect(profile.plannedNode).not.toBeNull();
  });

  it('B) peer DOWN + policy valida + interface correlacionada => READY', async () => {
    const harness = createHarness();
    const result = await discover(harness, [
      makePeer({
        peerAddress: '10.200.200.106',
        stateCode: 1,
        state: 'IDLE',
        sessionUptimeSeconds: 0,
      }),
    ]);
    const profile = result.profiles[0]!;
    expect(profile.policyName).toBe('PL-HORIZONTES_IPv4-IN');
    expect(profile.readiness).toBe('READY');
    expect(profile.blockedReason).toBeNull();
  });

  it('C) prefixCount=0 => READY', async () => {
    const harness = createHarness();
    const result = await discover(harness, [
      makePeer({ peerAddress: '10.200.200.106', cliReceivedPrefixes: 0n }),
    ]);
    const profile = result.profiles[0]!;
    expect(profile.prefixStatus).toBe('SAFE');
    expect(profile.readiness).toBe('READY');
    expect(profile.blockedReason).toBeNull();
  });

  it('D) prefixCount=7 => READY', async () => {
    const harness = createHarness();
    const result = await discover(harness, [
      makePeer({ peerAddress: '10.200.200.106', cliReceivedPrefixes: 7n }),
    ]);
    const profile = result.profiles[0]!;
    expect(profile.prefixStatus).toBe('SAFE');
    expect(profile.readiness).toBe('READY');
    expect(profile.blockedReason).toBeNull();
  });

  it('E) prefixCount=101 com limit 100 => NOT_READY/PREFIX_LIMIT_EXCEEDED', async () => {
    const harness = createHarness();
    const result = await discover(harness, [
      makePeer({ peerAddress: '10.200.200.106', cliReceivedPrefixes: 101n }),
    ]);
    const profile = result.profiles[0]!;
    expect(profile.prefixStatus).toBe('EXCEEDED');
    expect(profile.readiness).toBe('NOT_READY');
    expect(profile.blockedReason).toBe('PREFIX_LIMIT_EXCEEDED');
  });

  it('F) policy inexistente => NOT_READY', async () => {
    const harness = createHarness();
    const result = await discover(harness, [
      makePeer({ peerAddress: '10.200.200.99' }),
    ]);
    const profile = result.profiles[0]!;
    expect(profile.policyName).toBeNull();
    expect(profile.readiness).toBe('NOT_READY');
    expect(profile.blockedReason).toBe('POLICY_NOT_FOUND');
  });

  it('G) interface ambigua => continua bloqueado (nunca READY)', async () => {
    const harness = createHarness();
    const result = await discover(harness, [
      makePeer({
        peerAddress: '10.200.200.106',
        interfaceId: null,
        interfaceName: null,
        interfaceAlias: null,
        interfaceDescription: null,
        correlationStatus: 'AMBIGUOUS',
      }),
    ]);
    expect(result.ambiguousPeers).toEqual(['10.200.200.106']);
    expect(result.profiles.some((profile) => profile.readiness === 'READY')).toBe(false);
    expect(result.createdProfiles).toBe(0);
  });

  it('H) sem nodes seguros => NOT_READY/NO_SAFE_TEMPORARY_NODE', async () => {
    const harness = createHarness({ bgp: BGP_BUSY, routePolicy: RP_BUSY_IN });
    const result = await discover(harness, [makePeer({ peerAddress: '10.200.200.50' })]);
    const profile = result.profiles[0]!;
    expect(profile.readiness).toBe('NOT_READY');
    expect(profile.blockedReason).toBe('NO_SAFE_TEMPORARY_NODE');
  });

  it('peer nao correlacionado permanece bloqueado (nao confundir com DOWN)', async () => {
    const harness = createHarness();
    const result = await discover(harness, [
      makePeer({
        peerAddress: '10.200.200.106',
        interfaceId: null,
        correlationStatus: 'NO_ROUTE',
      }),
    ]);
    expect(result.createdProfiles).toBe(0);
    expect(result.profiles).toHaveLength(0);
  });
});
