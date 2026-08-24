import { describe, expect, it, vi } from 'vitest';
import type { NetworkInterface } from '@gmj/shared';
import { PrismaHostRepository } from './prisma-host-repository';

function opticalInterface(): NetworkInterface {
  return {
    id: 'if-40ge', deviceId: 'device-1', name: '40GE0/0/1', alias: '', description: '',
    ifIndex: 1, mac: '', mtu: 1500, speedBps: 40_000_000_000,
    adminStatus: 'UP', operStatus: 'UP', rxBps: 0, txBps: 0,
    rxUtilization: 0, txUtilization: 0, rxErrors: 0, txErrors: 0,
    rxDiscards: 0, txDiscards: 0,
    rxPowerDbm: -12.01, txPowerDbm: 0.17,
    opticalSource: 'SNMP', opticalUpdatedAt: '2026-08-23T12:00:01.000Z',
    opticalLaneSource: 'SSH', opticalLanesUpdatedAt: '2026-08-23T12:00:02.000Z',
    opticalLanes: [0, 1, 2, 3].map((lane) => ({
      lane,
      rxPowerDbm: -12 + lane,
      txPowerDbm: 0.2 + lane,
    })),
    dataSources: ['SNMP', 'SSH'],
  };
}

describe('PrismaHostRepository optical persistence', () => {
  it('persists one combined SNMP scalar plus SSH lane sample per interface and execution', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    const transactionClient = {
      interface: { updateMany },
      interfaceOpticalSample: { createMany },
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (tx: typeof transactionClient) => Promise<void>) =>
        operation(transactionClient)),
    };
    const repository = new PrismaHostRepository(prisma as never, null);
    const networkInterface = opticalInterface();

    await repository.updateInterfaceOptics(
      'device-1',
      [networkInterface, { ...networkInterface, id: 'duplicate-id-for-same-ifindex' }],
      new Date('2026-08-23T12:00:00.000Z'),
    );

    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(createMany).toHaveBeenCalledTimes(1);
    const data = createMany.mock.calls[0]?.[0]?.data;
    expect(data).toHaveLength(1);
    expect(data?.[0]).toMatchObject({
      interfaceId: 'if-40ge',
      rxPowerDbm: -12.01,
      txPowerDbm: 0.17,
      opticalLanes: expect.arrayContaining([
        expect.objectContaining({ lane: 3, rxPowerDbm: -9, txPowerDbm: 3.2 }),
      ]),
    });
  });

  it('does not persist a history sample when this execution collected no useful optics', async () => {
    const transactionClient = {
      interface: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      interfaceOpticalSample: { createMany: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (tx: typeof transactionClient) => Promise<void>) =>
        operation(transactionClient)),
    };
    const repository = new PrismaHostRepository(prisma as never, null);
    const stale = {
      ...opticalInterface(),
      opticalUpdatedAt: '2026-08-23T11:00:00.000Z',
      opticalLanesUpdatedAt: '2026-08-23T11:00:00.000Z',
    };

    await repository.updateInterfaceOptics(
      'device-1',
      [stale],
      new Date('2026-08-23T12:00:00.000Z'),
    );

    expect(transactionClient.interfaceOpticalSample.createMany).not.toHaveBeenCalled();
  });
});

describe('PrismaHostRepository interface status persistence', () => {
  it('updates statuses by host and ifIndex without overwriting a missing operStatus', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const transactionClient = { interface: { updateMany } };
    const prisma = {
      $transaction: vi.fn(async (operation: (tx: typeof transactionClient) => Promise<void>) =>
        operation(transactionClient)),
    };
    const repository = new PrismaHostRepository(prisma as never, null);

    await repository.updateInterfaceStatuses('device-1', [
      { ifIndex: 23, adminStatus: 'UP', operStatus: 'UP' },
      { ifIndex: 24, adminStatus: 'UP' },
    ]);

    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { deviceId: 'device-1', ifIndex: 23 },
      data: { adminStatus: 'UP', operStatus: 'UP' },
    });
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: { deviceId: 'device-1', ifIndex: 24 },
      data: { adminStatus: 'UP' },
    });
  });
});
