import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { registerPhysicalRoutes } from './physical-routes';
import { DemoPhysicalRepository } from './infrastructure/physical/demo-physical-repository';
import { PhysicalInventoryError } from './infrastructure/physical/physical-repository';
import { DemoHostRepositoryAdapter } from './infrastructure/persistence/demo-host-repository-adapter';
import { DemoMapRepository } from './infrastructure/persistence/demo-map-repository';
import type { Role } from '@gmj/shared';

async function buildPhysicalApp(role?: Role): Promise<FastifyInstance> {
  const app = Fastify();
  const hosts = new DemoHostRepositoryAdapter(new DemoMapRepository());
  registerPhysicalRoutes(app, {
    repository: new DemoPhysicalRepository(hosts),
    enforcePermissions: Boolean(role),
    ...(role
      ? { currentUser: async () => ({ id: 'user-1', username: 'user', email: 'user@example.test', name: 'User', role }) }
      : {}),
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ message: 'Invalid request' });
    if (error instanceof PhysicalInventoryError) {
      return reply.code(error.statusCode).send({ message: error.message });
    }
    return reply.code(500).send({ message: error instanceof Error ? error.message : 'Unknown error' });
  });
  await app.ready();
  return app;
}

describe('physical inventory REST API', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildPhysicalApp();
  });

  afterEach(async () => {
    await app.close();
  });

  async function createRack(units = 42) {
    const site = await app.inject({
      method: 'POST',
      url: '/api/physical/sites',
      payload: { name: 'POP Centro', code: 'CTO' },
    });
    expect(site.statusCode).toBe(201);
    const rack = await app.inject({
      method: 'POST',
      url: `/api/physical/sites/${site.json().id}/racks`,
      payload: { name: 'Rack 01', units },
    });
    expect(rack.statusCode).toBe(201);
    return rack.json() as { id: string };
  }

  it('creates a POP, rack and generic equipment with persistent ports', async () => {
    const rack = await createRack();
    const response = await app.inject({
      method: 'POST',
      url: `/api/physical/racks/${rack.id}/assets`,
      payload: {
        name: 'Equipamento genérico',
        kind: 'GENERIC',
        startU: 10,
        heightU: 2,
        genericPorts: { count: 6, prefix: 'LAN', type: 'RJ45' },
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ startU: 10, heightU: 2 });
    expect(response.json().ports.map((port: { name: string }) => port.name)).toEqual([
      'LAN1',
      'LAN2',
      'LAN3',
      'LAN4',
      'LAN5',
      'LAN6',
    ]);

    const inventory = (await app.inject({ method: 'GET', url: '/api/physical' })).json();
    expect(inventory.sites[0].racks[0].assets[0].ports).toHaveLength(6);
  });

  it('rejects invalid rack units and invalid U positions before touching the database', async () => {
    const invalidRack = await app.inject({
      method: 'POST',
      url: `/api/physical/sites/${(await createRack()).id}/racks`,
      payload: { name: 'Rack inválido', units: 0 },
    });
    expect(invalidRack.statusCode).toBe(400);

    const rack = await createRack(12);
    for (const payload of [
      { name: 'U zero', startU: 0, heightU: 1 },
      { name: 'Altura zero', startU: 1, heightU: 0 },
      { name: 'Altura absurda', startU: 1, heightU: 101 },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/physical/racks/${rack.id}/assets`,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }

    const inventory = (await app.inject({ method: 'GET', url: '/api/physical' })).json();
    expect(inventory.sites[0].racks[0].assets).toHaveLength(0);
  });

  it('frees both endpoints when a cable is removed and blocks deletion while connected', async () => {
    const rack = await createRack();
    const createAsset = async (name: string, startU: number) =>
      (
        await app.inject({
          method: 'POST',
          url: `/api/physical/racks/${rack.id}/assets`,
          payload: { name, startU, heightU: 1, genericPorts: { count: 1, prefix: 'GE' } },
        })
      ).json();
    const left = await createAsset('SW-A', 40);
    const right = await createAsset('SW-B', 38);

    const cable = await app.inject({
      method: 'POST',
      url: '/api/physical/connections',
      payload: { portAId: left.ports[0].id, portBId: right.ports[0].id },
    });
    expect(cable.statusCode).toBe(201);

    const blockedAsset = await app.inject({
      method: 'DELETE',
      url: `/api/physical/assets/${left.id}`,
    });
    expect(blockedAsset.statusCode).toBe(409);
    expect(blockedAsset.json().message).toContain('Desconecte os cabos');

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/physical/connections/${cable.json().id}`,
    });
    expect(removed.statusCode).toBe(204);

    const reconnect = await app.inject({
      method: 'POST',
      url: '/api/physical/connections',
      payload: { portAId: left.ports[0].id, portBId: right.ports[0].id },
    });
    expect(reconnect.statusCode).toBe(201);

    const blockedRack = await app.inject({
      method: 'DELETE',
      url: `/api/physical/racks/${rack.id}`,
    });
    expect(blockedRack.statusCode).toBe(409);
    expect(blockedRack.json().message).toContain('Remova os equipamentos');
  });

  it('detects a physical loop instead of walking forever', async () => {
    const rack = await createRack();
    const createDio = async (name: string, startU: number) =>
      (
        await app.inject({
          method: 'POST',
          url: `/api/physical/racks/${rack.id}/assets`,
          payload: { name, kind: 'DIO', startU, heightU: 1 },
        })
      ).json();
    const createPort = async (assetId: string, side: 'FRONT' | 'REAR', name: string) =>
      (
        await app.inject({
          method: 'POST',
          url: `/api/physical/assets/${assetId}/ports`,
          payload: { name, side, order: 1, type: 'FIBER' },
        })
      ).json();

    const dioA = await createDio('DIO-A', 30);
    const dioB = await createDio('DIO-B', 28);
    const frontA = await createPort(dioA.id, 'FRONT', 'F1');
    const rearA = await createPort(dioA.id, 'REAR', 'R1');
    const frontB = await createPort(dioB.id, 'FRONT', 'F1');
    const rearB = await createPort(dioB.id, 'REAR', 'R1');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/physical/ports/${frontA.id}/pair`,
          payload: { pairedPortId: rearA.id },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/physical/ports/${frontB.id}/pair`,
          payload: { pairedPortId: rearB.id },
        })
      ).statusCode,
    ).toBe(200);

    for (const [portAId, portBId] of [
      [rearA.id, frontB.id],
      [rearB.id, frontA.id],
    ]) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/physical/connections',
            payload: { portAId, portBId },
          })
        ).statusCode,
      ).toBe(201);
    }

    const path = await app.inject({ method: 'GET', url: `/api/physical/ports/${frontA.id}/path` });
    expect(path.statusCode).toBe(200);
    expect(path.json().loopDetected).toBe(true);
    expect(path.json().steps.length).toBeLessThanOrEqual(9);
  });

  it('rejects positions outside the rack and overlapping equipment', async () => {
    const rack = await createRack(12);
    const first = await app.inject({
      method: 'POST',
      url: `/api/physical/racks/${rack.id}/assets`,
      payload: { name: 'Router', startU: 5, heightU: 2 },
    });
    expect(first.statusCode).toBe(201);

    const overlap = await app.inject({
      method: 'POST',
      url: `/api/physical/racks/${rack.id}/assets`,
      payload: { name: 'Switch', startU: 6, heightU: 1 },
    });
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json().message).toContain('Router');

    const outside = await app.inject({
      method: 'POST',
      url: `/api/physical/racks/${rack.id}/assets`,
      payload: { name: 'OLT', startU: 12, heightU: 2 },
    });
    expect(outside.statusCode).toBe(400);
    expect(outside.json().message).toContain('12U');
  });

  it('enforces port occupancy and traces a path through a passive FRONT/REAR pair', async () => {
    const rack = await createRack();
    const createAsset = async (payload: Record<string, unknown>) =>
      (
        await app.inject({
          method: 'POST',
          url: `/api/physical/racks/${rack.id}/assets`,
          payload,
        })
      ).json();
    const source = await createAsset({
      name: 'SW-01',
      startU: 30,
      heightU: 1,
      genericPorts: { count: 1, prefix: 'GE' },
    });
    const dio = await createAsset({ name: 'DIO-01', kind: 'DIO', startU: 20, heightU: 1 });
    const target = await createAsset({
      name: 'EDD-01',
      startU: 10,
      heightU: 1,
      genericPorts: { count: 1, prefix: 'LAN' },
    });
    const createPort = async (side: 'FRONT' | 'REAR', order: number) =>
      (
        await app.inject({
          method: 'POST',
          url: `/api/physical/assets/${dio.id}/ports`,
          payload: { name: '01', side, order, type: 'FIBER' },
        })
      ).json();
    const front = await createPort('FRONT', 1);
    const rear = await createPort('REAR', 1);
    const paired = await app.inject({
      method: 'POST',
      url: `/api/physical/ports/${front.id}/pair`,
      payload: { pairedPortId: rear.id },
    });
    expect(paired.statusCode).toBe(200);

    const cableA = await app.inject({
      method: 'POST',
      url: '/api/physical/connections',
      payload: { portAId: source.ports[0].id, portBId: front.id, medium: 'FIBER' },
    });
    expect(cableA.statusCode).toBe(201);
    const cableB = await app.inject({
      method: 'POST',
      url: '/api/physical/connections',
      payload: { portAId: rear.id, portBId: target.ports[0].id, medium: 'FIBER' },
    });
    expect(cableB.statusCode).toBe(201);

    const selfLink = await app.inject({
      method: 'POST',
      url: '/api/physical/connections',
      payload: { portAId: source.ports[0].id, portBId: source.ports[0].id },
    });
    expect(selfLink.statusCode).toBe(400);
    expect(selfLink.json().message).toContain('ela mesma');

    const occupied = await app.inject({
      method: 'POST',
      url: '/api/physical/connections',
      payload: { portAId: source.ports[0].id, portBId: target.ports[0].id },
    });
    expect(occupied.statusCode).toBe(409);

    const path = await app.inject({
      method: 'GET',
      url: `/api/physical/ports/${source.ports[0].id}/path`,
    });
    expect(path.statusCode).toBe(200);
    expect(path.json().endpointPortId).toBe(target.ports[0].id);
    expect(path.json().loopDetected).toBe(false);
    expect(path.json().steps.map((step: { kind: string }) => step.kind)).toEqual([
      'PORT',
      'CABLE',
      'PORT',
      'PASS_THROUGH',
      'PORT',
      'CABLE',
      'PORT',
    ]);
  });

  it('maps real interfaces by stable IDs when synchronizing a linked Device', async () => {
    const hosts = new DemoHostRepositoryAdapter(new DemoMapRepository());
    const host = (await hosts.listHosts()).find((candidate) => candidate.interfaces.length > 0)!;
    const firstInterface = host.interfaces[0]!;
    const rack = await createRack();
    const assetResponse = await app.inject({
      method: 'POST',
      url: `/api/physical/racks/${rack.id}/assets`,
      payload: { name: host.displayName, startU: 1, heightU: 1, deviceId: host.id },
    });
    const sync = await app.inject({
      method: 'POST',
      url: `/api/physical/assets/${assetResponse.json().id}/sync-interfaces`,
    });
    expect(sync.statusCode).toBe(200);
    expect(sync.json()).toHaveLength(host.interfaces.length);
    expect(sync.json()[0]).toMatchObject({
      mappedInterfaceId: firstInterface.id,
      mappedInterface: { ifIndex: firstInterface.ifIndex },
    });
  });

  it('allows authenticated reading but rejects physical edits from VIEWER', async () => {
    await app.close();
    app = await buildPhysicalApp('VIEWER');
    const read = await app.inject({ method: 'GET', url: '/api/physical' });
    expect(read.statusCode).toBe(200);
    const write = await app.inject({
      method: 'POST',
      url: '/api/physical/sites',
      payload: { name: 'POP sem permissão' },
    });
    expect(write.statusCode).toBe(403);
    expect(write.json().message).toContain('ADMIN ou OPERATOR');
  });
});
