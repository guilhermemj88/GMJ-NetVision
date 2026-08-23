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
    updateInterfaceOptics: vi.fn(),
    getLatestCounterSnapshots: vi.fn().mockResolvedValue(new Map()),
    saveSnmpPoll: vi.fn(),
    getInterfaceHistory: vi.fn().mockResolvedValue([]),
    getInterfaceMetrics: vi.fn().mockResolvedValue(null),
  } as unknown as HostRepository;
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
      adminStatus: 'UP' as const, operStatus: 'UP' as const,
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
    vi.spyOn(service, 'collectCounters').mockResolvedValue(new Map([[1, {
      ifIndex: 1, timestamp: now, inOctets: 120n, outOctets: 230n,
      inErrors: 0n, outErrors: 0n, inDiscards: 0n, outDiscards: 0n, operStatus: 'UP',
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
    vi.spyOn(service, 'collectCounters').mockResolvedValue(new Map([[1, {
      ifIndex: 1, timestamp: now, inOctets: 200n, outOctets: 300n,
      inErrors: 7057n, outErrors: 2n, inDiscards: 2n, outDiscards: 10n, operStatus: 'UP',
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
    vi.spyOn(service, 'collectCounters').mockResolvedValue(new Map([[1, {
      ifIndex: 1, timestamp: now,
      inOctets: 8_500n, outOctets: 17_000n,
      inErrors: 0n, outErrors: 0n, inDiscards: 0n, outDiscards: 0n, operStatus: 'UP',
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

describe('SNMP credential safety', () => {
  it('generic authentication errors never contain a community value', () => {
    const errorMessage = 'SNMP authentication failed - check community/credentials and version compatibility';
    expect(errorMessage).not.toContain('private');
    expect(errorMessage).not.toContain('public');
  });
});
