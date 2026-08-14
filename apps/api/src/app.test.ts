import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';

describe('GMJ NetVision API', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves the demo map', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/maps/backbone-main' });
    expect(response.statusCode).toBe(200);
    expect(response.json().devices).toHaveLength(13);
  });

  it('lists maps and maintains exactly one default view', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/maps' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(3);
    expect(response.json().filter((map: { isDefault: boolean }) => map.isDefault)).toHaveLength(1);
  });

  it('creates empty maps and duplicates topology with map-specific node ids', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: '/api/maps',
      payload: {
        name: 'Mapa vazio',
        description: 'Teste',
        mode: 'MANUAL',
        sourceMapId: null,
      },
    });
    expect(empty.statusCode).toBe(201);
    expect(empty.json().nodes).toHaveLength(0);
    expect(empty.json().devices).toHaveLength(13);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/maps/backbone-main/duplicate',
      payload: { name: 'Backbone DR' },
    });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json().nodes).toHaveLength(13);
    expect(
      duplicate.json().nodes.every((node: { mapId: string }) => node.mapId === duplicate.json().id),
    ).toBe(true);
  });

  it('keeps devices global when removing a node from one map', async () => {
    const removed = await app.inject({
      method: 'DELETE',
      url: '/api/maps/backbone-main/devices/core-01',
    });
    expect(removed.statusCode).toBe(204);
    const otherMap = await app.inject({ method: 'GET', url: '/api/maps/bgp-operators' });
    expect(otherMap.json().devices.some((device: { id: string }) => device.id === 'core-01')).toBe(
      true,
    );
    expect(
      otherMap.json().nodes.some((node: { deviceId: string }) => node.deviceId === 'core-01'),
    ).toBe(true);
  });

  it('returns the persisted MapNode when adding equipment', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/maps/backbone-main/devices',
      payload: {
        name: 'TEST-ROUTER',
        hostname: 'test-router',
        ip: '10.99.0.10',
        vendor: 'GMJ',
        model: 'Virtual',
        site: 'Lab',
        deviceType: 'router',
        position: { x: 700, y: 500 },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().node.deviceId).toBe(created.json().device.id);

    const moved = await app.inject({
      method: 'PUT',
      url: '/api/maps/backbone-main/nodes/positions',
      payload: {
        nodes: [{ nodeId: created.json().node.id, position: { x: 321, y: 654 } }],
      },
    });
    expect(
      moved.json().nodes.find((node: { id: string }) => node.id === created.json().node.id)
        .position,
    ).toEqual({ x: 321, y: 654 });
  });

  it('persists ordered NOC playlists', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/playlists',
      payload: {
        id: 'noc-main',
        name: 'NOC Principal',
        rotationIntervalSeconds: 30,
        mapIds: ['access-olts', 'backbone-main'],
        isDefault: true,
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().items).toEqual([
      { mapId: 'access-olts', order: 0 },
      { mapId: 'backbone-main', order: 1 },
    ]);
  });

  it('persists manual node positions in the repository', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/maps/backbone-main/nodes/positions',
      payload: { nodes: [{ nodeId: 'node-core-01', position: { x: 123, y: 456 } }] },
    });
    expect(response.statusCode).toBe(200);
    expect(
      response.json().nodes.find((node: { id: string }) => node.id === 'node-core-01').position,
    ).toEqual({ x: 123, y: 456 });
  });

  it('returns normalized discovery suggestions for review', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/maps/backbone-main/devices/core-01/discover',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().neighbors).toHaveLength(3);
    expect(response.json().neighbors[0].matchStatus).toBe('MATCHED');
  });
});
