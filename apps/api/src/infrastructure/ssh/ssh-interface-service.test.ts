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

const freshAfter = new Date('2026-08-23T12:00:00.000Z');
const freshSnmp = {
  rxPowerDbm: -12.08,
  txPowerDbm: 0.2,
  opticalSource: 'SNMP' as const,
  opticalUpdatedAt: '2026-08-23T12:00:01.000Z',
};

function multiLaneOutput(name: string): string {
  return `
Port ${name} transceiver diagnostic information:
TxPower(dBm)       1.50 (lane0)
                   2.14 (lane1)
                   2.01 (lane2)
                   1.97 (lane3)
RxPower(dBm)     -18.12 (lane0)
                 -16.95 (lane1)
                 -16.25 (lane2)
                  -2.17 (lane3)
Current(mA)       62.07 (lane0)
                  63.05 (lane1)
                  62.72 (lane2)
                  63.05 (lane3)
`;
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

  it('queries a 100GE diagnostic when SNMP scalar power is fresh but lanes are absent', async () => {
    const execute = vi.spyOn(SshClientImpl.prototype, 'execute').mockResolvedValue([{
      stdout: multiLaneOutput('100GE0/0/2'), stderr: '', exitCode: 0,
    }]);
    const interfaces = [networkInterface('100GE0/0/2', freshSnmp)];

    const result = await service().enrichOpticalPower(device(), interfaces, freshAfter);

    expect(execute).toHaveBeenCalledWith('10.0.0.1', [
      'screen-length 0 temporary',
      'display transceiver diagnosis interface 100GE0/0/2',
    ]);
    expect(result[0]?.opticalLanes).toHaveLength(4);
    expect(result[0]?.dataSources).toEqual(['SNMP', 'SSH']);
  });

  it('queries a 40GE diagnostic when SNMP scalar power is fresh but lanes are absent', async () => {
    const execute = vi.spyOn(SshClientImpl.prototype, 'execute').mockResolvedValue([{
      stdout: multiLaneOutput('40GE0/0/1'), stderr: '', exitCode: 0,
    }]);

    const result = await service().enrichOpticalPower(
      device(),
      [networkInterface('40GE0/0/1', freshSnmp)],
      freshAfter,
    );

    expect(execute.mock.calls[0]?.[1]).toContain(
      'display transceiver diagnosis interface 40GE0/0/1',
    );
    expect(result[0]?.opticalLanes).toHaveLength(4);
  });

  it('does not query SSH for a fresh single-lane 10GE interface', async () => {
    const execute = vi.spyOn(SshClientImpl.prototype, 'execute');
    const interfaces = [networkInterface('10GE0/0/1', freshSnmp)];

    await expect(service().enrichOpticalPower(device(), interfaces, freshAfter))
      .resolves.toEqual(interfaces);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not query a 100GE interface that already has valid lane data', async () => {
    const execute = vi.spyOn(SshClientImpl.prototype, 'execute');
    const interfaces = [networkInterface('100GE0/0/2', {
      ...freshSnmp,
      opticalLanes: [
        { lane: 0, rxPowerDbm: -12, txPowerDbm: 0.1 },
        { lane: 1, rxPowerDbm: -13, txPowerDbm: 0.2 },
        { lane: 2, rxPowerDbm: -14, txPowerDbm: 0.3 },
        { lane: 3, rxPowerDbm: -15, txPowerDbm: 0.4 },
      ],
    })];

    await expect(service().enrichOpticalPower(device(), interfaces, freshAfter))
      .resolves.toEqual(interfaces);
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves SNMP optics and returns normally when the 100GE SSH command fails', async () => {
    vi.spyOn(SshClientImpl.prototype, 'execute').mockRejectedValue(new Error('SSH command timeout'));
    const interfaces = [networkInterface('100GE0/0/2', freshSnmp)];

    await expect(service().enrichOpticalPower(device(), interfaces, freshAfter))
      .resolves.toEqual(interfaces);
  });

  it('keeps fresh SNMP scalar RX/TX while accepting SSH lanes', async () => {
    vi.spyOn(SshClientImpl.prototype, 'execute').mockResolvedValue([{
      stdout: multiLaneOutput('100GE0/0/2'), stderr: '', exitCode: 0,
    }]);

    const [result] = await service().enrichOpticalPower(
      device(),
      [networkInterface('100GE0/0/2', freshSnmp)],
      freshAfter,
    );

    expect(result).toMatchObject({
      rxPowerDbm: -12.08,
      txPowerDbm: 0.2,
      opticalSource: 'SNMP',
    });
    expect(result?.opticalLanes?.[0]).toMatchObject({
      lane: 0,
      rxPowerDbm: -18.12,
      txPowerDbm: 1.5,
    });
  });
});
