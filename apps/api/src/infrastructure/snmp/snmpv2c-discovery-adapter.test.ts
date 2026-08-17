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

  it('correlates Huawei entity DDM by interface name and converts microWatts to dBm', async () => {
    vi.spyOn(SnmpClientImpl.prototype, 'walk').mockImplementation(async (_host, oid) => {
      if (oid === '1.3.6.1.2.1.47.1.1.1.1.7') {
        return [{ oid: `${oid}.9001`, value: new Uint8Array(Buffer.from('Optical module 100GE 0/0/1')) }];
      }
      if (oid === '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.8') {
        return [{ oid: `${oid}.9001`, value: 500 }];
      }
      if (oid === '1.3.6.1.4.1.2011.5.25.31.1.1.3.1.9') {
        return [{ oid: `${oid}.9001`, value: 1000 }];
      }
      return [];
    });
    const adapter = new SnmpV2cDiscoveryAdapter({} as HostRepository);
    const networkInterface = {
      id: 'if-1', deviceId: baseHost.id, name: '100GE0/0/1', description: '100GE0/0/1', alias: '',
      ifIndex: 1, mac: '', mtu: 1500, speedBps: 100_000_000_000, adminStatus: 'UP' as const,
      operStatus: 'UP' as const, rxBps: 0, txBps: 0, rxUtilization: 0, txUtilization: 0,
      rxErrors: 0, txErrors: 0, rxDiscards: 0, txDiscards: 0, dataSources: ['SNMP' as const],
    };

    const [enriched] = await adapter.enrichOpticalPower(baseHost, [networkInterface], 'secret');
    expect(enriched).toMatchObject({
      rxPowerDbm: -3.01,
      txPowerDbm: 0,
      opticalSource: 'SNMP',
    });
    expect(enriched?.opticalUpdatedAt).toEqual(expect.any(String));
  });

  it('ignores invalid or sentinel-like Huawei optical values', async () => {
    vi.spyOn(SnmpClientImpl.prototype, 'walk').mockImplementation(async (_host, oid) => {
      if (oid === '1.3.6.1.2.1.47.1.1.1.1.7') {
        return [{ oid: `${oid}.9001`, value: '100GE0/0/1' }];
      }
      if (oid.includes('2011.5.25.31.1.1.3.1')) {
        return [{ oid: `${oid}.9001`, value: 2147483647 }];
      }
      return [];
    });
    const adapter = new SnmpV2cDiscoveryAdapter({} as HostRepository);
    const networkInterface = {
      id: 'if-1', deviceId: baseHost.id, name: '100GE0/0/1', description: '', alias: '', ifIndex: 1,
      mac: '', mtu: 1500, speedBps: 1, adminStatus: 'UP' as const, operStatus: 'UP' as const,
      rxBps: 0, txBps: 0, rxUtilization: 0, txUtilization: 0, rxErrors: 0, txErrors: 0,
      rxDiscards: 0, txDiscards: 0, dataSources: ['SNMP' as const],
    };
    expect(await adapter.enrichOpticalPower(baseHost, [networkInterface], 'secret')).toEqual([networkInterface]);
  });
});
