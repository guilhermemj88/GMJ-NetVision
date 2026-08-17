import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord, NetworkInterface } from '@gmj/shared';
import type { HostRepository } from '../persistence/host-repository';
import { SshClientImpl } from './ssh-client-impl';
import { SshInterfaceService } from './ssh-interface-service';

function device(): HostRecord {
  return {
    id: 'huawei-1', vendor: 'unknown', sshEnabled: true,
    ssh: { host: '10.0.0.1', port: 22, username: 'operator' },
  } as HostRecord;
}

function networkInterface(name: string, overrides: Partial<NetworkInterface> = {}): NetworkInterface {
  return {
    id: `if-${name}`, deviceId: 'huawei-1', name, description: name, alias: '', ifIndex: 1,
    mac: '', mtu: 1500, speedBps: 100_000_000_000, adminStatus: 'UP', operStatus: 'UP',
    rxBps: 0, txBps: 0, rxUtilization: 0, txUtilization: 0, rxErrors: 0, txErrors: 0,
    rxDiscards: 0, txDiscards: 0, dataSources: ['SNMP'], ...overrides,
  };
}

function service(): SshInterfaceService {
  return new SshInterfaceService({
    getDecryptedSshCredentials: vi.fn().mockResolvedValue({ password: 'not-logged' }),
  } as unknown as HostRepository);
}

describe('Huawei SSH interface enrichment', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not block the explicit Huawei command flow when vendor is unknown', async () => {
    vi.spyOn(SshClientImpl.prototype, 'execute').mockResolvedValue([{
      stdout: '100GE0/0/1 up up BHE-LIKEE-6730-MPLS-01', stderr: '', exitCode: 0,
    }]);
    await expect(service().testConnectivity(device())).resolves.toMatchObject({ state: 'CONNECTED' });
  });

  it('falls back per interface and never overwrites a valid SNMP reading', async () => {
    vi.spyOn(SshClientImpl.prototype, 'execute').mockResolvedValue([{
      stdout: `
100GE0/0/1 transceiver information:
  RX Power (dBm): -9.90
  TX Power (dBm): -9.80
100GE 0/0/2 transceiver information:
  Current RX Power (dBm): -4.20
  Current TX Power (dBm): -2.70
`, stderr: '', exitCode: 0,
    }]);
    const interfaces = [
      networkInterface('100GE0/0/1', {
        rxPowerDbm: -3.4, txPowerDbm: -2.1, opticalSource: 'SNMP',
        opticalUpdatedAt: new Date().toISOString(),
      }),
      networkInterface('100GE0/0/2', { ifIndex: 2 }),
      networkInterface('100GE0/0/3', { ifIndex: 3 }),
    ];

    const result = await service().enrichOpticalPower(device(), interfaces);
    expect(result[0]).toMatchObject({ rxPowerDbm: -3.4, txPowerDbm: -2.1, opticalSource: 'SNMP' });
    expect(result[1]).toMatchObject({ rxPowerDbm: -4.2, txPowerDbm: -2.7, opticalSource: 'SSH' });
    expect(result[1]?.opticalUpdatedAt).toEqual(expect.any(String));
    expect(result[2]?.opticalSource).toBeUndefined();
  });
});
