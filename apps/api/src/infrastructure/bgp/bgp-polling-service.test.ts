import { describe, expect, it, vi } from 'vitest';
import { makeHost } from '../../test-fixtures';
import { BgpPollingService } from './bgp-polling-service';
import type { BgpRepository } from './bgp-repository';
import type { HuaweiBgpCollection, HuaweiBgpSnmpCollector } from './huawei-bgp-snmp';

function device() {
  return makeHost({
    id: 'ne8000-1',
    hostname: 'NE8000-1',
    snmpEnabled: true,
    snmp: {
      version: 'SNMP_V2C',
      host: '192.0.2.1',
      port: 161,
      username: '',
      securityLevel: 'NO_AUTH_NO_PRIV',
      authProtocol: null,
      privacyProtocol: null,
      credentialConfigured: true,
    },
  });
}

function collection(): HuaweiBgpCollection {
  return {
    collectedAt: new Date('2026-09-19T12:00:00.000Z'),
    errors: [],
    peers: [
      {
        peerAddress: '200.150.1.193',
        stateCode: 6,
        state: 'ESTABLISHED',
        established: true,
        receivedPrefixes: 1_099_912,
      },
    ],
  };
}

function repository(): BgpRepository {
  return {
    saveCollection: vi.fn().mockResolvedValue(undefined),
    saveDiscovery: vi.fn().mockResolvedValue(undefined),
    listDashboardPeers: vi.fn().mockResolvedValue([]),
    getPeerDetail: vi.fn().mockResolvedValue(null),
    getPeerHistory: vi.fn().mockResolvedValue(null),
    listAlerts: vi.fn().mockResolvedValue({ active: [], resolved: [] }),
  };
}

describe('BgpPollingService', () => {
  it('collects and persists peers with the device SNMP target', async () => {
    const result = collection();
    const collector = { collect: vi.fn().mockResolvedValue(result) };
    const persistence = repository();
    const service = new BgpPollingService(
      collector as unknown as HuaweiBgpSnmpCollector,
      persistence,
    );

    await expect(service.poll(device(), 'protected-community')).resolves.toEqual({
      collectedAt: result.collectedAt.toISOString(),
      peers: 1,
      error: null,
    });
    expect(collector.collect).toHaveBeenCalledWith('192.0.2.1', {
      community: 'protected-community',
      version: 'v2c',
      port: 161,
    });
    expect(persistence.saveCollection).toHaveBeenCalledWith('ne8000-1', result);
  });

  it('coalesces concurrent polls for the same device', async () => {
    let release!: (value: HuaweiBgpCollection) => void;
    const pending = new Promise<HuaweiBgpCollection>((resolve) => {
      release = resolve;
    });
    const collector = { collect: vi.fn().mockReturnValue(pending) };
    const persistence = repository();
    const service = new BgpPollingService(
      collector as unknown as HuaweiBgpSnmpCollector,
      persistence,
    );

    const first = service.poll(device(), 'public');
    const second = service.poll(device(), 'public');
    release(collection());
    await Promise.all([first, second]);

    expect(collector.collect).toHaveBeenCalledTimes(1);
    expect(persistence.saveCollection).toHaveBeenCalledTimes(1);
  });

  it('isolates collection failures and does not persist a partial transaction', async () => {
    const collector = { collect: vi.fn().mockRejectedValue(new Error('BGP unavailable')) };
    const persistence = repository();
    const service = new BgpPollingService(
      collector as unknown as HuaweiBgpSnmpCollector,
      persistence,
    );

    await expect(service.poll(device(), 'public')).resolves.toMatchObject({
      peers: 0,
      error: 'BGP unavailable',
    });
    expect(persistence.saveCollection).not.toHaveBeenCalled();
  });
});
