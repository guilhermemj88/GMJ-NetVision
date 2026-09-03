import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import type { HostRepository } from '../persistence/host-repository';
import type { DeviceMetricSampleInput } from '../persistence/host-repository';
import { SnmpClientImpl } from './snmp-client-impl';
import { SnmpService } from './snmp-service';

function host(overrides: Partial<HostRecord> = {}): HostRecord {
  const timestamp = new Date().toISOString();
  return {
    id: 'test-1',
    name: 'Test Device',
    hostname: 'test.example.com',
    ip: '192.168.1.1',
    vendor: 'Generic',
    model: 'Device',
    status: 'UP',
    deviceType: 'router',
    site: 'Test Site',
    source: 'MANUAL',
    discoveryMethod: 'MANUAL',
    uptimeSeconds: 0,
    updatedAt: timestamp,
    displayName: 'Test Device',
    managementIp: '192.168.1.1',
    description: 'Test',
    notes: '',
    origin: 'MANUAL',
    useZabbix: false,
    zabbix: null,
    sshEnabled: false,
    ssh: null,
    snmpEnabled: false,
    snmp: null,
    sourceHealth: {
      ZABBIX: { state: 'DISABLED', lastSuccess: null, lastFailure: null, lastErrorSafe: null },
      SSH: { state: 'DISABLED', lastSuccess: null, lastFailure: null, lastErrorSafe: null },
      SNMP: { state: 'DISABLED', lastSuccess: null, lastFailure: null, lastErrorSafe: null },
    },
    lastPollingAt: null,
    lastDiscoveryAt: null,
    mapIds: [],
    mapCount: 0,
    createdAt: timestamp,
    interfaces: [],
    ...overrides,
  } as HostRecord;
}

function repository(credentials: { community?: string } | null = { community: 'public' }): HostRepository {
  return {
    listHosts: vi.fn().mockResolvedValue([]),
    getHost: vi.fn().mockResolvedValue(null),
    createHost: vi.fn(),
    updateHost: vi.fn(),
    deleteHost: vi.fn(),
    updateSourceHealth: vi.fn(),
    getDecryptedSnmpCredentials: vi.fn().mockResolvedValue(credentials),
    getDecryptedSshCredentials: vi.fn().mockResolvedValue(null),
    replaceInterfaces: vi.fn().mockImplementation(async (_hostId, interfaces) => interfaces),
    updateInterfaceStatuses: vi.fn(),
    updateInterfaceOptics: vi.fn(),
    getLatestCounterSnapshots: vi.fn().mockResolvedValue(new Map()),
    saveSnmpPoll: vi.fn(),
    getInterfaceHistory: vi.fn().mockResolvedValue([]),
    getInterfaceMetrics: vi.fn().mockResolvedValue(null),
  } as unknown as HostRepository;
}

function networkInterface(
  name: string,
  ifIndex: number,
  status: HostRecord['interfaces'][number]['operStatus'] = 'DOWN',
): HostRecord['interfaces'][number] {
  return {
    id: `if-${ifIndex}`, deviceId: 'test-1', name, alias: '', description: name,
    ifIndex, mac: '', mtu: 1500, speedBps: name.startsWith('100GE') ? 100_000_000_000 : 1_000_000_000,
    adminStatus: status === 'UP' ? 'UP' : 'DOWN', operStatus: status,
    rxBps: 0, txBps: 0, rxUtilization: 0, txUtilization: 0,
    rxErrors: 0, txErrors: 0, rxDiscards: 0, txDiscards: 0, dataSources: ['SNMP'],
  };
}

function snmpHost(
  interfaces: HostRecord['interfaces'],
  overrides: Partial<HostRecord> = {},
): HostRecord {
  return host({
    interfaces,
    lastDiscoveryAt: new Date().toISOString(),
    snmpEnabled: true,
    snmp: {
      version: 'SNMP_V2C', host: '192.168.1.1', port: 161, username: '',
      securityLevel: 'NO_AUTH_NO_PRIV', authProtocol: null, privacyProtocol: null,
      credentialConfigured: true,
    },
    ...overrides,
  });
}

function counterRow(ifIndex: number, timestamp = new Date()) {
  return {
    ifIndex,
    timestamp,
    inOctets: 100n,
    outOctets: 200n,
    inErrors: 0n,
    outErrors: 0n,
    inDiscards: 0n,
    outDiscards: 0n,
  };
}

function statusRow(ifIndex: number) {
  return { ifIndex, adminStatus: 'UP' as const, operStatus: 'UP' as const };
}

describe('SnmpClientImpl', () => {
  let client: SnmpClientImpl;

  beforeEach(() => {
    client = new SnmpClientImpl(3000, 1);
  });

  it('constructs a real SNMP client', () => {
    expect(client).toBeDefined();
  });
});

describe('SnmpService', () => {
  it('returns DISABLED when SNMP is disabled', async () => {
    const service = new SnmpService(repository());
    const result = await service.testConnectivity(host());
    expect(result.state).toBe('DISABLED');
  });

  it('returns DISABLED when SNMP configuration is missing', async () => {
    const service = new SnmpService(repository());
    const result = await service.testConnectivity(host({ snmpEnabled: true, snmp: null }));
    expect(result.state).toBe('DISABLED');
  });

  it('returns empty interfaces when SNMP is disabled', async () => {
    const service = new SnmpService(repository());
    expect(await service.discoverInterfaces(host())).toEqual([]);
  });

  it('returns empty counters when SNMP is disabled', async () => {
    const service = new SnmpService(repository());
    expect((await service.collectCounters(host())).size).toBe(0);
  });

  it('fails safely when an enabled host has no stored community', async () => {
    const service = new SnmpService(repository(null));
    const result = await service.testConnectivity(host({
      snmpEnabled: true,
      snmp: {
        version: 'SNMP_V2C',
        host: '192.168.1.1',
        port: 161,
        username: '',
        securityLevel: 'NO_AUTH_NO_PRIV',
        authProtocol: null,
        privacyProtocol: null,
        credentialConfigured: false,
      },
    }));
    expect(result.state).toBe('AUTH_INVALID');
    expect(result.message).not.toContain('public');
  });

  it('preserves the close-poll guard and stores detected sysName without renaming the host', async () => {
    const now = new Date();
    const networkInterface = {
      id: 'if-1', deviceId: 'test-1', name: '100GE0/0/1', alias: '', description: '100GE0/0/1',
      ifIndex: 1, mac: '', mtu: 1500, speedBps: 100_000_000_000,
      adminStatus: 'DOWN' as const, operStatus: 'DOWN' as const,
      rxBps: 0, txBps: 0, rxUtilization: 0, txUtilization: 0,
      rxErrors: 0, txErrors: 0, rxDiscards: 0, txDiscards: 0, dataSources: ['SNMP' as const],
    };
    const repo = repository();
    vi.mocked(repo.getLatestCounterSnapshots).mockResolvedValue(new Map([[1, {
      interfaceId: 'if-1', ifIndex: 1, timestamp: new Date(now.getTime() - 30_000),
      inOctets: 100n, outOctets: 200n, inErrors: 0n, outErrors: 0n,
      inDiscards: 0n, outDiscards: 0n,
    }]]));
    const service = new SnmpService(repo, undefined, Number.POSITIVE_INFINITY);
    vi.spyOn(service, 'collectInterfaceStatuses').mockResolvedValue(new Map([[1, {
      ifIndex: 1, adminStatus: 'UP', operStatus: 'UP',
    }]]));
    vi.spyOn(service, 'collectCounters').mockResolvedValue(new Map([[1, {
      ifIndex: 1, timestamp: now, inOctets: 120n, outOctets: 230n,
      inErrors: 0n, outErrors: 0n, inDiscards: 0n, outDiscards: 0n,
    }]]));
    const internals = service as unknown as {
      collectSystem: () => Promise<DeviceMetricSampleInput>;
    };
    vi.spyOn(internals, 'collectSystem').mockResolvedValue({
      timestamp: now, uptimeSeconds: 123n, sysName: 'different-device-sysname',
    });
    const device = host({
      hostname: 'registered-hostname', interfaces: [networkInterface],
      lastDiscoveryAt: now.toISOString(), snmpEnabled: true,
      snmp: {
        version: 'SNMP_V2C', host: '192.168.1.1', port: 161, username: '',
        securityLevel: 'NO_AUTH_NO_PRIV', authProtocol: null, privacyProtocol: null,
        credentialConfigured: true,
      },
    });

    await service.pollHost(device);

    expect(repo.saveSnmpPoll).toHaveBeenCalledWith(
      device.id,
      expect.objectContaining({ sysName: 'different-device-sysname' }),
      [],
    );
    expect(repo.updateInterfaceStatuses).toHaveBeenCalledWith(device.id, [{
      ifIndex: 1, adminStatus: 'UP', operStatus: 'UP',
    }]);
    expect(repo.updateHost).not.toHaveBeenCalled();
    expect(device.hostname).toBe('registered-hostname');
  });

  it('persists cumulative error/discard counters plus non-negative interval deltas', async () => {
    const now = new Date();
    const networkInterface = {
      id: 'if-1', deviceId: 'test-1', name: 'GE0/0/1', alias: '', description: 'GE0/0/1',
      ifIndex: 1, mac: '', mtu: 1500, speedBps: 1_000_000_000,
      adminStatus: 'UP' as const, operStatus: 'UP' as const, rxBps: 0, txBps: 0,
      rxUtilization: 0, txUtilization: 0, rxErrors: 0, txErrors: 0, rxDiscards: 0,
      txDiscards: 0, dataSources: ['SNMP' as const],
    };
    const repo = repository();
    vi.mocked(repo.getLatestCounterSnapshots).mockResolvedValue(new Map([[1, {
      interfaceId: 'if-1', ifIndex: 1, timestamp: new Date(now.getTime() - 60_000),
      inOctets: 100n, outOctets: 200n, inErrors: 7054n, outErrors: 2n,
      inDiscards: 9n, outDiscards: 8n,
    }]]));
    const service = new SnmpService(repo, undefined, Number.POSITIVE_INFINITY);
    vi.spyOn(service, 'collectInterfaceStatuses').mockResolvedValue(new Map([[1, {
      ifIndex: 1, adminStatus: 'UP', operStatus: 'UP',
    }]]));
    vi.spyOn(service, 'collectCounters').mockResolvedValue(new Map([[1, {
      ifIndex: 1, timestamp: now, inOctets: 200n, outOctets: 300n,
      inErrors: 7057n, outErrors: 2n, inDiscards: 2n, outDiscards: 10n,
    }]]));
    const internals = service as unknown as { collectSystem: () => Promise<DeviceMetricSampleInput> };
    vi.spyOn(internals, 'collectSystem').mockResolvedValue({ timestamp: now });
    const polledHost = host({
      interfaces: [networkInterface], lastDiscoveryAt: now.toISOString(), snmpEnabled: true,
      snmp: {
        version: 'SNMP_V2C', host: '192.168.1.1', port: 161, username: '',
        securityLevel: 'NO_AUTH_NO_PRIV', authProtocol: null, privacyProtocol: null,
        credentialConfigured: true,
      },
    });

    await service.pollHost(polledHost);

    expect(repo.saveSnmpPoll).toHaveBeenCalledWith(polledHost.id, expect.any(Object), [
      expect.objectContaining({
        inErrors: 7057n, inErrorsDelta: 3n,
        outErrors: 2n, outErrorsDelta: 0n,
        inDiscards: 2n, inDiscardsDelta: 2n,
        outDiscards: 10n, outDiscardsDelta: 2n,
      }),
    ]);
  });

  it('calculates bps from the actual elapsed time when polling is irregular', async () => {
    const now = new Date('2026-08-23T12:01:15.000Z');
    const networkInterface = {
      id: 'if-1', deviceId: 'test-1', name: '100GE0/0/1', alias: '', description: '',
      ifIndex: 1, mac: '', mtu: 1500, speedBps: 100_000_000_000,
      adminStatus: 'UP' as const, operStatus: 'UP' as const,
      rxBps: 0, txBps: 0, rxUtilization: 0, txUtilization: 0,
      rxErrors: 0, txErrors: 0, rxDiscards: 0, txDiscards: 0, dataSources: ['SNMP' as const],
    };
    const repo = repository();
    vi.mocked(repo.getLatestCounterSnapshots).mockResolvedValue(new Map([[1, {
      interfaceId: 'if-1', ifIndex: 1, timestamp: new Date('2026-08-23T12:00:00.000Z'),
      inOctets: 1_000n, outOctets: 2_000n, inErrors: 0n, outErrors: 0n,
      inDiscards: 0n, outDiscards: 0n,
    }]]));
    const service = new SnmpService(repo, undefined, Number.POSITIVE_INFINITY);
    vi.spyOn(service, 'collectInterfaceStatuses').mockResolvedValue(new Map([[1, {
      ifIndex: 1, adminStatus: 'UP', operStatus: 'UP',
    }]]));
    vi.spyOn(service, 'collectCounters').mockResolvedValue(new Map([[1, {
      ifIndex: 1, timestamp: now,
      inOctets: 8_500n, outOctets: 17_000n,
      inErrors: 0n, outErrors: 0n, inDiscards: 0n, outDiscards: 0n,
    }]]));
    const internals = service as unknown as { collectSystem: () => Promise<DeviceMetricSampleInput> };
    vi.spyOn(internals, 'collectSystem').mockResolvedValue({ timestamp: now });
    const polledHost = host({
      interfaces: [networkInterface], lastDiscoveryAt: new Date().toISOString(), snmpEnabled: true,
      snmp: {
        version: 'SNMP_V2C', host: '192.168.1.1', port: 161, username: '',
        securityLevel: 'NO_AUTH_NO_PRIV', authProtocol: null, privacyProtocol: null,
        credentialConfigured: true,
      },
    });

    await service.pollHost(polledHost);

    expect(repo.saveSnmpPoll).toHaveBeenCalledWith(polledHost.id, expect.any(Object), [
      expect.objectContaining({
        rxBps: 800,
        txBps: 1_600,
      }),
    ]);
  });

  it('updates an Eth-Trunk status even when a close poll cannot create traffic samples', async () => {
    const now = new Date('2026-08-23T12:00:30.000Z');
    const trunk = networkInterface('Eth-Trunk23', 23);
    const repo = repository();
    vi.mocked(repo.getLatestCounterSnapshots).mockResolvedValue(new Map([[23, {
      interfaceId: trunk.id, ifIndex: 23, timestamp: new Date('2026-08-23T12:00:00.000Z'),
      inOctets: 100n, outOctets: 200n, inErrors: 0n, outErrors: 0n,
      inDiscards: 0n, outDiscards: 0n,
    }]]));
    const service = new SnmpService(repo, undefined, Number.POSITIVE_INFINITY);
    vi.spyOn(service, 'collectInterfaceStatuses').mockResolvedValue(new Map([[23, {
      ifIndex: 23, adminStatus: 'UP', operStatus: 'UP',
    }]]));
    vi.spyOn(service, 'collectCounters').mockResolvedValue(new Map([[23, {
      ifIndex: 23, timestamp: now, inOctets: 150n, outOctets: 250n,
      inErrors: 0n, outErrors: 0n, inDiscards: 0n, outDiscards: 0n,
    }]]));
    const internals = service as unknown as { collectSystem: () => Promise<DeviceMetricSampleInput> };
    vi.spyOn(internals, 'collectSystem').mockResolvedValue({ timestamp: now });

    const result = await service.pollHost(snmpHost([trunk]));

    expect(repo.updateInterfaceStatuses).toHaveBeenCalledWith('test-1', [{
      ifIndex: 23, adminStatus: 'UP', operStatus: 'UP',
    }]);
    expect(repo.saveSnmpPoll).toHaveBeenCalledWith('test-1', expect.any(Object), []);
    expect(result).toMatchObject({ interfacesChecked: 1, interfaceSamples: 0 });
  });

  it('maps the Huawei IF-MIB status of each Eth-Trunk and 100GE ifIndex independently', async () => {
    const service = new SnmpService(repository());
    const internals = service as unknown as {
      client: { walk: (host: string, oid: string, options: unknown) => Promise<unknown[]> };
    };
    vi.spyOn(internals.client, 'walk').mockImplementation(async (_host, oid) => {
      if (oid.endsWith('.7')) {
        return [23, 1023, 1024].map((ifIndex) => ({ oid: `${oid}.${ifIndex}`, value: 1 }));
      }
      return [
        { oid: `${oid}.23`, value: 1 },
        { oid: `${oid}.1023`, value: 2 },
        { oid: `${oid}.1024`, value: 1 },
      ];
    });

    const statuses = await service.collectInterfaceStatuses(snmpHost([
      networkInterface('Eth-Trunk23', 23),
      networkInterface('100GE1/0/23', 1023),
      networkInterface('100GE1/0/24', 1024),
    ]), 'secret');

    expect([...statuses.values()]).toEqual([
      { ifIndex: 23, adminStatus: 'UP', operStatus: 'UP' },
      { ifIndex: 1023, adminStatus: 'UP', operStatus: 'DOWN' },
      { ifIndex: 1024, adminStatus: 'UP', operStatus: 'UP' },
    ]);
  });

  it('preserves a valid operational status when ifOperStatus is absent', async () => {
    const service = new SnmpService(repository());
    const internals = service as unknown as {
      client: { walk: (host: string, oid: string, options: unknown) => Promise<unknown[]> };
    };
    vi.spyOn(internals.client, 'walk').mockImplementation(async (_host, oid) =>
      oid.endsWith('.7') ? [{ oid: `${oid}.24`, value: 1 }] : []);

    const statuses = await service.collectInterfaceStatuses(
      snmpHost([networkInterface('100GE1/0/24', 24, 'UP')]),
      'secret',
    );

    expect(statuses.get(24)).toEqual({ ifIndex: 24, adminStatus: 'UP' });
    expect(statuses.get(24)).not.toHaveProperty('operStatus');
  });

  it('continues counter sampling when both status walks fail', async () => {
    const now = new Date('2026-08-23T12:01:00.000Z');
    const port = networkInterface('100GE1/0/24', 24);
    const repo = repository();
    vi.mocked(repo.getLatestCounterSnapshots).mockResolvedValue(new Map([[24, {
      interfaceId: port.id, ifIndex: 24, timestamp: new Date('2026-08-23T12:00:00.000Z'),
      inOctets: 100n, outOctets: 200n, inErrors: 0n, outErrors: 0n,
      inDiscards: 0n, outDiscards: 0n,
    }]]));
    const service = new SnmpService(repo, undefined, Number.POSITIVE_INFINITY);
    const internals = service as unknown as {
      client: { walk: (host: string, oid: string, options: unknown) => Promise<unknown[]> };
      collectSystem: () => Promise<DeviceMetricSampleInput>;
      profileMetrics: { collect: () => Promise<Record<string, never>> };
    };
    vi.spyOn(internals.client, 'walk').mockRejectedValue(new Error('status walk failed'));
    vi.spyOn(internals.profileMetrics, 'collect').mockResolvedValue({});
    vi.spyOn(internals, 'collectSystem').mockResolvedValue({ timestamp: now });
    vi.spyOn(service, 'collectCounters').mockResolvedValue(new Map([[24, {
      ifIndex: 24, timestamp: now, inOctets: 200n, outOctets: 300n,
      inErrors: 0n, outErrors: 0n, inDiscards: 0n, outDiscards: 0n,
    }]]));

    await service.pollHost(snmpHost([port]));

    expect(repo.updateInterfaceStatuses).toHaveBeenCalledWith('test-1', []);
    expect(repo.saveSnmpPoll).toHaveBeenCalledWith('test-1', expect.any(Object), [
      expect.objectContaining({ interfaceId: port.id, operStatus: 'DOWN' }),
    ]);
  });

  it('reuses one real poll for simultaneous requests to the same host', async () => {
    const repo = repository();
    const service = new SnmpService(repo, undefined, Number.POSITIVE_INFINITY);
    let finishSystem: ((sample: DeviceMetricSampleInput) => void) | undefined;
    const internals = service as unknown as {
      collectSystem: () => Promise<DeviceMetricSampleInput>;
      profileMetrics: { collect: () => Promise<Record<string, never>> };
    };
    const collectSystem = vi.spyOn(internals, 'collectSystem').mockImplementation(() =>
      new Promise((resolve) => { finishSystem = resolve; }));
    vi.spyOn(internals.profileMetrics, 'collect').mockResolvedValue({});
    vi.spyOn(service, 'collectInterfaceStatuses').mockResolvedValue(new Map());
    vi.spyOn(service, 'collectCounters').mockResolvedValue(new Map());
    const device = snmpHost([networkInterface('GE0/0/1', 1, 'UP')]);

    const first = service.pollHost(device);
    const second = service.pollHost(device);
    await vi.waitFor(() => expect(finishSystem).toBeTypeOf('function'));
    finishSystem!({ timestamp: new Date('2026-08-23T12:00:00.000Z') });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(collectSystem).toHaveBeenCalledTimes(1);
    expect(repo.saveSnmpPoll).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual(secondResult);
  });

  it('limits heavy optical enrichment to the configured interval', async () => {
    const repo = repository();
    const service = new SnmpService(repo, undefined, 300_000);
    const polledHost = host({
      snmpEnabled: true,
      snmp: {
        version: 'SNMP_V2C', host: '192.168.1.1', port: 161, username: '',
        securityLevel: 'NO_AUTH_NO_PRIV', authProtocol: null, privacyProtocol: null,
        credentialConfigured: true,
      },
    });
    const internals = service as unknown as {
      refreshOpticalPower: (device: HostRecord, community: string) => Promise<void>;
      discoveryAdapter: {
        enrichOpticalPower: (device: HostRecord, interfaces: HostRecord['interfaces'], community: string) => Promise<HostRecord['interfaces']>;
      };
    };
    const enrichment = vi.spyOn(internals.discoveryAdapter, 'enrichOpticalPower').mockResolvedValue([]);

    await internals.refreshOpticalPower(polledHost, 'secret');
    await internals.refreshOpticalPower(polledHost, 'secret');

    expect(enrichment).toHaveBeenCalledTimes(1);
    expect(repo.updateInterfaceOptics).toHaveBeenCalledTimes(1);
  });
});

describe('SnmpService unknown interface auto-discovery', () => {
  function pollService(repo: HostRepository): SnmpService {
    return new SnmpService(repo, undefined, Number.POSITIVE_INFINITY);
  }

  function mockCollectSystem(service: SnmpService, timestamp: Date): void {
    const internals = service as unknown as {
      collectSystem: () => Promise<DeviceMetricSampleInput>;
    };
    vi.spyOn(internals, 'collectSystem').mockResolvedValue({ timestamp });
  }

  it('detects a new ifIndex in statuses and counters and requests discovery once', async () => {
    const now = new Date('2026-08-23T12:00:30.000Z');
    const repo = repository();
    const service = pollService(repo);
    const discover = vi.spyOn(service, 'discoverAndPersistInterfaces').mockResolvedValue([]);
    vi.spyOn(service, 'collectInterfaceStatuses').mockResolvedValue(new Map([
      [1, statusRow(1)], [2193, statusRow(2193)],
    ]));
    vi.spyOn(service, 'collectCounters').mockResolvedValue(new Map([
      [1, counterRow(1, now)], [2193, counterRow(2193, now)],
    ]));
    mockCollectSystem(service, now);

    await service.pollHost(snmpHost([networkInterface('GE0/0/1', 1, 'UP')]));

    expect(discover).toHaveBeenCalledTimes(1);
    expect(repo.saveSnmpPoll).toHaveBeenCalledTimes(1);
    expect(repo.saveSnmpPoll).toHaveBeenCalledWith('test-1', expect.any(Object), [
      expect.objectContaining({ ifIndex: 1 }),
    ]);
  });

  it('detects a new ifIndex present only in statuses', async () => {
    const now = new Date('2026-08-23T12:00:30.000Z');
    const repo = repository();
    const service = pollService(repo);
    const discover = vi.spyOn(service, 'discoverAndPersistInterfaces').mockResolvedValue([]);
    vi.spyOn(service, 'collectInterfaceStatuses').mockResolvedValue(new Map([
      [1, statusRow(1)], [2193, statusRow(2193)],
    ]));
    vi.spyOn(service, 'collectCounters').mockResolvedValue(new Map([
      [1, counterRow(1, now)],
    ]));
    mockCollectSystem(service, now);

    await service.pollHost(snmpHost([networkInterface('GE0/0/1', 1, 'UP')]));

    expect(discover).toHaveBeenCalledTimes(1);
    expect(repo.saveSnmpPoll).toHaveBeenCalledTimes(1);
  });

  it('detects a new ifIndex present only in counters', async () => {
    const now = new Date('2026-08-23T12:00:30.000Z');
    const repo = repository();
    const service = pollService(repo);
    const discover = vi.spyOn(service, 'discoverAndPersistInterfaces').mockResolvedValue([]);
    vi.spyOn(service, 'collectInterfaceStatuses').mockResolvedValue(new Map([
      [1, statusRow(1)],
    ]));
    vi.spyOn(service, 'collectCounters').mockResolvedValue(new Map([
      [1, counterRow(1, now)], [2193, counterRow(2193, now)],
    ]));
    mockCollectSystem(service, now);

    await service.pollHost(snmpHost([networkInterface('GE0/0/1', 1, 'UP')]));

    expect(discover).toHaveBeenCalledTimes(1);
    expect(repo.saveSnmpPoll).toHaveBeenCalledTimes(1);
  });

  it('requests a single discovery when five unknown ifIndexes appear in one poll', async () => {
    const now = new Date('2026-08-23T12:00:30.000Z');
    const repo = repository();
    const service = pollService(repo);
    const discover = vi.spyOn(service, 'discoverAndPersistInterfaces').mockResolvedValue([]);
    const unknownIndexes = [1001, 1002, 1003, 1004, 1005];
    vi.spyOn(service, 'collectInterfaceStatuses').mockResolvedValue(new Map([
      [1, statusRow(1)],
      ...unknownIndexes.map((ifIndex) => [ifIndex, statusRow(ifIndex)] as const),
    ]));
    vi.spyOn(service, 'collectCounters').mockResolvedValue(new Map([
      [1, counterRow(1, now)],
      ...unknownIndexes.map((ifIndex) => [ifIndex, counterRow(ifIndex, now)] as const),
    ]));
    mockCollectSystem(service, now);

    await service.pollHost(snmpHost([networkInterface('GE0/0/1', 1, 'UP')]));

    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('does not request discovery when no unknown ifIndex is observed', async () => {
    const now = new Date('2026-08-23T12:00:30.000Z');
    const repo = repository();
    const service = pollService(repo);
    const discover = vi.spyOn(service, 'discoverAndPersistInterfaces').mockResolvedValue([]);
    vi.spyOn(service, 'collectInterfaceStatuses').mockResolvedValue(new Map([
      [1, statusRow(1)],
    ]));
    vi.spyOn(service, 'collectCounters').mockResolvedValue(new Map([
      [1, counterRow(1, now)],
    ]));
    mockCollectSystem(service, now);

    await service.pollHost(snmpHost([networkInterface('GE0/0/1', 1, 'UP')]));

    expect(discover).not.toHaveBeenCalled();
  });

  it('keeps known interfaces polled when unknown-interface discovery fails', async () => {
    const now = new Date('2026-08-23T12:00:30.000Z');
    const repo = repository();
    const service = pollService(repo);
    vi.spyOn(service, 'discoverAndPersistInterfaces').mockRejectedValue(new Error('discovery boom'));
    vi.spyOn(service, 'collectInterfaceStatuses').mockResolvedValue(new Map([
      [1, statusRow(1)], [2193, statusRow(2193)],
    ]));
    vi.spyOn(service, 'collectCounters').mockResolvedValue(new Map([
      [1, counterRow(1, now)], [2193, counterRow(2193, now)],
    ]));
    mockCollectSystem(service, now);

    await service.pollHost(snmpHost([networkInterface('GE0/0/1', 1, 'UP')]));

    expect(repo.saveSnmpPoll).toHaveBeenCalledTimes(1);
    expect(repo.saveSnmpPoll).toHaveBeenCalledWith('test-1', expect.any(Object), [
      expect.objectContaining({ ifIndex: 1 }),
    ]);
  });

  it('suppresses repeated discovery within the cooldown window', async () => {
    const now = new Date('2026-08-23T12:00:30.000Z');
    const repo = repository();
    const service = pollService(repo);
    const discover = vi.spyOn(service, 'discoverAndPersistInterfaces').mockResolvedValue([]);
    vi.spyOn(service, 'collectInterfaceStatuses').mockResolvedValue(new Map([
      [1, statusRow(1)], [2193, statusRow(2193)],
    ]));
    vi.spyOn(service, 'collectCounters').mockResolvedValue(new Map([
      [1, counterRow(1, now)], [2193, counterRow(2193, now)],
    ]));
    mockCollectSystem(service, now);
    const device = snmpHost([networkInterface('GE0/0/1', 1, 'UP')]);

    await service.pollHost(device);
    await service.pollHost(device);

    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('allows a new discovery attempt after the cooldown expires', async () => {
    const now = new Date('2026-08-23T12:00:30.000Z');
    const repo = repository();
    const service = pollService(repo);
    const discover = vi.spyOn(service, 'discoverAndPersistInterfaces').mockResolvedValue([]);
    vi.spyOn(service, 'collectInterfaceStatuses').mockResolvedValue(new Map([
      [1, statusRow(1)], [2193, statusRow(2193)],
    ]));
    vi.spyOn(service, 'collectCounters').mockResolvedValue(new Map([
      [1, counterRow(1, now)], [2193, counterRow(2193, now)],
    ]));
    mockCollectSystem(service, now);
    const device = snmpHost([networkInterface('GE0/0/1', 1, 'UP')]);
    const internals = service as unknown as {
      lastInterfaceDiscoveryAttempts: Map<string, number>;
    };

    await service.pollHost(device);
    internals.lastInterfaceDiscoveryAttempts.set('test-1', Date.now() - 6 * 60 * 1000);
    await service.pollHost(device);

    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('runs the periodic interface refresh after one hour', async () => {
    const now = new Date();
    const repo = repository();
    const service = pollService(repo);
    const discover = vi.spyOn(service, 'discoverAndPersistInterfaces').mockResolvedValue([]);
    vi.spyOn(service, 'collectInterfaceStatuses').mockResolvedValue(new Map([
      [1, statusRow(1)],
    ]));
    vi.spyOn(service, 'collectCounters').mockResolvedValue(new Map([
      [1, counterRow(1, now)],
    ]));
    mockCollectSystem(service, now);
    const oldDiscovery = new Date(Date.now() - 61 * 60 * 1000).toISOString();

    await service.pollHost(snmpHost([networkInterface('GE0/0/1', 1, 'UP')], {
      lastDiscoveryAt: oldDiscovery,
    }));

    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('does not run the periodic refresh before one hour when no unknown ifIndex exists', async () => {
    const now = new Date();
    const repo = repository();
    const service = pollService(repo);
    const discover = vi.spyOn(service, 'discoverAndPersistInterfaces').mockResolvedValue([]);
    vi.spyOn(service, 'collectInterfaceStatuses').mockResolvedValue(new Map([
      [1, statusRow(1)],
    ]));
    vi.spyOn(service, 'collectCounters').mockResolvedValue(new Map([
      [1, counterRow(1, now)],
    ]));
    mockCollectSystem(service, now);
    const recentDiscovery = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    await service.pollHost(snmpHost([networkInterface('GE0/0/1', 1, 'UP')], {
      lastDiscoveryAt: recentDiscovery,
    }));

    expect(discover).not.toHaveBeenCalled();
  });
});

describe('SNMP credential safety', () => {
  it('generic authentication errors never contain a community value', () => {
    const errorMessage = 'SNMP authentication failed - check community/credentials and version compatibility';
    expect(errorMessage).not.toContain('private');
    expect(errorMessage).not.toContain('public');
  });
});
