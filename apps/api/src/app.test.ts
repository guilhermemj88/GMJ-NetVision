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
