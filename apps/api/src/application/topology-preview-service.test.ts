import { describe, expect, it } from 'vitest';
import type { Device, DiscoveredNeighbor, HostRecord, NetworkLink, NetworkMap } from '@gmj/shared';
import type { TopologyDiscoveryAdapter } from '../domain/ports';
import { InMemoryTopologyPreviewStore } from '../infrastructure/persistence/in-memory-topology-preview-store';
import { makeHost, makeInterface, makeLink, makeMap } from '../test-fixtures';
import { TopologyPreviewService } from './topology-preview-service';

function neighbor(partial: Partial<DiscoveredNeighbor>): DiscoveredNeighbor {
  return {
    id: 'n',
    localDeviceId: 'host-a',
    localPort: '100GE1/0/1',
    remoteSystemName: 'host-b',
    remotePort: '100GE1/0/2',
    capabilities: [],
    source: 'LLDP_SNMP',
    matchStatus: 'UNMATCHED',
    ...partial,
  };
}

class FakeTopologyAdapter implements TopologyDiscoveryAdapter {
  readonly kind: 'LLDP_SNMP' | 'LLDP_SSH';
  calls = 0;

  constructor(
    kind: 'LLDP_SNMP' | 'LLDP_SSH',
    private readonly neighborsByHost: Map<string, DiscoveredNeighbor[] | Error>,
  ) {
    this.kind = kind;
  }

  async discoverNeighbors(device: Device): Promise<DiscoveredNeighbor[]> {
    this.calls += 1;
    const value = this.neighborsByHost.get(device.id);
    if (value instanceof Error) throw value;
    return value ?? [];
  }

  async discoverDevice(): Promise<never> { throw new Error('not implemented'); }
  async getDeviceIdentity(): Promise<never> { throw new Error('not implemented'); }
  async discoverInterfaces(): Promise<never> { throw new Error('not implemented'); }
}

class FakeLinkRepository {
  createCalls = 0;

  constructor(private readonly map: NetworkMap) {}

  async getMap(): Promise<NetworkMap | null> {
    return structuredClone(this.map);
  }

  async createDiscoveredLink(): Promise<NetworkLink | null> {
    this.createCalls += 1;
    return null;
  }
}

function hostA(): HostRecord {
  return makeHost({
    id: 'host-a',
    hostname: 'bhe-a',
    managementIp: '10.0.0.1',
    interfaces: [makeInterface({ id: 'a-if', deviceId: 'host-a', name: '100GE1/0/1', ifIndex: 1001 })],
  });
}

function hostB(): HostRecord {
  return makeHost({
    id: 'host-b',
    hostname: 'bhe-b',
    managementIp: '10.0.0.2',
    interfaces: [makeInterface({ id: 'b-if', deviceId: 'host-b', name: '100GE1/0/2', ifIndex: 2002 })],
  });
}

function previewService(adapter: TopologyDiscoveryAdapter, hosts: HostRecord[], map: NetworkMap) {
  return new TopologyPreviewService(
    [adapter],
    { listHosts: async () => hosts },
    new FakeLinkRepository(map),
    new InMemoryTopologyPreviewStore(),
  );
}

describe('TopologyPreviewService', () => {
  it('merges a bidirectional pair into one CONFIRMED adjacency', async () => {
    const a = hostA();
    const b = hostB();
    const adapter = new FakeTopologyAdapter('LLDP_SNMP', new Map([
      ['host-a', [neighbor({ remoteManagementAddress: '10.0.0.2' })]],
      ['host-b', [neighbor({ id: 'n2', localDeviceId: 'host-b', localPort: '100GE1/0/2', remoteSystemName: 'bhe-a', remotePort: '100GE1/0/1', remoteManagementAddress: '10.0.0.1' })]],
    ]));
    const preview = await previewService(adapter, [a, b], makeMap({ id: 'map-1' })).discover('map-1');
    expect(preview.stats.adjacencies).toBe(1);
    expect(preview.stats.confirmed).toBe(1);
    expect(preview.adjacencies[0]).toMatchObject({
      sourceHostId: 'host-a',
      targetHostId: 'host-b',
      sourceInterfaceId: 'a-if',
      targetInterfaceId: 'b-if',
      confidence: 'CONFIRMED',
      duplicate: false,
    });
  });

  it('marks one-sided neighbors as PROBABLE', async () => {
    const a = hostA();
    const b = hostB();
    const adapter = new FakeTopologyAdapter('LLDP_SNMP', new Map([
      ['host-a', [neighbor({ remoteManagementAddress: '10.0.0.2' })]],
    ]));
    const preview = await previewService(adapter, [a, b], makeMap({ id: 'map-1' })).discover('map-1');
    expect(preview.adjacencies[0]?.confidence).toBe('PROBABLE');
  });

  it('marks unknown neighbors as UNKNOWN_NEIGHBOR', async () => {
    const a = hostA();
    const adapter = new FakeTopologyAdapter('LLDP_SNMP', new Map<string, DiscoveredNeighbor[] | Error>([
      ['host-a', [neighbor({ remoteSystemName: 'X-UNKNOWN', remotePort: 'GE0/0/9' })]],
    ]));
    const preview = await previewService(adapter, [a, hostB()], makeMap({ id: 'map-1' })).discover('map-1');
    expect(preview.adjacencies[0]?.confidence).toBe('UNKNOWN_NEIGHBOR');
  });

  it('marks multiple host candidates as AMBIGUOUS', async () => {
    const a = hostA();
    const twinB = makeHost({ id: 'twin-b', hostname: 'core-01', managementIp: '10.0.0.3' });
    const twinC = makeHost({ id: 'twin-c', hostname: 'CORE-01', managementIp: '10.0.0.4' });
    const adapter = new FakeTopologyAdapter('LLDP_SNMP', new Map([
      ['host-a', [neighbor({ remoteSystemName: 'core-01' })]],
    ]));
    const preview = await previewService(adapter, [a, twinB, twinC], makeMap({ id: 'map-1' })).discover('map-1');
    expect(preview.adjacencies[0]?.confidence).toBe('AMBIGUOUS');
  });

  it('flags existing links as duplicates without creating anything', async () => {
    const a = hostA();
    const b = hostB();
    const existing = makeLink({
      id: 'link-existing',
      mapId: 'map-1',
      sourceDeviceId: 'host-a',
      sourceInterfaceId: 'a-if',
      targetDeviceId: 'host-b',
      targetInterfaceId: 'b-if',
    });
    const adapter = new FakeTopologyAdapter('LLDP_SNMP', new Map([
      ['host-a', [neighbor({ remoteManagementAddress: '10.0.0.2' })]],
      ['host-b', [neighbor({ id: 'n2', localDeviceId: 'host-b', localPort: '100GE1/0/2', remoteSystemName: 'bhe-a', remotePort: '100GE1/0/1', remoteManagementAddress: '10.0.0.1' })]],
    ]));
    const repo = new FakeLinkRepository(makeMap({ id: 'map-1', links: [existing] }));
    const service = new TopologyPreviewService(
      [adapter],
      { listHosts: async () => [a, b] },
      repo,
      new InMemoryTopologyPreviewStore(),
    );
    const preview = await service.discover('map-1');
    expect(preview.adjacencies[0]).toMatchObject({ duplicate: true, existingLinkId: 'link-existing' });
    expect(repo.createCalls).toBe(0);
  });

  it('continues on partial host failure and reports a warning', async () => {
    const a = hostA();
    const b = hostB();
    const adapter = new FakeTopologyAdapter('LLDP_SNMP', new Map<string, DiscoveredNeighbor[] | Error>([
      ['host-a', new Error('SNMP timeout')],
      ['host-b', [neighbor({ id: 'n2', localDeviceId: 'host-b', localPort: '100GE1/0/2', remoteSystemName: 'bhe-a', remotePort: '100GE1/0/1', remoteManagementAddress: '10.0.0.1' })]],
    ]));
    const preview = await previewService(adapter, [a, b], makeMap({ id: 'map-1' })).discover('map-1');
    expect(preview.stats.hostsFailed).toBe(1);
    expect(preview.warnings.some((warning) => warning.includes('SNMP timeout'))).toBe(true);
    expect(preview.adjacencies).toHaveLength(1);
  });

  it('never mutates the link repository during discovery', async () => {
    const a = hostA();
    const b = hostB();
    const adapter = new FakeTopologyAdapter('LLDP_SNMP', new Map([
      ['host-a', [neighbor({ remoteManagementAddress: '10.0.0.2' })]],
    ]));
    const repo = new FakeLinkRepository(makeMap({ id: 'map-1' }));
    const service = new TopologyPreviewService(
      [adapter],
      { listHosts: async () => [a, b] },
      repo,
      new InMemoryTopologyPreviewStore(),
    );
    await service.discover('map-1');
    expect(repo.createCalls).toBe(0);
  });

  it('persists the preview so it can be loaded later', async () => {
    const a = hostA();
    const b = hostB();
    const adapter = new FakeTopologyAdapter('LLDP_SNMP', new Map([
      ['host-a', [neighbor({ remoteManagementAddress: '10.0.0.2' })]],
    ]));
    const store = new InMemoryTopologyPreviewStore();
    const service = new TopologyPreviewService(
      [adapter],
      { listHosts: async () => [a, b] },
      new FakeLinkRepository(makeMap({ id: 'map-1' })),
      store,
    );
    const preview = await service.discover('map-1');
    expect(store.load(preview.id)?.id).toBe(preview.id);
  });

  it('does not open SSH when SNMP already produced adjacencies', async () => {
    const a = makeHost({
      id: 'host-a',
      hostname: 'bhe-a',
      managementIp: '10.0.0.1',
      sshEnabled: true,
      interfaces: [makeInterface({ id: 'a-if', deviceId: 'host-a', name: '100GE1/0/1', ifIndex: 1001 })],
    });
    const b = hostB();
    const snmp = new FakeTopologyAdapter('LLDP_SNMP', new Map([
      ['host-a', [neighbor({ remoteManagementAddress: '10.0.0.2' })]],
    ]));
    const ssh = new FakeTopologyAdapter('LLDP_SSH', new Map());
    const service = new TopologyPreviewService(
      [snmp, ssh],
      { listHosts: async () => [a, b] },
      new FakeLinkRepository(makeMap({ id: 'map-1' })),
      new InMemoryTopologyPreviewStore(),
    );
    await service.discover('map-1');
    expect(snmp.calls).toBeGreaterThan(0);
    expect(ssh.calls).toBe(0);
  });

  it('falls back to SSH only when SNMP returns no neighbors', async () => {
    const a = makeHost({
      id: 'host-a',
      hostname: 'bhe-a',
      managementIp: '10.0.0.1',
      sshEnabled: true,
      interfaces: [makeInterface({ id: 'a-if', deviceId: 'host-a', name: '100GE1/0/1', ifIndex: 1001 })],
    });
    const b = hostB();
    const snmp = new FakeTopologyAdapter('LLDP_SNMP', new Map([['host-a', []]]));
    const ssh = new FakeTopologyAdapter('LLDP_SSH', new Map([
      ['host-a', [neighbor({ source: 'LLDP_SSH', remoteManagementAddress: '10.0.0.2' })]],
    ]));
    const service = new TopologyPreviewService(
      [snmp, ssh],
      { listHosts: async () => [a, b] },
      new FakeLinkRepository(makeMap({ id: 'map-1' })),
      new InMemoryTopologyPreviewStore(),
    );
    const preview = await service.discover('map-1');
    expect(snmp.calls).toBeGreaterThan(0);
    expect(ssh.calls).toBe(1);
    expect(preview.adjacencies[0]?.source).toBe('LLDP_SSH');
  });

  it('falls back to SSH when SNMP returns an incomplete neighbor', async () => {
    const a = makeHost({
      id: 'host-a',
      hostname: 'bhe-a',
      managementIp: '10.0.0.1',
      sshEnabled: true,
      interfaces: [makeInterface({ id: 'a-if', deviceId: 'host-a', name: '100GE1/0/1', ifIndex: 1001 })],
    });
    const b = hostB();
    const snmp = new FakeTopologyAdapter('LLDP_SNMP', new Map([
      ['host-a', [neighbor({ remoteSystemName: 'Unknown neighbor', remotePort: 'Unknown port' })]],
    ]));
    const ssh = new FakeTopologyAdapter('LLDP_SSH', new Map([
      ['host-a', [neighbor({ source: 'LLDP_SSH', remoteManagementAddress: '10.0.0.2' })]],
    ]));
    const service = new TopologyPreviewService(
      [snmp, ssh],
      { listHosts: async () => [a, b] },
      new FakeLinkRepository(makeMap({ id: 'map-1' })),
      new InMemoryTopologyPreviewStore(),
    );
    const preview = await service.discover('map-1');
    expect(ssh.calls).toBe(1);
    expect(preview.adjacencies).toHaveLength(1);
    expect(preview.adjacencies[0]).toMatchObject({ source: 'LLDP_SNMP', targetHostId: 'host-b' });
  });

  it('produces a single proposal when SNMP and SSH find the same adjacency', async () => {
    const a = makeHost({
      id: 'host-a',
      hostname: 'bhe-a',
      managementIp: '10.0.0.1',
      sshEnabled: true,
      interfaces: [makeInterface({ id: 'a-if', deviceId: 'host-a', name: '100GE1/0/1', ifIndex: 1001 })],
    });
    const b = hostB();
    const snmp = new FakeTopologyAdapter('LLDP_SNMP', new Map([
      ['host-a', [neighbor({ remoteManagementAddress: '10.0.0.2' })]],
    ]));
    const ssh = new FakeTopologyAdapter('LLDP_SSH', new Map([
      ['host-a', [neighbor({ source: 'LLDP_SSH', remoteManagementAddress: '10.0.0.2' })]],
    ]));
    const service = new TopologyPreviewService(
      [snmp, ssh],
      { listHosts: async () => [a, b] },
      new FakeLinkRepository(makeMap({ id: 'map-1' })),
      new InMemoryTopologyPreviewStore(),
    );
    const preview = await service.discover('map-1', { deepValidation: true });
    expect(preview.adjacencies).toHaveLength(1);
    expect(preview.adjacencies[0]?.source).toBe('LLDP_SNMP');
  });

  it('keeps an additional SSH adjacency as a separate proposal', async () => {
    const a = makeHost({
      id: 'host-a',
      hostname: 'bhe-a',
      managementIp: '10.0.0.1',
      sshEnabled: true,
      interfaces: [
        makeInterface({ id: 'a-if', deviceId: 'host-a', name: '100GE1/0/1', ifIndex: 1001 }),
        makeInterface({ id: 'a-if-2', deviceId: 'host-a', name: '100GE1/0/2', ifIndex: 1002 }),
      ],
    });
    const b = hostB();
    const c = makeHost({
      id: 'host-c',
      hostname: 'bhe-c',
      managementIp: '10.0.0.3',
      interfaces: [makeInterface({ id: 'c-if', deviceId: 'host-c', name: '100GE1/0/3', ifIndex: 3003 })],
    });
    const snmp = new FakeTopologyAdapter('LLDP_SNMP', new Map([
      ['host-a', [neighbor({ remoteManagementAddress: '10.0.0.2' })]],
    ]));
    const ssh = new FakeTopologyAdapter('LLDP_SSH', new Map([
      ['host-a', [
        neighbor({ source: 'LLDP_SSH', remoteManagementAddress: '10.0.0.2' }),
        neighbor({ source: 'LLDP_SSH', localPort: '100GE1/0/2', remoteSystemName: 'bhe-c', remotePort: '100GE1/0/3', remoteManagementAddress: '10.0.0.3' }),
      ]],
    ]));
    const service = new TopologyPreviewService(
      [snmp, ssh],
      { listHosts: async () => [a, b, c] },
      new FakeLinkRepository(makeMap({ id: 'map-1' })),
      new InMemoryTopologyPreviewStore(),
    );
    const preview = await service.discover('map-1', { deepValidation: true });
    expect(preview.adjacencies).toHaveLength(2);
    const sshOnly = preview.adjacencies.find((item) => item.targetHostId === 'host-c');
    expect(sshOnly?.source).toBe('LLDP_SSH');
  });

  it('prefers SNMP data over SSH when both exist', async () => {
    const a = makeHost({
      id: 'host-a',
      hostname: 'bhe-a',
      managementIp: '10.0.0.1',
      sshEnabled: true,
      interfaces: [makeInterface({ id: 'a-if', deviceId: 'host-a', name: '100GE1/0/1', ifIndex: 1001 })],
    });
    const b = hostB();
    const snmp = new FakeTopologyAdapter('LLDP_SNMP', new Map([
      ['host-a', [neighbor({ remoteManagementAddress: '10.0.0.2', remotePortDescription: 'FROM-SNMP' })]],
    ]));
    const ssh = new FakeTopologyAdapter('LLDP_SSH', new Map([
      ['host-a', [neighbor({ source: 'LLDP_SSH', remoteManagementAddress: '10.0.0.2', remotePortDescription: 'FROM-SSH' })]],
    ]));
    const service = new TopologyPreviewService(
      [snmp, ssh],
      { listHosts: async () => [a, b] },
      new FakeLinkRepository(makeMap({ id: 'map-1' })),
      new InMemoryTopologyPreviewStore(),
    );
    const preview = await service.discover('map-1', { deepValidation: true });
    expect(preview.adjacencies).toHaveLength(1);
    expect(preview.adjacencies[0]?.source).toBe('LLDP_SNMP');
    expect(preview.adjacencies[0]?.targetPortDescription).toBe('FROM-SNMP');
  });

  it('discovers a single host without mutating the map', async () => {
    const a = hostA();
    const b = hostB();
    const adapter = new FakeTopologyAdapter('LLDP_SNMP', new Map([
      ['host-a', [neighbor({ remoteManagementAddress: '10.0.0.2' })]],
    ]));
    const repo = new FakeLinkRepository(makeMap({ id: 'map-1' }));
    const service = new TopologyPreviewService(
      [adapter],
      { listHosts: async () => [a, b] },
      repo,
      new InMemoryTopologyPreviewStore(),
    );
    const preview = await service.discoverHost('host-a', 'map-1');
    expect(preview.stats.hostsQueried).toBe(1);
    expect(preview.adjacencies).toHaveLength(1);
    expect(preview.adjacencies[0]).toMatchObject({
      sourceHostId: 'host-a',
      targetHostId: 'host-b',
    });
    expect(repo.createCalls).toBe(0);
  });

  it('falls back to SSH for a single host when SNMP returns nothing', async () => {
    const a = makeHost({
      id: 'host-a',
      hostname: 'bhe-a',
      managementIp: '10.0.0.1',
      sshEnabled: true,
      interfaces: [makeInterface({ id: 'a-if', deviceId: 'host-a', name: '100GE1/0/1', ifIndex: 1001 })],
    });
    const b = hostB();
    const snmp = new FakeTopologyAdapter('LLDP_SNMP', new Map([['host-a', []]]));
    const ssh = new FakeTopologyAdapter('LLDP_SSH', new Map([
      ['host-a', [neighbor({ source: 'LLDP_SSH', remoteManagementAddress: '10.0.0.2' })]],
    ]));
    const service = new TopologyPreviewService(
      [snmp, ssh],
      { listHosts: async () => [a, b] },
      new FakeLinkRepository(makeMap({ id: 'map-1' })),
      new InMemoryTopologyPreviewStore(),
    );
    const preview = await service.discoverHost('host-a', 'map-1');
    expect(snmp.calls).toBe(1);
    expect(ssh.calls).toBe(1);
    expect(preview.adjacencies[0]?.source).toBe('LLDP_SSH');
  });

  it('warns when a single host has no access configured', async () => {
    const a = makeHost({
      id: 'host-a',
      hostname: 'bhe-a',
      managementIp: '10.0.0.1',
      snmpEnabled: false,
      sshEnabled: false,
      interfaces: [makeInterface({ id: 'a-if', deviceId: 'host-a', name: '100GE1/0/1', ifIndex: 1001 })],
    });
    const adapter = new FakeTopologyAdapter('LLDP_SNMP', new Map());
    const service = new TopologyPreviewService(
      [adapter],
      { listHosts: async () => [a, hostB()] },
      new FakeLinkRepository(makeMap({ id: 'map-1' })),
      new InMemoryTopologyPreviewStore(),
    );
    const preview = await service.discoverHost('host-a', 'map-1');
    expect(preview.warnings.some((warning) => warning.includes('SNMP e SSH desabilitados'))).toBe(
      true,
    );
    expect(preview.stats.hostsFailed).toBe(1);
  });
});
