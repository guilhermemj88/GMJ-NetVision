import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostRecord, NetworkInterface } from '@gmj/shared';
import type { HostRepository, InterfaceOpticalThresholdRecord } from '../persistence/host-repository';
import { SshClientImpl } from './ssh-client-impl';
import { OpticalThresholdService } from './optical-threshold-service';

function networkInterface(name: string, overrides: Partial<NetworkInterface> = {}): NetworkInterface {
  return {
    id: `if-${name}`, deviceId: 'dev-1', name, description: name, alias: '', ifIndex: 1,
    mac: '', mtu: 1500, speedBps: 100_000_000_000, adminStatus: 'UP', operStatus: 'UP',
    rxBps: 0, txBps: 0, rxUtilization: 0, txUtilization: 0, rxErrors: 0, txErrors: 0,
    rxDiscards: 0, txDiscards: 0, dataSources: ['SNMP'], ...overrides,
  };
}

function lanes(laneIds: number[]): NetworkInterface['opticalLanes'] {
  return laneIds.map((lane) => ({ lane, rxPowerDbm: -9, txPowerDbm: 0.5 }));
}

function device(interfaces: NetworkInterface[], overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    id: 'dev-1', vendor: 'Huawei', sshEnabled: true,
    ssh: { host: '10.0.0.1', port: 22, username: 'operator' },
    interfaces,
    ...overrides,
  } as unknown as HostRecord;
}

interface RepositoryMock {
  repo: HostRepository;
  updateThresholds: ReturnType<typeof vi.fn>;
}

function repository(records: InterfaceOpticalThresholdRecord[] = []): RepositoryMock {
  const updateThresholds = vi.fn().mockResolvedValue(undefined);
  const repo = {
    getDecryptedSshCredentials: vi.fn().mockResolvedValue({ password: 'not-logged' }),
    getInterfaceOpticalThresholds: vi.fn().mockResolvedValue(records),
    updateInterfaceOpticalThresholds: updateThresholds,
  } as unknown as HostRepository;
  return { repo, updateThresholds: updateThresholds as ReturnType<typeof vi.fn> };
}

function record(overrides: Partial<InterfaceOpticalThresholdRecord> = {}): InterfaceOpticalThresholdRecord {
  return {
    interfaceId: 'if-100GE0/0/2',
    thresholds: null,
    source: null,
    updatedAt: new Date('2026-08-23T10:00:00.000Z'),
    refreshAfter: new Date('2026-08-24T10:00:00.000Z'),
    ...overrides,
  };
}

const NOW = new Date('2026-08-23T12:00:00.000Z').getTime();
const oneResult = (stdout: string) => [{ stdout, stderr: '', exitCode: 0 }];

function service(repo: HostRepository): OpticalThresholdService {
  return new OpticalThresholdService(repo, {
    refreshHours: 24, failureCooldownMs: 3_600_000, now: () => NOW,
  });
}

describe('OpticalThresholdService slow path', () => {
  afterEach(() => vi.restoreAllMocks());

  it('skips interfaces without any optical signal', async () => {
    const execute = vi.spyOn(SshClientImpl.prototype, 'execute');
    const { repo } = repository();
    await service(repo).refreshOpticalThresholds(device([networkInterface('GigabitEthernet0/0/1')]));
    expect(execute).not.toHaveBeenCalled();
    expect(repo.updateInterfaceOpticalThresholds).not.toHaveBeenCalled();
  });

  it('refreshes when no threshold was ever persisted, even with fresh SNMP power', async () => {
    const execute = vi.spyOn(SshClientImpl.prototype, 'execute').mockResolvedValue(oneResult(`
100GE0/0/2 transceiver information:
   Current RX Power (dBm) : -5.00
   User Set Thresholds:
     Rx Power High Alarm Threshold : -2.00
     Rx Power Low Alarm Threshold  : -13.00
`));
    const { repo, updateThresholds } = repository();
    await service(repo).refreshOpticalThresholds(
      device([networkInterface('100GE0/0/2', {
        rxPowerDbm: -8.5,
        txPowerDbm: 0.4,
        opticalSource: 'SNMP',
        opticalUpdatedAt: '2026-08-23T11:59:30.000Z',
        opticalLanes: lanes([0, 1, 2, 3]),
      })]),
    );

    expect(execute).toHaveBeenCalledWith('10.0.0.1', [
      'screen-length 0 temporary',
      'display transceiver diagnosis interface 100GE0/0/2',
      'display transceiver verbose',
    ]);
    const [deviceId, entries] = updateThresholds.mock.calls[0] as [string, Array<Record<string, never>>];
    expect(deviceId).toBe('dev-1');
    expect(entries).toHaveLength(1);
    const entry = entries[0] as unknown as {
      interfaceId: string;
      source: string | null;
      refreshAfter: Date;
      thresholds: {
        version: number;
        scalar: { rx: Record<string, unknown> };
        lanes: Array<{ lane: number }>;
      };
    };
    expect(entry.interfaceId).toBe('if-100GE0/0/2');
    expect(entry.source).toBe('USER');
    expect(entry.refreshAfter).toEqual(new Date(NOW + 24 * 3_600_000));
    expect(entry.thresholds.version).toBe(1);
    expect(entry.thresholds.scalar.rx).toEqual({
      lowAlarmDbm: -13, highAlarmDbm: -2, lowSource: 'USER', highSource: 'USER',
    });
    expect(entry.thresholds.lanes.map((lane) => lane.lane)).toEqual([0, 1, 2, 3]);
  });

  it('does not refresh before refreshAfter even when SNMP power is fresh', async () => {
    const execute = vi.spyOn(SshClientImpl.prototype, 'execute');
    const { repo } = repository([record()]);
    await service(repo).refreshOpticalThresholds(device([
      networkInterface('100GE0/0/2', {
        rxPowerDbm: -8.5,
        opticalSource: 'SNMP',
        opticalUpdatedAt: '2026-08-23T11:59:00.000Z',
      }),
    ]));
    expect(execute).not.toHaveBeenCalled();
  });

  it('refreshes again after refreshAfter expires', async () => {
    const execute = vi.spyOn(SshClientImpl.prototype, 'execute').mockResolvedValue(oneResult(`
100GE0/0/2 transceiver information:
   Rx Power High Alarm Threshold : -1.00
   Rx Power Low Alarm Threshold  : -14.00
`));
    const { repo, updateThresholds } = repository([
      record({ refreshAfter: new Date('2026-08-23T11:59:00.000Z') }),
    ]);
    await service(repo).refreshOpticalThresholds(device([networkInterface('100GE0/0/2')]));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(updateThresholds).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the observed lane layout changed', async () => {
    const execute = vi.spyOn(SshClientImpl.prototype, 'execute')
      .mockResolvedValue(oneResult('100GE0/0/2 transceiver information:\n   Current RX Power (dBm) : -9.00\n'));
    const { repo } = repository([
      record({
        thresholds: {
          version: 1,
          scalar: {
            rx: { lowAlarmDbm: -14, highAlarmDbm: -1, lowSource: 'DEVICE', highSource: 'DEVICE' },
            tx: { lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null },
          },
          lanes: [0, 1].map((lane) => ({
            lane,
            rx: { lowAlarmDbm: -14, highAlarmDbm: -1, lowSource: 'DEVICE' as const, highSource: 'DEVICE' as const },
            tx: { lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null },
          })),
        },
      }),
    ]);
    await service(repo).refreshOpticalThresholds(device([
      networkInterface('100GE0/0/2', { opticalLanes: lanes([0, 1, 2, 3]) }),
    ]));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('persists refreshAfter even when the equipment returns no thresholds at all', async () => {
    const execute = vi.spyOn(SshClientImpl.prototype, 'execute')
      .mockResolvedValue(oneResult('100GE0/0/2 transceiver information:\n   Current RX Power (dBm) : -9.00\n'));
    const { repo, updateThresholds } = repository();
    await service(repo).refreshOpticalThresholds(
      device([networkInterface('100GE0/0/2', { rxPowerDbm: -9 })]),
    );

    const [, entries] = updateThresholds.mock.calls[0] as [string, Array<{
      thresholds: unknown; source: string | null; refreshAfter: Date;
    }>];
    expect(entries[0]?.thresholds).toBeNull();
    expect(entries[0]?.source).toBeNull();
    expect(entries[0]?.refreshAfter).toEqual(new Date(NOW + 24 * 3_600_000));

    // O refreshAfter persistido evita que a mesma interface volte ao SSH em loop.
    execute.mockClear();
    const persisted = {
      interfaceId: 'if-100GE0/0/2',
      thresholds: null,
      source: null,
      updatedAt: new Date(NOW),
      refreshAfter: new Date(NOW + 24 * 3_600_000),
    } satisfies InterfaceOpticalThresholdRecord;
    const second = repository([persisted]);
    await service(second.repo).refreshOpticalThresholds(
      device([networkInterface('100GE0/0/2', { rxPowerDbm: -9 })]),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('records the observed lane layout even without lane thresholds', async () => {
    vi.spyOn(SshClientImpl.prototype, 'execute').mockResolvedValue(oneResult(`
100GE0/0/2 transceiver information:
   RxPower(dBm)      -12.10 (lane0)
                     -12.20 (lane1)
   TxPower(dBm)       0.20 (lane0)
                      0.30 (lane1)
`));
    const { repo, updateThresholds } = repository();
    await service(repo).refreshOpticalThresholds(
      device([networkInterface('100GE0/0/2', { opticalLanes: lanes([0, 1]) })]),
    );
    const [, entries] = updateThresholds.mock.calls[0] as [string, Array<{
      source: string | null;
      thresholds: { lanes: Array<{ lane: number }> } | null;
    }>];
    expect(entries[0]?.source).toBeNull();
    expect(entries[0]?.thresholds?.lanes).toEqual([
      {
        lane: 0,
        rx: { lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null },
        tx: { lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null },
      },
      {
        lane: 1,
        rx: { lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null },
        tx: { lowAlarmDbm: null, highAlarmDbm: null, lowSource: null, highSource: null },
      },
    ]);
  });

  it('applies a per-device cooldown after an SSH failure and never throws', async () => {
    const execute = vi.spyOn(SshClientImpl.prototype, 'execute')
      .mockRejectedValue(new Error('SSH command timeout'));
    const { repo, updateThresholds } = repository();
    const svc = service(repo);
    await expect(svc.refreshOpticalThresholds(device([networkInterface('100GE0/0/2')])))
      .resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);

    execute.mockClear();
    await svc.refreshOpticalThresholds(device([networkInterface('100GE0/0/2')]));
    expect(execute).not.toHaveBeenCalled();
    expect(updateThresholds).not.toHaveBeenCalled();
  });

  it('keeps the command list inside the configured cap', async () => {
    const execute = vi.spyOn(SshClientImpl.prototype, 'execute').mockResolvedValue(oneResult(''));
    const { repo } = repository();
    const svc = new OpticalThresholdService(repo, {
      refreshHours: 24, failureCooldownMs: 3_600_000, maxCommands: 4, now: () => NOW,
    });
    await svc.refreshOpticalThresholds(device([
      networkInterface('100GE0/0/1', { rxPowerDbm: -5 }),
      networkInterface('100GE0/0/2', { rxPowerDbm: -5 }),
      networkInterface('100GE0/0/3', { rxPowerDbm: -5 }),
    ]));
    const commands = execute.mock.calls[0]?.[1] ?? [];
    expect(commands).toEqual([
      'screen-length 0 temporary',
      'display transceiver diagnosis interface 100GE0/0/1',
      'display transceiver diagnosis interface 100GE0/0/2',
      'display transceiver verbose',
    ]);
  });

  it('does not run when SSH is disabled for the host', async () => {
    const execute = vi.spyOn(SshClientImpl.prototype, 'execute');
    const { repo } = repository();
    await service(repo).refreshOpticalThresholds(device([networkInterface('100GE0/0/2')], {
      sshEnabled: false,
    }));
    expect(execute).not.toHaveBeenCalled();
  });

  it('never lets a repository failure escape the slow path', async () => {
    const execute = vi.spyOn(SshClientImpl.prototype, 'execute');
    const repo = {
      getDecryptedSshCredentials: vi.fn().mockResolvedValue({ password: 'not-logged' }),
      getInterfaceOpticalThresholds: vi.fn().mockRejectedValue(new Error('database offline')),
      updateInterfaceOpticalThresholds: vi.fn(),
    } as unknown as HostRepository;
    await expect(service(repo).refreshOpticalThresholds(device([networkInterface('100GE0/0/2')])))
      .resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
});
