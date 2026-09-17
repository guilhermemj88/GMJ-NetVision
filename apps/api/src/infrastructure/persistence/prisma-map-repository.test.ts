import { cloneDemoMaps, type NetworkInterface } from '@gmj/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaMapRepository } from './prisma-map-repository';
import type { HostRepository } from './host-repository';

const db = vi.hoisted(() => ({
  findMap: vi.fn(),
  createLink: vi.fn(),
  updateLink: vi.fn(),
  findLink: vi.fn(),
  updateNode: vi.fn(),
  findNode: vi.fn(),
}));
vi.mock('../../generated/prisma/index.js', () => ({
  PrismaClient: class {
    map = { findUnique: db.findMap };
    link = { create: db.createLink, updateMany: db.updateLink, findUnique: db.findLink };
    mapNode = { updateMany: db.updateNode, findUnique: db.findNode };
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

describe('Prisma conceptual node updates', () => {
  const hosts = { listHosts: vi.fn().mockResolvedValue([]) };
  const repository = () => new PrismaMapRepository(hosts as unknown as HostRepository);
  const row = {
    id: 'carrier-1',
    mapId: 'backbone-main',
    deviceId: null,
    nodeKind: 'GENERIC',
    genericType: 'DATACENTER',
    label: 'Operadora B',
    x: 512.5,
    y: 348.25,
    locked: true,
    positionSource: 'MANUAL',
    pppDisplayMode: 'AUTO',
    pppPosition: 'BOTTOM',
    pppColor: null,
    pppFontSize: 14,
  };

  beforeEach(() => vi.clearAllMocks());

  it('filters by GENERIC and writes only the editable fields', async () => {
    db.updateNode.mockResolvedValue({ count: 1 });
    db.findNode.mockResolvedValue(row);

    const node = await repository().updateConceptualNode('backbone-main', 'carrier-1', {
      label: 'Operadora B',
      genericType: 'DATACENTER',
      locked: true,
    });

    expect(db.updateNode).toHaveBeenCalledWith({
      where: { id: 'carrier-1', mapId: 'backbone-main', nodeKind: 'GENERIC' },
      data: { label: 'Operadora B', genericType: 'DATACENTER', locked: true },
    });
    // position, deviceId and the PPP options are never part of the payload
    expect(Object.keys(db.updateNode.mock.calls[0]![0].data).sort()).toEqual([
      'genericType',
      'label',
      'locked',
    ]);
    expect(node).toMatchObject({
      id: 'carrier-1',
      mapId: 'backbone-main',
      deviceId: null,
      nodeKind: 'GENERIC',
      genericType: 'DATACENTER',
      label: 'Operadora B',
      locked: true,
      position: { x: 512.5, y: 348.25 },
      positionSource: 'MANUAL',
    });
  });

  it('omits absent fields so a partial edit keeps the stored values', async () => {
    db.updateNode.mockResolvedValue({ count: 1 });
    db.findNode.mockResolvedValue({ ...row, locked: false });

    await repository().updateConceptualNode('backbone-main', 'carrier-1', { locked: false });

    expect(db.updateNode).toHaveBeenCalledWith({
      where: { id: 'carrier-1', mapId: 'backbone-main', nodeKind: 'GENERIC' },
      data: { locked: false },
    });
  });

  it('never reports a DEVICE node as updated', async () => {
    db.updateNode.mockResolvedValue({ count: 0 });

    const node = await repository().updateConceptualNode('backbone-main', 'device-node-1', {
      label: 'Nope',
      locked: true,
    });

    expect(node).toBeNull();
    expect(db.updateNode).toHaveBeenCalledWith({
      where: { id: 'device-node-1', mapId: 'backbone-main', nodeKind: 'GENERIC' },
      data: { label: 'Nope', locked: true },
    });
    expect(db.findNode).not.toHaveBeenCalled();
  });
});

describe('Prisma link connection sides', () => {
  const base = () => {
    const map = cloneDemoMaps()[0]!;
    return { map, link: map.links[0]! };
  };

  function linkRow(overrides: Record<string, unknown>) {
    const { link } = base();
    return {
      ...link,
      capacityBps: BigInt(link.capacityBps),
      autoCapacityBps: BigInt(link.autoCapacityBps),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function repository() {
    return new PrismaMapRepository({
      listHosts: vi.fn().mockResolvedValue(base().map.devices),
    } as unknown as HostRepository);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    const { map } = base();
    db.findMap.mockResolvedValue({
      ...map,
      ...map.settings,
      nodes: [],
      widgets: [],
      links: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    db.updateLink.mockResolvedValue({ count: 1 });
    db.createLink.mockImplementation(async (args: { data: Record<string, unknown> }) =>
      linkRow(args.data),
    );
  });

  it('writes the sides on create and defaults them to AUTO when omitted', async () => {
    const { map, link } = base();
    await repository().createDiscoveredLink(
      map.id,
      { ...link, sourceHandleSide: 'BOTTOM', targetHandleSide: 'TOP' },
      'MANUAL',
    );
    expect(db.createLink.mock.lastCall?.[0].data).toMatchObject({
      sourceHandleSide: 'BOTTOM',
      targetHandleSide: 'TOP',
    });

    await repository().createDiscoveredLink(map.id, { ...link }, 'MANUAL');
    expect(db.createLink.mock.lastCall?.[0].data).toMatchObject({
      sourceHandleSide: 'AUTO',
      targetHandleSide: 'AUTO',
    });
  });

  it('persists a side change without rewriting the endpoints or the geometry', async () => {
    const { map, link } = base();
    db.findLink.mockResolvedValue(linkRow({ sourceHandleSide: 'RIGHT' }));

    const updated = await repository().updateLink(map.id, link.id, {
      capacityBps: link.capacityBps,
      autoCapacityBps: link.autoCapacityBps,
      capacitySource: link.capacitySource,
      label: link.label,
      metricSource: link.metricSource,
      visualStyle: link.visualStyle,
      metricDisplay: link.metricDisplay,
      sourceHandleSide: 'RIGHT',
    });

    expect(db.updateLink.mock.lastCall?.[0].data).toMatchObject({ sourceHandleSide: 'RIGHT' });
    expect(db.updateLink.mock.lastCall?.[0].data).not.toHaveProperty('targetHandleSide');
    expect(updated).toMatchObject({
      id: link.id,
      sourceDeviceId: link.sourceDeviceId,
      targetDeviceId: link.targetDeviceId,
      sourceHandleSide: 'RIGHT',
      targetHandleSide: 'AUTO',
      visualPaths: link.visualPaths,
    });
  });

  it('normalizes legacy or unknown stored values to AUTO on read', async () => {
    const { map } = base();
    db.findMap.mockResolvedValue({
      ...map,
      ...map.settings,
      nodes: [],
      widgets: [],
      links: [
        linkRow({ id: 'legacy', sourceHandleSide: null, targetHandleSide: undefined }),
        linkRow({ id: 'unknown', sourceHandleSide: 'SIDEWAYS', targetHandleSide: 'top' }),
        linkRow({ id: 'manual', sourceHandleSide: 'LEFT', targetHandleSide: 'BOTTOM' }),
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const links = (await repository().getMap(map.id))!.links;
    expect(links.find((item) => item.id === 'legacy')).toMatchObject({
      sourceHandleSide: 'AUTO',
      targetHandleSide: 'AUTO',
    });
    expect(links.find((item) => item.id === 'unknown')).toMatchObject({
      sourceHandleSide: 'AUTO',
      targetHandleSide: 'AUTO',
    });
    expect(links.find((item) => item.id === 'manual')).toMatchObject({
      sourceHandleSide: 'LEFT',
      targetHandleSide: 'BOTTOM',
    });
  });
});
