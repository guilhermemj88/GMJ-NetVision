import { cloneDemoMaps, type NetworkInterface } from '@gmj/shared';
import { describe, expect, it, vi } from 'vitest';
import { PrismaMapRepository } from './prisma-map-repository';
import type { HostRepository } from './host-repository';

const db = vi.hoisted(() => ({
  findMap: vi.fn(),
  createLink: vi.fn(),
  updateLink: vi.fn(),
  findLink: vi.fn(),
}));
vi.mock('../../generated/prisma/index.js', () => ({
  PrismaClient: class {
    map = { findUnique: db.findMap };
    link = { create: db.createLink, updateMany: db.updateLink, findUnique: db.findLink };
  },
  Prisma: {},
}));

describe.each(['SOURCE', 'TARGET'] as const)('Prisma SINGLE_ENDED %s materialization', (side) => {
  it.each(['UP', 'DOWN', 'DISABLED', 'UNKNOWN'] as const)(
    'derives %s from the real interface on create, edit and reload',
    async (operStatus) => {
      const map = cloneDemoMaps()[0]!;
      const host = map.devices[0]!;
      const real: NetworkInterface = {
        ...host.interfaces[0]!,
        operStatus,
        telemetryAvailable: true,
        rxBps: 2000,
        txBps: 5000,
      };
      host.interfaces = [real];
      const input = {
        ...map.links[0]!,
        sourceDeviceId: side === 'SOURCE' ? host.id : null,
        targetDeviceId: side === 'TARGET' ? host.id : null,
        sourceNodeId: side === 'TARGET' ? 'carrier' : null,
        targetNodeId: side === 'SOURCE' ? 'carrier' : null,
        sourceInterfaceId: side === 'SOURCE' ? real.id : null,
        targetInterfaceId: side === 'TARGET' ? real.id : null,
        trafficMode: 'SINGLE_ENDED' as const,
        trafficColorAToB: '#112233',
        trafficColorBToA: '#abcdef',
        customColor: '#123456',
        visualPaths: [
          { order: 0, label: 'Carrier', curvature: 175, enabled: true, customColor: null },
        ],
        aggregationMode: 'NONE' as const,
        metricSources: [],
        capacitySource: 'AUTO' as const,
      };
      const row = {
        ...input,
        status: 'UNKNOWN',
        capacityBps: BigInt(input.capacityBps),
        autoCapacityBps: BigInt(input.autoCapacityBps),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      db.findMap.mockResolvedValue({
        ...map,
        ...map.settings,
        nodes: [],
        widgets: [],
        links: [row],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      db.createLink.mockResolvedValue(row);
      db.updateLink.mockResolvedValue({ count: 1 });
      db.findLink.mockResolvedValue(row);
      const hosts = { listHosts: vi.fn().mockResolvedValue([host]) };
      const repository = new PrismaMapRepository(hosts as unknown as HostRepository);
      const created = await repository.createDiscoveredLink(map.id, input, 'MANUAL');
      const edited = await repository.updateLink(map.id, input.id, input);
      const reloaded = (await repository.getMap(map.id))!.links[0]!;
      for (const link of [created, edited, reloaded]) {
        expect(link).toMatchObject({
          status: operStatus === 'DISABLED' ? 'DOWN' : operStatus,
          trafficMode: 'SINGLE_ENDED',
          capacityBps: real.speedBps,
          rxBps: 2000,
          txBps: 5000,
          trafficColorAToB: '#112233',
          trafficColorBToA: '#abcdef',
          customColor: '#123456',
          visualPaths: input.visualPaths,
        });
        expect(link!.directions.A_TO_B.bps).toBe(side === 'SOURCE' ? 5000 : 2000);
        expect(link!.directions.B_TO_A.bps).toBe(side === 'SOURCE' ? 2000 : 5000);
      }
      expect(db.createLink.mock.lastCall?.[0].data).toMatchObject({
        sourceDeviceId: input.sourceDeviceId,
        targetDeviceId: input.targetDeviceId,
        sourceNodeId: input.sourceNodeId,
        targetNodeId: input.targetNodeId,
      });
    },
  );
});
