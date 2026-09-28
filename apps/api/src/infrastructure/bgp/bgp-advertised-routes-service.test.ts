import { describe, expect, it, vi } from 'vitest';
import type { BgpDashboardPeer, HostRecord } from '@gmj/shared';
import { makeHost } from '../../test-fixtures';
import type { BgpRepository } from './bgp-repository';
import type { HostRepository } from '../persistence/host-repository';
import type { HuaweiBgpSshService } from './huawei-bgp-ssh';
import {
  BgpAdvertisedRoutesError,
  BgpAdvertisedRoutesService,
} from './bgp-advertised-routes-service';

const ADVERTISED_OUTPUT = `
 Total routes of this peer : 3
 BGP routing table entry information of 45.163.144.0/22:
 From: 200.194.223.86 (10.200.201.18)
 Original nexthop: 200.194.223.86
 AS-path 268568 268568 268568, origin igp, MED 1, pref-val 0, valid, external

 BGP routing table entry information of 45.163.145.0/24:
 Original nexthop: 200.194.223.86
 AS-path 268568 268568, origin igp, MED 100, localpref 100, pref-val 0

 BGP routing table entry information of 45.5.248.0/23:
 Original nexthop: 200.194.223.86
 AS-path 268568 271034, origin igp, pref-val 0
`;

function peer(overrides: Partial<BgpDashboardPeer> = {}): BgpDashboardPeer {
  return {
    id: 'peer-1',
    deviceId: 'ne8000-1',
    deviceHostname: 'NE-8000-1',
    deviceDisplayName: 'NE-8K POP CENTRO',
    bgpMonitoringEnabled: true,
    peerAddress: '200.194.223.86',
    displayName: 'INFINIT_PROVEDOR',
    addressFamily: 'IPV4',
    localAs: '268568',
    remoteAs: '28572',
    role: 'UPSTREAM',
    monitoringEnabled: true,
    stateCode: 6,
    state: 'ESTABLISHED',
    established: true,
    adminState: 'ENABLED',
    adminStateCheckedAt: '2026-09-25T10:00:00.000Z',
    receivedPrefixes: 1,
    establishedSince: '2026-09-01T00:00:00.000Z',
    lastPollingAt: '2026-09-25T11:00:00.000Z',
    lastDiscoveryAt: '2026-09-25T10:00:00.000Z',
    interface: null,
    ...overrides,
  };
}

function host(overrides: Partial<HostRecord> = {}): HostRecord {
  return makeHost({
    id: 'ne8000-1',
    hostname: 'NE-8000-1',
    sshEnabled: true,
    ssh: {
      host: '172.16.0.1',
      port: 22,
      username: 'operator',
      credentialConfigured: true,
      authenticationType: 'PASSWORD',
    },
    ...overrides,
  });
}

function build(options: {
  peer?: BgpDashboardPeer | null;
  host?: HostRecord | null;
  localAs?: bigint | null;
  reading?: unknown;
} = {}) {
  const writes = {
    saveCollection: vi.fn(),
    saveDiscovery: vi.fn(),
    saveDeviceLocalAs: vi.fn(),
    setPeerAdminState: vi.fn(),
  };
  const bgp = {
    getPeerDetail: vi.fn().mockResolvedValue(
      options.peer === undefined ? peer() : options.peer,
    ),
    getDeviceLocalAs: vi.fn().mockResolvedValue(
      options.localAs === undefined ? 268568n : options.localAs,
    ),
    ...writes,
  } as unknown as BgpRepository;
  const hosts = {
    getHost: vi.fn().mockResolvedValue(options.host === undefined ? host() : options.host),
  } as unknown as HostRepository;
  const readAdvertisedRoutes = vi.fn().mockResolvedValue(
    options.reading === undefined ? { status: 'SUCCESS', output: ADVERTISED_OUTPUT } : options.reading,
  );
  const ssh = { readAdvertisedRoutes } as unknown as HuaweiBgpSshService;
  const service = new BgpAdvertisedRoutesService({
    bgp,
    hosts,
    ssh,
    now: () => new Date('2026-09-25T12:34:56.000Z'),
  });
  return { service, bgp, hosts, ssh, readAdvertisedRoutes, writes };
}

async function expectError(promise: Promise<unknown>): Promise<BgpAdvertisedRoutesError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BgpAdvertisedRoutesError);
    return error as BgpAdvertisedRoutesError;
  }
  throw new Error('Esperava um BgpAdvertisedRoutesError');
}

describe('BgpAdvertisedRoutesService', () => {
  it('returns the parsed routes with the local ASN, prepend and warnings', async () => {
    const { service, readAdvertisedRoutes } = build();

    const result = await service.execute('peer-1');

    expect(result).toMatchObject({
      peerId: 'peer-1',
      deviceId: 'ne8000-1',
      peerAddress: '200.194.223.86',
      addressFamily: 'IPV4',
      localAs: '268568',
      fetchedAt: '2026-09-25T12:34:56.000Z',
      reportedTotal: 3,
      warnings: [],
    });
    expect(result.routes).toEqual([
      {
        prefix: '45.163.144.0/22',
        nextHop: '200.194.223.86',
        med: 1,
        localPreference: null,
        preferredValue: 0,
        asPath: ['268568', '268568', '268568'],
        origin: 'i',
        prependLocal: 2,
      },
      {
        prefix: '45.163.145.0/24',
        nextHop: '200.194.223.86',
        med: 100,
        localPreference: 100,
        preferredValue: 0,
        asPath: ['268568', '268568'],
        origin: 'i',
        prependLocal: 1,
      },
      {
        prefix: '45.5.248.0/23',
        nextHop: '200.194.223.86',
        med: null,
        localPreference: null,
        preferredValue: 0,
        asPath: ['268568', '271034'],
        origin: 'i',
        prependLocal: 0,
      },
    ]);
    // Peer address and family come from the persisted peer, never from input.
    expect(readAdvertisedRoutes).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ne8000-1' }),
      { peerAddress: '200.194.223.86', addressFamily: 'IPV4' },
    );
  });

  it('returns an empty route list without warnings when the CLI reports none', async () => {
    const { service } = build({
      reading: { status: 'SUCCESS', output: ' Total routes of this peer : 0\n' },
    });

    const result = await service.execute('peer-1');

    expect(result.routes).toEqual([]);
    expect(result.reportedTotal).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it('persists nothing', async () => {
    const { service, writes } = build();

    await service.execute('peer-1');

    for (const write of Object.values(writes)) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('answers 404 when the peer does not exist', async () => {
    const { service, readAdvertisedRoutes } = build({ peer: null });

    const error = await expectError(service.execute('missing'));

    expect(error.statusCode).toBe(404);
    expect(error.message).toBe('Peer BGP não encontrado');
    expect(readAdvertisedRoutes).not.toHaveBeenCalled();
  });

  it('answers 404 when the device is missing', async () => {
    const { service, readAdvertisedRoutes } = build({ host: null });

    const error = await expectError(service.execute('peer-1'));

    expect(error.statusCode).toBe(404);
    expect(error.message).toBe('Equipamento não encontrado');
    expect(readAdvertisedRoutes).not.toHaveBeenCalled();
  });

  it('answers 409 when the persisted address does not match the family', async () => {
    const { service, readAdvertisedRoutes } = build({
      peer: peer({ peerAddress: '2001:db8::10', addressFamily: 'IPV4' }),
    });

    const error = await expectError(service.execute('peer-1'));

    expect(error.statusCode).toBe(409);
    expect(error.message).toMatch(/Endereço do peer é inválido/);
    expect(readAdvertisedRoutes).not.toHaveBeenCalled();
  });

  it('answers 409 when SSH is not enabled for the device', async () => {
    const { service, readAdvertisedRoutes } = build({ host: host({ sshEnabled: false }) });

    const error = await expectError(service.execute('peer-1'));

    expect(error.statusCode).toBe(409);
    expect(error.message).toBe('SSH não está habilitado para este equipamento');
    expect(readAdvertisedRoutes).not.toHaveBeenCalled();
  });

  it('answers 409 when the local ASN is still unknown', async () => {
    const { service, readAdvertisedRoutes } = build({ localAs: null });

    const error = await expectError(service.execute('peer-1'));

    expect(error.statusCode).toBe(409);
    expect(error.message).toMatch(/ASN local do processo BGP ainda não foi identificado/);
    expect(readAdvertisedRoutes).not.toHaveBeenCalled();
  });

  it('answers 502 with the sanitized SSH failure', async () => {
    const { service } = build({
      reading: { status: 'COMMAND_FAILED', errorSafe: 'SSH host is unreachable' },
    });

    const error = await expectError(service.execute('peer-1'));

    expect(error.statusCode).toBe(502);
    expect(error.message).toBe('SSH host is unreachable');
  });

  it('answers 409 explicitly when the platform does not support the variant', async () => {
    const { service } = build({
      peer: peer({ peerAddress: '2001:db8::10', addressFamily: 'IPV6', localAs: '268568' }),
      reading: {
        status: 'UNSUPPORTED',
        errorSafe: 'O equipamento não reconheceu o comando de anúncios nesta família.',
      },
    });

    const error = await expectError(service.execute('peer-1'));

    expect(error.statusCode).toBe(409);
    expect(error.message).toMatch(/não suportada para sessões IPv6/);
  });
});
