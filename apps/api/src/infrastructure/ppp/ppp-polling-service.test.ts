import { describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import { makeHost } from '../../test-fixtures';
import type { PppRepository } from './ppp-repository';
import { PppPollingService } from './ppp-polling-service';

function makeClient(rows: Array<{ oid: string; value: string | number | Uint8Array }>) {
  return { get: vi.fn().mockResolvedValue(rows) };
}

function makeRepository(): PppRepository & {
  saveReading: ReturnType<typeof vi.fn>;
  markUnsupported: ReturnType<typeof vi.fn>;
  saveFailure: ReturnType<typeof vi.fn>;
} {
  return {
    saveReading: vi.fn().mockResolvedValue(undefined),
    markUnsupported: vi.fn().mockResolvedValue(undefined),
    saveFailure: vi.fn().mockResolvedValue(undefined),
  };
}

function huaweiHost(): HostRecord {
  return makeHost({
    id: 'huawei-ppp',
    hostname: 'NE40-BRAS-01',
    vendor: 'Huawei',
    model: 'NE40E-X8A',
    snmpEnabled: true,
    snmp: {
      version: 'SNMP_V2C',
      host: '10.100.101.8',
      port: 161,
      username: '',
      securityLevel: 'NO_AUTH_NO_PRIV',
      authProtocol: null,
      privacyProtocol: null,
      credentialConfigured: true,
    },
  });
}

describe('PppPollingService', () => {
  it('reads the Huawei PPP online OID and persists a valid reading', async () => {
    const client = makeClient([{ oid: '1.3.6.1.4.1.2011.5.2.1.14.1.2.0', value: 12_438 }]);
    const repository = makeRepository();
    const service = new PppPollingService(client, repository);

    const result = await service.poll(huaweiHost(), 'community', {
      vendor: 'Huawei',
      sysObjectId: '1.3.6.1.4.1.2011.2.23.1',
    });

    expect(result).toMatchObject({ supported: true, error: null });
    expect(client.get).toHaveBeenCalledWith(
      '10.100.101.8',
      ['1.3.6.1.4.1.2011.5.2.1.14.1.2.0'],
      expect.objectContaining({ community: 'community' }),
    );
    expect(repository.saveReading).toHaveBeenCalledWith('huawei-ppp', {
      supported: true,
      online: 12_438,
      source: 'SNMP_HUAWEI',
      updatedAt: expect.any(Date),
    });
  });

  it('reads the MikroTik PPP online OID and tags the source as SNMP_MIKROTIK', async () => {
    const client = makeClient([{ oid: '1.3.6.1.4.1.9.9.150.1.1.1.0', value: 2_048 }]);
    const repository = makeRepository();
    const service = new PppPollingService(client, repository);
    const host = makeHost({
      id: 'mikrotik-ppp',
      hostname: 'CCR-BNG-01',
      vendor: 'MikroTik',
      model: 'CCR1036',
      snmpEnabled: true,
      snmp: {
        version: 'SNMP_V2C',
        host: '10.100.101.9',
        port: 161,
        username: '',
        securityLevel: 'NO_AUTH_NO_PRIV',
        authProtocol: null,
        privacyProtocol: null,
        credentialConfigured: true,
      },
    });

    await service.poll(host, 'community', {
      vendor: 'MikroTik',
      sysDescr: 'RouterOS CCR1036-8G-2S+',
    });

    expect(repository.saveReading).toHaveBeenCalledWith('mikrotik-ppp', {
      supported: true,
      online: 2_048,
      source: 'SNMP_MIKROTIK',
      updatedAt: expect.any(Date),
    });
  });

  it('treats zero as a valid reading (never a timeout)', async () => {
    const client = makeClient([{ oid: '1.3.6.1.4.1.2011.5.2.1.14.1.2.0', value: 0 }]);
    const repository = makeRepository();
    const service = new PppPollingService(client, repository);

    const result = await service.poll(huaweiHost(), 'community', { vendor: 'Huawei' });

    expect(result.supported).toBe(true);
    expect(repository.saveReading).toHaveBeenCalledWith('huawei-ppp', {
      supported: true,
      online: 0,
      source: 'SNMP_HUAWEI',
      updatedAt: expect.any(Date),
    });
    expect(repository.saveFailure).not.toHaveBeenCalled();
  });

  it('preserves the last valid value on timeout (never turns it into zero)', async () => {
    const client = { get: vi.fn().mockRejectedValue(new Error('SNMP timeout')) };
    const repository = makeRepository();
    const service = new PppPollingService(client, repository);

    const result = await service.poll(huaweiHost(), 'community', { vendor: 'Huawei' });

    expect(result).toMatchObject({ supported: null, error: 'SNMP timeout' });
    expect(repository.saveReading).not.toHaveBeenCalled();
    expect(repository.saveFailure).toHaveBeenCalledWith('huawei-ppp', expect.any(Date), 'SNMP timeout');
  });

  it('marks unsupported when the selected profile has no PPP OID', async () => {
    const client = makeClient([]);
    const repository = makeRepository();
    const service = new PppPollingService(client, repository);

    const result = await service.poll(huaweiHost(), 'community', { vendor: 'Juniper' });

    expect(result).toMatchObject({ supported: false, error: null });
    expect(repository.markUnsupported).toHaveBeenCalledWith('huawei-ppp', expect.any(Date));
    expect(repository.saveReading).not.toHaveBeenCalled();
  });
});
