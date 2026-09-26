import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { registerBgpRoutes } from './bgp-routes';
import type { AuthUser } from '@gmj/shared';
import { BgpAdminActionError } from './infrastructure/bgp/bgp-admin-service';
import { BgpAdvertisedRoutesError } from './infrastructure/bgp/bgp-advertised-routes-service';
import { DemoBgpRepository } from './infrastructure/bgp/demo-bgp-repository';
import type { HuaweiBgpCollection } from './infrastructure/bgp/huawei-bgp-snmp';

function collection(
  collectedAt: string,
  peers: Array<{ peerAddress: string; stateCode: number; receivedPrefixes: number | null }>,
): HuaweiBgpCollection {
  const states: Record<number, 'IDLE' | 'CONNECT' | 'ACTIVE' | 'OPENSENT' | 'OPENCONFIRM' | 'ESTABLISHED'> = {
    1: 'IDLE',
    2: 'CONNECT',
    3: 'ACTIVE',
    4: 'OPENSENT',
    5: 'OPENCONFIRM',
    6: 'ESTABLISHED',
  };
  return {
    collectedAt: new Date(collectedAt),
    errors: [],
    peers: peers.map((peer) => ({
      peerAddress: peer.peerAddress,
      stateCode: peer.stateCode,
      state: states[peer.stateCode] ?? 'UNKNOWN',
      established: peer.stateCode === 6,
      receivedPrefixes: peer.receivedPrefixes,
    })),
  };
}

async function buildBgpApp(): Promise<{ app: FastifyInstance; repo: DemoBgpRepository }> {
  const repo = new DemoBgpRepository();
  repo.setDevice({
    id: 'ne8000-1',
    hostname: 'NE8000-1',
    displayName: 'NE-8K POP CENTRO',
    bgpMonitoringEnabled: true,
  });
  repo.setDevice({
    id: 's6730-1',
    hostname: 'S6730-MPLS-01',
    displayName: 'S6730 MPLS',
    bgpMonitoringEnabled: false,
  });
  repo.setDevice({
    id: 'empty-1',
    hostname: 'EMPTY-01',
    displayName: 'EMPTY DEVICE',
    bgpMonitoringEnabled: true,
  });
  repo.setInterface({
    id: 'if-1',
    name: '100GE1/0/3',
    alias: 'TRANSITO XYZ',
    description: null,
    rxBps: 4_800_000_000,
    txBps: 2_100_000_000,
  });
  repo.setInterface({
    id: 'if-2',
    name: 'XGE0/0/1',
    alias: null,
    description: 'MPLS INTERNA',
    rxBps: null,
    txBps: null,
  });

  await repo.saveCollection('ne8000-1', collection('2026-09-19T12:00:00.000Z', [
    { peerAddress: '200.150.1.193', stateCode: 6, receivedPrefixes: 1_099_912 },
    { peerAddress: '187.16.216.253', stateCode: 6, receivedPrefixes: 211_752 },
  ]));
  await repo.saveCollection('s6730-1', collection('2026-09-19T12:00:00.000Z', [
    { peerAddress: '10.0.0.1', stateCode: 3, receivedPrefixes: null },
  ]));
  repo.setPeerOptions('ne8000-1', '200.150.1.193', { interfaceId: 'if-1', remoteAs: 12345n });
  repo.setPeerOptions('ne8000-1', '187.16.216.253', { interfaceId: null, remoteAs: 26162n });
  repo.setPeerOptions('s6730-1', '10.0.0.1', { interfaceId: 'if-2', remoteAs: null });

  const app = Fastify();
  registerBgpRoutes(app, { bgp: repo });
  await app.ready();
  return { app, repo };
}

describe('BGP REST API', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = (await buildBgpApp()).app;
  });

  afterEach(async () => {
    await app.close();
  });

  it('scope=monitored shows only devices with bgpMonitoringEnabled=true', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/bgp' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.devices.map((device: { id: string }) => device.id)).toEqual(['ne8000-1']);
    expect(body.summary).toEqual({
      peers: 2,
      established: 2,
      down: 0,
      receivedPrefixes: 1_311_664,
      byFamily: { IPV4: 2, IPV6: 0 },
    });
  });

  it('scope=all shows devices with peers even when the flag is false', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/bgp?scope=all' });
    const body = response.json();
    expect(body.devices.map((device: { id: string }) => device.id)).toEqual([
      'ne8000-1',
      's6730-1',
    ]);
    expect(body.summary).toMatchObject({ peers: 3, established: 2, down: 1 });
  });

  it('does not include a host without peers in scope=all', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/bgp?scope=all' });
    const body = response.json();
    expect(body.devices.some((device: { id: string }) => device.id === 'empty-1')).toBe(false);
  });

  it('does not sum receivedPrefixes for down peers or null prefixes', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/bgp?scope=all' });
    const body = response.json();
    expect(body.summary.receivedPrefixes).toBe(1_311_664);
  });

  it('serializes BigInt as JSON-safe strings/numbers', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/bgp' });
    const body = response.json();
    const peer = body.devices[0].peers.find(
      (item: { peerAddress: string }) => item.peerAddress === '200.150.1.193',
    );
    expect(peer.remoteAs).toBe('12345');
    expect(peer.receivedPrefixes).toBe(1_099_912);
    expect(typeof peer.receivedPrefixes).toBe('number');
  });

  it('returns interface RX/TX for the associated interface', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/bgp' });
    const body = response.json();
    const peer = body.devices[0].peers.find(
      (item: { peerAddress: string }) => item.peerAddress === '200.150.1.193',
    );
    expect(peer.interface).toEqual({
      id: 'if-1',
      name: '100GE1/0/3',
      alias: 'TRANSITO XYZ',
      description: null,
      rxBps: 4_800_000_000,
      txBps: 2_100_000_000,
    });
  });

  it('returns null interface for a peer without interfaceId', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/bgp' });
    const body = response.json();
    const peer = body.devices[0].peers.find(
      (item: { peerAddress: string }) => item.peerAddress === '187.16.216.253',
    );
    expect(peer.interface).toBeNull();
    expect(peer.displayName).toBe('187.16.216.253');
  });

  it('derives displayName from alias when present', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/bgp' });
    const body = response.json();
    const peer = body.devices[0].peers.find(
      (item: { peerAddress: string }) => item.peerAddress === '200.150.1.193',
    );
    expect(peer.displayName).toBe('TRANSITO XYZ');
  });

  it('derives displayName from description when alias is missing', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/bgp?scope=all' });
    const body = response.json();
    const device = body.devices.find((item: { id: string }) => item.id === 's6730-1');
    expect(device.peers[0].displayName).toBe('MPLS INTERNA');
  });

  it('filters by state', async () => {
    const down = await app.inject({ method: 'GET', url: '/api/bgp?scope=all&state=down' });
    expect(down.json().devices.map((device: { id: string }) => device.id)).toEqual(['s6730-1']);
    const up = await app.inject({ method: 'GET', url: '/api/bgp?scope=all&state=up' });
    expect(up.json().devices.map((device: { id: string }) => device.id)).toEqual(['ne8000-1']);
  });

  it('filters by deviceId', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/bgp?scope=all&deviceId=s6730-1' });
    const body = response.json();
    expect(body.devices.map((device: { id: string }) => device.id)).toEqual(['s6730-1']);
  });

  it('returns 404 for an unknown peer detail and history', async () => {
    const detail = await app.inject({ method: 'GET', url: '/api/bgp/peers/missing' });
    expect(detail.statusCode).toBe(404);
    const history = await app.inject({ method: 'GET', url: '/api/bgp/peers/missing/history' });
    expect(history.statusCode).toBe(404);
  });
});

describe('BGP manual discovery API', () => {
  it('discovers peers via SSH and serializes BigInt safely', async () => {
    const repo = new DemoBgpRepository();
    const hosts = {
      getHost: vi.fn().mockResolvedValue({
        id: 's6730-1',
        hostname: 'S6730-MPLS-01',
        sshEnabled: true,
        bgpMonitoringEnabled: false,
      }),
    };
    const discovery = {
      discover: vi.fn().mockResolvedValue({
        localAs: 268568n,
        localAsAmbiguous: false,
        ipv6Supported: true,
        warnings: [],
        peers: [
          {
            peerAddress: '200.150.1.193',
            addressFamily: 'IPV4',
            remoteAs: 12345n,
            stateCode: 6,
            state: 'ESTABLISHED',
            sessionUptimeSeconds: 3600,
            cliReceivedPrefixes: 100n,
            bgpPeerDescription: null,
            interfaceId: 'if-1',
            interfaceName: '100GE1/0/3',
            interfaceAlias: null,
            interfaceDescription: null,
            displayName: 'TRANSITO XYZ',
            correlationStatus: 'MATCHED',
            correlationError: null,
          },
          {
            peerAddress: '2001:db8::10',
            addressFamily: 'IPV6',
            remoteAs: 65001n,
            stateCode: 3,
            state: 'ACTIVE',
            sessionUptimeSeconds: null,
            cliReceivedPrefixes: null,
            bgpPeerDescription: 'CLIENTE IPV6',
            interfaceId: null,
            interfaceName: null,
            interfaceAlias: null,
            interfaceDescription: null,
            displayName: 'CLIENTE IPV6',
            correlationStatus: 'NO_ROUTE',
            correlationError: null,
          },
        ],
      }),
    };
    const app = Fastify();
    registerBgpRoutes(app, {
      bgp: repo,
      hosts: hosts as never,
      discovery: discovery as never,
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/hosts/s6730-1/bgp/discover',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      hostId: 's6730-1',
      peersDiscovered: 2,
      ipv4Peers: 1,
      ipv6Peers: 1,
      matchedInterfaces: 1,
      unmatchedInterfaces: 1,
      localAs: '268568',
      localAsAmbiguous: false,
      ipv6Supported: true,
    });
    expect(body.peers[0].remoteAs).toBe('12345');
    expect(body.peers[0].addressFamily).toBe('IPV4');
    expect(body.peers[0].correlationStatus).toBe('MATCHED');
    expect(body.peers[1].peerAddress).toBe('2001:db8::10');
    expect(body.peers[1].addressFamily).toBe('IPV6');
    expect(body.peers[1].bgpPeerDescription).toBe('CLIENTE IPV6');
    expect(body.peers[1].interfaceId).toBeNull();
    expect(discovery.discover).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's6730-1', bgpMonitoringEnabled: false }),
    );

    await app.close();
  });

  it('rejects discovery when SSH is not enabled', async () => {
    const repo = new DemoBgpRepository();
    const hosts = { getHost: vi.fn().mockResolvedValue({ id: 'ne8000-1', sshEnabled: false }) };
    const discovery = { discover: vi.fn() };
    const app = Fastify();
    registerBgpRoutes(app, {
      bgp: repo,
      hosts: hosts as never,
      discovery: discovery as never,
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/hosts/ne8000-1/bgp/discover',
    });
    expect(response.statusCode).toBe(409);
    expect(discovery.discover).not.toHaveBeenCalled();

    await app.close();
  });
});

describe('BGP alerts API', () => {
  it('returns active and resolved alerts respecting the monitored scope', async () => {
    const repo = new DemoBgpRepository();
    repo.setDevice({
      id: 'ne8000-1',
      hostname: 'NE8000-1',
      displayName: 'NE-8K POP CENTRO',
      bgpMonitoringEnabled: true,
    });
    repo.setDevice({
      id: 's6730-1',
      hostname: 'S6730-MPLS-01',
      displayName: 'S6730 MPLS',
      bgpMonitoringEnabled: false,
    });

    const now = Date.now();
    const t0 = new Date(now - 30 * 60_000);
    const t1 = new Date(now - 20 * 60_000);
    const t2 = new Date(now - 10 * 60_000);

    // Peer p1: ESTABLISHED -> ACTIVE (active alert on a monitored device).
    await repo.saveCollection('ne8000-1', collection(t0.toISOString(), [
      { peerAddress: '200.150.1.193', stateCode: 6, receivedPrefixes: 100 },
    ]));
    await repo.saveCollection('ne8000-1', collection(t1.toISOString(), [
      { peerAddress: '200.150.1.193', stateCode: 3, receivedPrefixes: null },
    ]));

    // Peer p2: down on a NON-monitored device (must be excluded).
    await repo.saveCollection('s6730-1', collection(t1.toISOString(), [
      { peerAddress: '10.0.0.1', stateCode: 3, receivedPrefixes: null },
    ]));

    // Peer p3: ESTABLISHED -> ACTIVE -> ESTABLISHED (resolved alert).
    await repo.saveCollection('ne8000-1', collection(t0.toISOString(), [
      { peerAddress: '187.16.216.253', stateCode: 6, receivedPrefixes: 200 },
    ]));
    await repo.saveCollection('ne8000-1', collection(t1.toISOString(), [
      { peerAddress: '187.16.216.253', stateCode: 3, receivedPrefixes: null },
    ]));
    await repo.saveCollection('ne8000-1', collection(t2.toISOString(), [
      { peerAddress: '187.16.216.253', stateCode: 6, receivedPrefixes: 201 },
    ]));

    const app = Fastify();
    registerBgpRoutes(app, { bgp: repo });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/bgp/alerts?hours=48&scope=monitored',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.active.map((item: { peerAddress: string }) => item.peerAddress)).toEqual([
      '200.150.1.193',
    ]);
    expect(body.active[0]).toMatchObject({
      currentState: 'ACTIVE',
      previousState: 'ESTABLISHED',
      deviceName: 'NE-8K POP CENTRO',
    });
    expect(body.resolved.map((item: { peerAddress: string }) => item.peerAddress)).toEqual([
      '187.16.216.253',
    ]);
    expect(body.resolved[0]).toMatchObject({
      previousState: 'ACTIVE',
      currentState: 'ESTABLISHED',
      durationSeconds: 600,
    });

    await app.close();
  });
});

describe('BGP peer history API', () => {
  it('returns samples ordered by timestamp and state change events', async () => {
    const repo = new DemoBgpRepository();
    repo.setDevice({ id: 'ne8000-1', hostname: 'NE8000-1', displayName: 'NE-8K POP CENTRO', bgpMonitoringEnabled: true });
    const now = Date.now();
    const earlier = new Date(now - 30 * 60_000);
    const later = new Date(now - 25 * 60_000);
    const down = new Date(now - 20 * 60_000);
    // Seed out of chronological order to prove the API sorts ascending.
    await repo.saveCollection('ne8000-1', collection(later.toISOString(), [
      { peerAddress: '200.150.1.193', stateCode: 6, receivedPrefixes: 1_099_912 },
    ]));
    await repo.saveCollection('ne8000-1', collection(earlier.toISOString(), [
      { peerAddress: '200.150.1.193', stateCode: 6, receivedPrefixes: 1_099_900 },
    ]));
    await repo.saveCollection('ne8000-1', collection(down.toISOString(), [
      { peerAddress: '200.150.1.193', stateCode: 3, receivedPrefixes: null },
    ]));
    const app = Fastify();
    registerBgpRoutes(app, { bgp: repo });
    await app.ready();

    const peerId = repo.getPeer('ne8000-1', '200.150.1.193')!.id;
    const response = await app.inject({
      method: 'GET',
      url: `/api/bgp/peers/${peerId}/history?period=1h`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.samples.map((sample: { timestamp: string }) => sample.timestamp)).toEqual([
      earlier.toISOString(),
      later.toISOString(),
      down.toISOString(),
    ]);
    expect(body.samples[2]).toMatchObject({ state: 'ACTIVE', established: false, receivedPrefixes: null });
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      previousState: 'ESTABLISHED',
      currentState: 'ACTIVE',
      previousStateCode: 6,
      currentStateCode: 3,
      occurredAt: down.toISOString(),
    });

    await app.close();
  });
});

describe('BGP dual-stack dashboard and alerts API', () => {
  async function dualStackApp(): Promise<{ app: FastifyInstance; repo: DemoBgpRepository }> {
    const repo = new DemoBgpRepository();
    repo.setDevice({
      id: 'ne8000-1',
      hostname: 'NE8000-1',
      displayName: 'NE-8K POP CENTRO',
      bgpMonitoringEnabled: true,
      bgpLocalAs: '268568',
    });
    await repo.saveCollection('ne8000-1', collection('2026-09-19T12:00:00.000Z', [
      { peerAddress: '200.150.1.193', stateCode: 6, receivedPrefixes: 1_099_912 },
    ]));
    await repo.saveDiscovery(
      'ne8000-1',
      [
        {
          peerAddress: '2001:db8::10',
          addressFamily: 'IPV6',
          remoteAs: 265424n,
          stateCode: 6,
          state: 'ESTABLISHED',
          sessionUptimeSeconds: 3600,
          cliReceivedPrefixes: 42n,
          bgpPeerDescription: 'CLIENTE IPV6',
          interfaceId: null,
          correlationStatus: 'NO_ROUTE',
        },
        {
          peerAddress: '2001:db8::20',
          addressFamily: 'IPV6',
          remoteAs: 65001n,
          stateCode: 3,
          state: 'ACTIVE',
          sessionUptimeSeconds: null,
          cliReceivedPrefixes: null,
          bgpPeerDescription: null,
          interfaceId: null,
          correlationStatus: 'NO_ROUTE',
        },
      ],
      new Date('2026-09-19T12:05:00.000Z'),
    );
    const app = Fastify();
    registerBgpRoutes(app, { bgp: repo });
    await app.ready();
    return { app, repo };
  }

  it('shows IPv4 and IPv6 peers together with their family', async () => {
    const { app } = await dualStackApp();
    const response = await app.inject({ method: 'GET', url: '/api/bgp?scope=all' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const peers = body.devices[0].peers;
    expect(
      Object.fromEntries(
        peers.map((peer: { peerAddress: string; addressFamily: string }) => [
          peer.peerAddress,
          peer.addressFamily,
        ]),
      ),
    ).toEqual({
      '200.150.1.193': 'IPV4',
      '2001:db8::10': 'IPV6',
      '2001:db8::20': 'IPV6',
    });
    const ipv6Established = peers.find(
      (peer: { peerAddress: string }) => peer.peerAddress === '2001:db8::10',
    );
    expect(ipv6Established).toMatchObject({
      displayName: 'CLIENTE IPV6',
      remoteAs: '265424',
      receivedPrefixes: 42,
      localAs: '268568',
      adminState: 'UNKNOWN',
    });
    expect(body.summary).toMatchObject({
      peers: 3,
      established: 2,
      down: 1,
      byFamily: { IPV4: 1, IPV6: 2 },
    });
    await app.close();
  });

  it('filters by family=IPV4 and family=IPV6', async () => {
    const { app } = await dualStackApp();
    const ipv6 = await app.inject({ method: 'GET', url: '/api/bgp?scope=all&family=IPV6' });
    expect(
      ipv6.json().devices[0].peers.map((peer: { peerAddress: string }) => peer.peerAddress),
    ).toEqual(['2001:db8::10', '2001:db8::20']);

    const ipv4 = await app.inject({ method: 'GET', url: '/api/bgp?scope=all&family=IPV4' });
    expect(
      ipv4.json().devices[0].peers.map((peer: { peerAddress: string }) => peer.peerAddress),
    ).toEqual(['200.150.1.193']);
    expect(ipv4.json().summary.byFamily).toEqual({ IPV4: 1, IPV6: 0 });
    await app.close();
  });

  it('reports the family on active and resolved alerts', async () => {
    const { app } = await dualStackApp();
    const response = await app.inject({ method: 'GET', url: '/api/bgp/alerts?hours=48' });
    const body = response.json();
    expect(body.active.map((alert: { peerAddress: string }) => alert.peerAddress)).toEqual([
      '2001:db8::20',
    ]);
    expect(body.active[0]).toMatchObject({ addressFamily: 'IPV6', currentState: 'ACTIVE' });
    expect(body.resolved).toEqual([]);
    await app.close();
  });
});

describe('BGP administrative action API', () => {
  function adminApp(options: {
    user?: AuthUser | null;
    execute?: ReturnType<typeof vi.fn>;
  }): { app: FastifyInstance; execute: ReturnType<typeof vi.fn> } {
    const execute =
      options.execute ??
      vi.fn().mockResolvedValue({
        peerId: 'peer-1',
        deviceId: 'ne8000-1',
        peerAddress: '10.200.200.10',
        addressFamily: 'IPV4',
        action: 'DISABLE',
        success: true,
        adminState: 'IGNORED',
        verified: true,
        message: 'Sessão BGP desabilitada e confirmada por read-back (ADMIN: IGNORADO).',
        executedAt: '2026-09-21T10:00:00.000Z',
      });
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) return reply.code(400).send({ message: 'Invalid request' });
      return reply.code(500).send({ message: 'Internal server error' });
    });
    registerBgpRoutes(app, {
      bgp: new DemoBgpRepository(),
      admin: { execute } as never,
      currentUser: async () => options.user ?? null,
    });
    return { app, execute };
  }

  const adminUser: AuthUser = {
    id: 'user-1',
    username: 'admin',
    email: 'admin@netvision.local',
    name: 'Administrador',
    role: 'ADMIN',
  };
  const operatorUser: AuthUser = { ...adminUser, id: 'user-2', username: 'operador', role: 'OPERATOR' };
  const viewerUser: AuthUser = { ...adminUser, id: 'user-3', username: 'viewer', role: 'VIEWER' };

  it('executes a confirmed disable for an authenticated ADMIN', async () => {
    const { app, execute } = adminApp({ user: adminUser });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/bgp/peers/peer-1/admin-state',
      payload: { action: 'DISABLE' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true, adminState: 'IGNORED' });
    expect(execute).toHaveBeenCalledWith({
      peerId: 'peer-1',
      action: 'DISABLE',
      user: adminUser,
    });
    await app.close();
  });

  it('executes an enable action', async () => {
    const { app, execute } = adminApp({
      user: adminUser,
      execute: vi.fn().mockResolvedValue({
        peerId: 'peer-1',
        deviceId: 'ne8000-1',
        peerAddress: '10.200.200.10',
        addressFamily: 'IPV4',
        action: 'ENABLE',
        success: true,
        adminState: 'ENABLED',
        verified: true,
        message: 'ok',
        executedAt: '2026-09-21T10:00:00.000Z',
      }),
    });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/bgp/peers/peer-1/admin-state',
      payload: { action: 'ENABLE' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ action: 'ENABLE', adminState: 'ENABLED' });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ action: 'ENABLE' }));
    await app.close();
  });

  it('rejects a VIEWER or OPERATOR without calling the service', async () => {
    for (const user of [viewerUser, operatorUser]) {
      const { app, execute } = adminApp({ user });
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/api/bgp/peers/peer-1/admin-state',
        payload: { action: 'DISABLE' },
      });
      expect(response.statusCode).toBe(403);
      expect(execute).not.toHaveBeenCalled();
      await app.close();
    }
  });

  it('rejects an unauthenticated request', async () => {
    const { app, execute } = adminApp({ user: null });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/bgp/peers/peer-1/admin-state',
      payload: { action: 'DISABLE' },
    });
    expect(response.statusCode).toBe(401);
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects extra fields such as a raw CLI command or a forged local ASN', async () => {
    const { app, execute } = adminApp({ user: adminUser });
    await app.ready();
    for (const payload of [
      { action: 'DISABLE', command: 'shutdown' },
      { action: 'DISABLE', localAs: 999 },
      { action: 'DISABLE', peerAddress: '10.0.0.1' },
      { action: 'RELOAD' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/bgp/peers/peer-1/admin-state',
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });

  it('maps domain failures to their HTTP status without leaking internals', async () => {
    const { app } = adminApp({
      user: adminUser,
      execute: vi
        .fn()
        .mockRejectedValue(
          new BgpAdminActionError(
            'ASN local do processo BGP ainda não foi identificado. Execute "Atualizar agora" para fazer o discovery SSH.',
            409,
          ),
        ),
    });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/bgp/peers/peer-1/admin-state',
      payload: { action: 'DISABLE' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain('discovery SSH');
    expect(response.json().message).not.toMatch(/password|community/i);
    await app.close();
  });
});

describe('BGP advertised-routes API', () => {
  const sampleResponse = {
    peerId: 'peer-1',
    deviceId: 'ne8000-1',
    peerAddress: '200.194.223.86',
    addressFamily: 'IPV4',
    localAs: '268568',
    fetchedAt: '2026-09-25T12:00:00.000Z',
    routes: [
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
    ],
    reportedTotal: 1,
    warnings: [],
  };

  function advertisedApp(options: {
    user?: AuthUser | null;
    execute?: ReturnType<typeof vi.fn>;
  }): { app: FastifyInstance; execute: ReturnType<typeof vi.fn> } {
    const execute = options.execute ?? vi.fn().mockResolvedValue(sampleResponse);
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) return reply.code(400).send({ message: 'Invalid request' });
      return reply.code(500).send({ message: 'Internal server error' });
    });
    registerBgpRoutes(app, {
      bgp: new DemoBgpRepository(),
      advertisedRoutes: { execute } as never,
      currentUser: async () => options.user ?? null,
    });
    return { app, execute };
  }

  const operatorUser: AuthUser = {
    id: 'user-2',
    username: 'operador',
    email: 'operador@netvision.local',
    name: 'Operador',
    role: 'OPERATOR',
  };
  const viewerUser: AuthUser = { ...operatorUser, id: 'user-3', username: 'viewer', role: 'VIEWER' };

  it('lets any authenticated operator collect the announced routes', async () => {
    for (const user of [operatorUser, viewerUser]) {
      const { app, execute } = advertisedApp({ user });
      await app.ready();
      const response = await app.inject({
        method: 'POST',
        url: '/api/bgp/peers/peer-1/advertised-routes',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ peerAddress: '200.194.223.86', localAs: '268568' });
      expect(response.json().routes[0]).toMatchObject({ prefix: '45.163.144.0/22', prependLocal: 2 });
      expect(execute).toHaveBeenCalledWith('peer-1');
      await app.close();
    }
  });

  it('rejects an unauthenticated request without touching the device', async () => {
    const { app, execute } = advertisedApp({ user: null });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/bgp/peers/peer-1/advertised-routes',
    });
    expect(response.statusCode).toBe(401);
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects any body, so no peer address or CLI fragment can be injected', async () => {
    const { app, execute } = advertisedApp({ user: operatorUser });
    await app.ready();
    for (const payload of [
      { peerAddress: '10.0.0.1' },
      { command: 'display bgp peer' },
      { localAs: 999 },
      { addressFamily: 'IPV6' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/bgp/peers/peer-1/advertised-routes',
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().message).toMatch(/peerId persistido|Corpo da requisição inválido/);
    }
    expect(execute).not.toHaveBeenCalled();
    await app.close();
  });

  it('maps domain failures to their HTTP status without leaking internals', async () => {
    const { app } = advertisedApp({
      user: operatorUser,
      execute: vi
        .fn()
        .mockRejectedValue(
          new BgpAdvertisedRoutesError(
            'Consulta de anúncios não suportada para sessões IPv6 neste equipamento (O equipamento não reconheceu o comando de anúncios nesta família.)',
            409,
          ),
        ),
    });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/bgp/peers/peer-1/advertised-routes',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toMatch(/não suportada para sessões IPv6/);
    expect(response.json().message).not.toMatch(/password|community|private/i);
    await app.close();
  });

  it('returns 502 for an SSH failure, with the sanitized message only', async () => {
    const { app } = advertisedApp({
      user: operatorUser,
      execute: vi
        .fn()
        .mockRejectedValue(new BgpAdvertisedRoutesError('SSH host is unreachable', 502)),
    });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/bgp/peers/peer-1/advertised-routes',
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().message).toBe('SSH host is unreachable');
    await app.close();
  });
});
