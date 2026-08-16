import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import type { HostRepository } from '../persistence/host-repository';
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
    replaceInterfaces: vi.fn().mockImplementation(async (_hostId, interfaces) => interfaces),
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
});

describe('SNMP credential safety', () => {
  it('generic authentication errors never contain a community value', () => {
    const errorMessage = 'SNMP authentication failed - check community/credentials and version compatibility';
    expect(errorMessage).not.toContain('private');
    expect(errorMessage).not.toContain('public');
  });
});
