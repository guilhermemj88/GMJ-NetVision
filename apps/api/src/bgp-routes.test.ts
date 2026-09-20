import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerBgpRoutes } from './bgp-routes';
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
      discover: vi.fn().mockResolvedValue([
        {
          peerAddress: '200.150.1.193',
          remoteAs: 12345n,
          stateCode: 6,
          state: 'ESTABLISHED',
          sessionUptimeSeconds: 3600,
          interfaceId: 'if-1',
          interfaceName: '100GE1/0/3',
          interfaceAlias: null,
          interfaceDescription: null,
          displayName: 'TRANSITO XYZ',
          correlationStatus: 'MATCHED',
          correlationError: null,
        },
        {
          peerAddress: '10.0.0.2',
          remoteAs: null,
          stateCode: 3,
          state: 'ACTIVE',
          sessionUptimeSeconds: null,
          interfaceId: null,
          interfaceName: null,
          interfaceAlias: null,
          interfaceDescription: null,
          displayName: '10.0.0.2',
          correlationStatus: 'UNMATCHED',
          correlationError: null,
        },
      ]),
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
      matchedInterfaces: 1,
      unmatchedInterfaces: 1,
    });
    expect(body.peers[0].remoteAs).toBe('12345');
    expect(body.peers[0].correlationStatus).toBe('MATCHED');
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
