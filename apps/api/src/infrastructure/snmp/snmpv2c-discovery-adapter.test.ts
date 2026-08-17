import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord } from '@gmj/shared';
import type { HostRepository } from '../persistence/host-repository';
import { SnmpClientImpl } from './snmp-client-impl';
import { SnmpV2cDiscoveryAdapter } from './snmpv2c-discovery-adapter';

const baseHost = {
  id: 'huawei-1', vendor: 'Huawei', interfaces: [], snmpEnabled: true,
  snmp: { host: '10.0.0.1', port: 161 },
} as unknown as HostRecord;

describe('SNMP IF-MIB interface discovery', () => {
  afterEach(() => vi.restoreAllMocks());

  it('preserves ifName, ifDescr and ifAlias and decodes Uint8Array text', async () => {
    vi.spyOn(SnmpClientImpl.prototype, 'walk').mockImplementation(async (_host, oid) => {
      const row = (value: string | number | Uint8Array) => [{ oid: `${oid}.501`, value }];
      if (oid === '1.3.6.1.2.1.2.2.1.1') return row(501);
      if (oid === '1.3.6.1.2.1.31.1.1.1.1') return row(new Uint8Array(Buffer.from('100GE0/0/1')));
      if (oid === '1.3.6.1.2.1.2.2.1.2') return row(new Uint8Array(Buffer.from('Huawei 100GE interface')));
      if (oid === '1.3.6.1.2.1.2.2.1.7') return row(1);
      if (oid === '1.3.6.1.2.1.2.2.1.8') return row(1);
      if (oid === '1.3.6.1.2.1.31.1.1.1.15') return row(100_000);
      if (oid === '1.3.6.1.2.1.31.1.1.1.18') return row(new Uint8Array(Buffer.from('BHE-LIKEE-6730-MPLS-01')));
      if (oid === '1.3.6.1.2.1.2.2.1.6') return row(new Uint8Array([0, 17, 34, 51, 68, 85]));
      return [];
    });
    const repository = {
      getDecryptedSnmpCredentials: vi.fn().mockResolvedValue({ community: 'secret' }),
    } as unknown as HostRepository;

    const [networkInterface] = await new SnmpV2cDiscoveryAdapter(repository)
      .discoverInterfaces(baseHost, 'secret');

    expect(networkInterface).toMatchObject({
      ifIndex: 501,
      name: '100GE0/0/1',
      description: 'Huawei 100GE interface',
      alias: 'BHE-LIKEE-6730-MPLS-01',
      speedBps: 100_000_000_000,
      adminStatus: 'UP',
      operStatus: 'UP',
      mac: '00:11:22:33:44:55',
      dataSources: ['SNMP'],
    });
    expect(networkInterface?.name).not.toContain(',');
    expect(networkInterface?.alias).not.toContain(',');
  });
});
