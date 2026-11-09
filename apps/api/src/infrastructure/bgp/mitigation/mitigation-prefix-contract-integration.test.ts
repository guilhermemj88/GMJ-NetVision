/**
 * ESCOPO VERIFICADO — contrato REAL de notificacao (integracao).
 *
 * Prova, pelo caminho canonico (`MitigationCommandService`), que:
 *  - a lista de prefixos so aparece em `MITIGATION_VERIFIED` de escrita REAL;
 *  - leitor ausente, excecao, leitura parcial ou escopo divergente NAO derrubam
 *    o comando e NAO inventam prefixo (ficam `fieldsUnavailable`);
 *  - caminho MOCK/simulado, ativacao nao verificada e REMOVE nunca leem o escopo;
 *  - `eventId` continua sendo o `requestId` e o payload transporta a lista.
 */
import { describe, expect, it } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { InMemoryMitigationRepository } from './in-memory-mitigation-repository';
import {
  MitigationCommandService,
  type MitigationLiveExecutorPort,
} from './mitigation-command-service';
import { MockMitigationExecutor } from './mitigation-executor';
import {
  buildMitigationActivateCommands,
  buildMitigationRemovalCommands,
} from './mitigation-write-guard';
import { testMitigationContract, testPreservedClauses } from './mitigation-test-support';
import { DEFAULT_BOGON_PREFIX_LIST, DEFAULT_TARGET_PREFIX_LIST } from './mitigation-planner';
import type {
  MitigationPreflightInput,
  MitigationPreflightResult,
} from './huawei-mitigation-executor';
import type { MitigationActivationInput, MitigationRemovalInput } from './mitigation-executor';
import type { MitigationNotification } from './notification-publisher';
import { buildMitigationWebhookPayload } from './mitigation-webhook';
import type {
  MitigationScopePrefixEvidence,
  MitigationScopePrefixQuery,
} from './mitigation-scope-prefixes';

const DEVICE_ID = 'host-f1a';
const POLICY = 'PL-ESCOPO_IPv4-IN';
const RT = '268568:660';
const PEER = '10.200.201.2';
const FIXED_NOW = new Date('2026-10-30T22:48:41.614Z');
const PREFIXES = ['167.250.126.0/23', '167.250.126.0/24', '167.250.127.0/24'];

function device(): HostRecord {
  return {
    id: DEVICE_ID,
    hostname: 'BHE-VTA-F1A-BGP-01',
    displayName: 'BHE-VTA-F1A-BGP-01',
    name: 'BHE-VTA-F1A-BGP-01',
    sshEnabled: true,
    ssh: { host: '10.200.1.1', port: 22, username: 'netvision' },
  } as unknown as HostRecord;
}

const GOOD_READBACK = [
  `route-policy ${POLICY} deny node 1`,
  ' if-match ip-prefix BOGONS',
  `route-policy ${POLICY} permit node 2`,
  ` if-match ip-prefix PREFIX8to24`,
  ` apply local-preference 1100`,
  ` apply extcommunity rt ${RT}`,
  `route-policy ${POLICY} permit node 11`,
].join('\n');

const NORMAL_READBACK = [`route-policy ${POLICY} permit node 11`].join('\n');

/** Saida real de `display bgp routing-table peer <peer> received`. */
function receivedRoutes(prefixes: readonly string[] = PREFIXES, total?: number): string {
  return [
    ' BGP Local router ID is 45.163.144.1',
    ' Status codes: * - valid, > - best, d - damped, x - best external, a - add path,',
    '               h - history,  i - internal, s - suppressed, S - Stale',
    '               Origin : i - IGP, e - EGP, ? - incomplete',
    ' RPKI validation codes: V - valid, I - invalid, N - not-found',
    '',
    ` Total Number of Routes: ${total ?? prefixes.length}`,
    '        Network            NextHop                       MED        LocPrf    PrefVal Path/Ogn',
    '',
    ...prefixes.map(
      (prefix) => ` *>     ${prefix}   ${PEER}       0          1100       0      273811 273811i`,
    ),
    '<BHE-VTA-F1A-BGP-01>',
  ].join('\n');
}

function preflightResult(over: Partial<MitigationPreflightResult> = {}): MitigationPreflightResult {
  return {
    ok: true,
    mode: 'ACTIVATE',
    deviceId: DEVICE_ID,
    deviceName: 'BHE-VTA-F1A-BGP-01',
    deviceHost: '10.200.1.1',
    policyName: POLICY,
    existingNodes: [11, 50],
    bogonNode: 1,
    mitigationNode: 2,
    bogonPrefixList: DEFAULT_BOGON_PREFIX_LIST,
    bogonPrefixListExists: true,
    targetPrefixList: DEFAULT_TARGET_PREFIX_LIST,
    targetPrefixListExists: true,
    rt: RT,
    sshReadBackOk: true,
    bogonNodeExists: false,
    bogonNodeMatches: false,
    mitigationNodeExists: false,
    mitigationNodeMatches: false,
    partial: false,
    readBackNodes: [11, 50],
    readBackSummary: 'par ausente (policy normal)',
    readBackExcerpt: `route-policy ${POLICY} permit node 11`,
    checks: [],
    blockedReasons: [],
    ...over,
  };
}

class FakeLiveExecutor implements MitigationLiveExecutorPort {
  removed = false;
  preflightValue: MitigationPreflightResult = preflightResult();
  readBacks: string[] = [GOOD_READBACK, NORMAL_READBACK];

  enabledFor(): boolean {
    return true;
  }

  async resolveActivePair(): Promise<{ bogonNode: number; mitigationNode: number } | null> {
    return this.removed ? null : { bogonNode: 1, mitigationNode: 2 };
  }

  async preflight(_device: HostRecord, input: MitigationPreflightInput) {
    return {
      ...this.preflightValue,
      mode: input.mode,
      preservedClauses: testPreservedClauses(input.policyName, input.targetPrefixList, input.rt),
      mitigationContract: testMitigationContract(input.policyName, input.targetPrefixList),
    };
  }

  async activate(
    _device: HostRecord,
    input: MitigationActivationInput,
  ): Promise<{ output: string }> {
    buildMitigationActivateCommands(input, input.mitigationContract);
    return { output: 'ok' };
  }

  async remove(_device: HostRecord, input: MitigationRemovalInput): Promise<{ output: string }> {
    buildMitigationRemovalCommands(input);
    this.removed = true;
    return { output: 'ok' };
  }

  async readRoutePolicy(): Promise<string> {
    return this.readBacks.shift() ?? '';
  }
}

type Reader = (query: MitigationScopePrefixQuery) => Promise<MitigationScopePrefixEvidence | null>;

async function harness(
  options: {
    live?: boolean;
    /** Sobrescreve os read-backs do equipamento falso. */
    readBacks?: string[];
    /** Leitor de escopo: `undefined` = nao configurado. */
    reader?: Reader;
  } = {},
) {
  const repository = new InMemoryMitigationRepository();
  const mock = new MockMitigationExecutor();
  mock.seedPolicy(POLICY, [11]);
  const profile = await repository.upsertProfile({
    deviceId: DEVICE_ID,
    policyName: POLICY,
    interfaceId: 'if-3058',
    addressFamily: 'IPV4',
    detectedBandwidthBps: 10_000_000_000n,
    bandwidthSource: 'DESCRIPTION',
    prefixLimit: 100,
  });
  await repository.replaceProfilePeers(profile.id, [{ peerAddress: PEER, primary: true }]);
  await repository.upsertRuntime(profile.id, {
    state: 'NORMAL',
    plannedBogonNode: 1,
    plannedMitigationNode: 2,
    plannedNode: 2,
  });

  const live = new FakeLiveExecutor();
  if (options.readBacks) live.readBacks = [...options.readBacks];

  const published: MitigationNotification[] = [];
  const readerCalls: MitigationScopePrefixQuery[] = [];
  const reader =
    options.reader === undefined
      ? undefined
      : async (query: MitigationScopePrefixQuery) => {
          readerCalls.push(query);
          return options.reader!(query);
        };

  const commands = new MitigationCommandService({
    repository,
    hosts: { getHost: async () => device() },
    executor: mock,
    ...(options.live ? { live } : {}),
    notifications: {
      publish: async (notification) => {
        published.push(notification);
        return { published: true, skipped: false };
      },
    },
    ...(reader ? { scopePrefixes: reader, scopePrefixesLocalAs: async () => 268568n } : {}),
    expectedNodes: async () => [11, 50],
    now: () => FIXED_NOW,
  });
  return { repository, mock, commands, published, readerCalls, profileId: profile.id };
}

const scopedReader =
  (over: Partial<MitigationScopePrefixEvidence> = {}): Reader =>
  async (query) => ({
    profileId: query.profileId,
    policy: POLICY,
    peer: PEER,
    receivedRoutes: receivedRoutes(),
    ...over,
  });

describe('escopo verificado no evento MITIGATION_VERIFIED (caminho real)', () => {
  it('anexa os tres prefixos reais e mantem eventId/verified intactos', async () => {
    const h = await harness({ live: true, reader: scopedReader() });
    const result = await h.commands.execute({
      requestId: 'req-prefix-1',
      action: 'ACTIVATE',
      profileId: h.profileId,
    });
    expect(result.status).toBe('ACTIVATED_VERIFIED');
    expect(h.readerCalls).toHaveLength(1);
    expect(h.readerCalls[0]).toMatchObject({
      profileId: h.profileId,
      deviceId: DEVICE_ID,
      policyName: POLICY,
      peerAddress: PEER,
      addressFamily: 'IPV4',
    });
    const event = h.published.at(-1)!;
    expect(event.event).toBe('MITIGATION_VERIFIED');
    expect(event.eventId).toBe('req-prefix-1');
    expect(event.verified).toBe(true);
    expect(event.simulation).toBe(false);
    expect(event.prefixes).toEqual(PREFIXES);
    expect(event.fieldsUnavailable).toEqual([]);
    expect(buildMitigationWebhookPayload(event).prefixes).toEqual(PREFIXES);
  });

  it('sem leitor configurado o comando continua verificado e o campo fica indisponivel', async () => {
    const h = await harness({ live: true });
    const result = await h.commands.execute({
      requestId: 'req-prefix-2',
      action: 'ACTIVATE',
      profileId: h.profileId,
    });
    expect(result.status).toBe('ACTIVATED_VERIFIED');
    const event = h.published.at(-1)!;
    expect(event.verified).toBe(true);
    expect(event.prefixes).toBeNull();
    expect(event.fieldsUnavailable).toEqual(['prefixes']);
  });

  it('excecao no leitor nunca derruba nem "promove" o comando', async () => {
    const h = await harness({
      live: true,
      reader: async () => {
        throw new Error('SSH indisponivel no momento da leitura');
      },
    });
    const result = await h.commands.execute({
      requestId: 'req-prefix-3',
      action: 'ACTIVATE',
      profileId: h.profileId,
    });
    expect(result.status).toBe('ACTIVATED_VERIFIED');
    expect(result.verified).toBe(true);
    const event = h.published.at(-1)!;
    expect(event.verified).toBe(true);
    expect(event.prefixes).toBeNull();
    expect(event.fieldsUnavailable).toEqual(['prefixes']);
  });

  it('leitor que devolve null => campo indisponivel (nunca lista inventada)', async () => {
    const h = await harness({ live: true, reader: async () => null });
    await h.commands.execute({
      requestId: 'req-prefix-null',
      action: 'ACTIVATE',
      profileId: h.profileId,
    });
    const event = h.published.at(-1)!;
    expect(event.prefixes).toBeNull();
    expect(event.fieldsUnavailable).toEqual(['prefixes']);
  });

  it('evidencia de outro peer e descartada', async () => {
    const h = await harness({ live: true, reader: scopedReader({ peer: '10.200.201.99' }) });
    await h.commands.execute({
      requestId: 'req-prefix-4',
      action: 'ACTIVATE',
      profileId: h.profileId,
    });
    const event = h.published.at(-1)!;
    expect(event.prefixes).toBeNull();
    expect(event.fieldsUnavailable).toEqual(['prefixes']);
  });

  it('evidencia de outro perfil e descartada', async () => {
    const h = await harness({ live: true, reader: scopedReader({ profileId: 'outro-perfil' }) });
    await h.commands.execute({
      requestId: 'req-prefix-outro',
      action: 'ACTIVATE',
      profileId: h.profileId,
    });
    expect(h.published.at(-1)!.prefixes).toBeNull();
  });

  it('leitura parcial vira null, nunca lista parcial', async () => {
    const h = await harness({
      live: true,
      reader: scopedReader({ receivedRoutes: receivedRoutes(PREFIXES.slice(0, 1), 3) }),
    });
    await h.commands.execute({
      requestId: 'req-prefix-5',
      action: 'ACTIVATE',
      profileId: h.profileId,
    });
    expect(h.published.at(-1)!.prefixes).toBeNull();
  });
});

describe('escopo verificado nao vaza para caminhos que nao o comportam', () => {
  it('executor MOCK (simulacao) nao le o escopo nem carrega prefixos', async () => {
    const h = await harness({ live: false, reader: scopedReader() });
    const result = await h.commands.execute({
      requestId: 'req-mock-1',
      action: 'ACTIVATE',
      profileId: h.profileId,
    });
    expect(result.status).toBe('ACTIVATED_VERIFIED');
    expect(h.readerCalls).toHaveLength(0);
    const event = h.published.at(-1)!;
    expect(event.simulation).toBe(true);
    expect(event.prefixes).toBeUndefined();
  });

  it('ativacao NAO verificada nao le o escopo e nao carrega prefixos', async () => {
    const h = await harness({
      live: true,
      readBacks: [NORMAL_READBACK],
      reader: scopedReader(),
    });
    const result = await h.commands.execute({
      requestId: 'req-fail-1',
      action: 'ACTIVATE',
      profileId: h.profileId,
    });
    expect(result.status).toBe('REVALIDATION_FAILED');
    expect(result.verified).toBe(false);
    expect(h.readerCalls).toHaveLength(0);
    const event = h.published.at(-1)!;
    expect(event.event).toBe('MITIGATION_FAILED');
    expect(event.prefixes).toBeUndefined();
  });

  it('REMOVE verificado nao le o escopo nem carrega prefixos', async () => {
    const h = await harness({ live: true, readBacks: [NORMAL_READBACK], reader: scopedReader() });
    const result = await h.commands.execute({
      requestId: 'req-remove-1',
      action: 'REMOVE',
      profileId: h.profileId,
    });
    expect(result.status).toBe('REMOVED_VERIFIED');
    expect(h.readerCalls).toHaveLength(0);
    const event = h.published.at(-1)!;
    expect(event.event).toBe('MITIGATION_REMOVED_VERIFIED');
    expect(event.prefixes).toBeUndefined();
  });
});
