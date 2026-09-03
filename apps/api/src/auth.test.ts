import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';

function sessionCookie(headers: unknown): string {
  const setCookie = (headers as Record<string, unknown>)['set-cookie'];
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  const value = list.find(
    (item) => typeof item === 'string' && item.startsWith('netvision_session='),
  );
  return (value ?? '').split(';')[0] ?? '';
}

type InjectOptions = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  payload?: object;
  headers?: Record<string, string>;
};

describe('Auth and public views', () => {
  let app: FastifyInstance;
  let cookie = '';

  beforeEach(async () => {
    app = await buildApp({ requireAuth: true });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { usernameOrEmail: 'admin', password: 'admin' },
    });
    expect(login.statusCode).toBe(200);
    cookie = sessionCookie(login.headers);
  });

  afterEach(async () => {
    await app.close();
  });

  const authed = (opts: InjectOptions) =>
    app.inject({
      method: opts.method,
      url: opts.url,
      ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
      headers: { ...(opts.headers ?? {}), cookie },
    });

  it('authenticates with valid credentials', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { usernameOrEmail: 'admin', password: 'admin' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ username: 'admin', role: 'ADMIN' });
  });

  it('rejects invalid credentials', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { usernameOrEmail: 'admin', password: 'errada' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('blocks a protected route without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/maps' });
    expect(response.statusCode).toBe(401);
  });

  it('allows authenticated access to protected routes', async () => {
    const response = await authed({ method: 'GET', url: '/api/maps' });
    expect(response.statusCode).toBe(200);
  });

  it('keeps global interface search behind normal authentication', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/interfaces/search?q=GE',
    });
    expect(anonymous.statusCode).toBe(401);

    const authenticated = await authed({
      method: 'GET',
      url: '/api/interfaces/search?q=GE&limit=3',
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json().length).toBeLessThanOrEqual(3);
  });

  it('logs out and invalidates the session', async () => {
    const logout = await authed({ method: 'POST', url: '/api/auth/logout' });
    expect(logout.statusCode).toBe(200);
    const after = await authed({ method: 'GET', url: '/api/maps' });
    expect(after.statusCode).toBe(401);
  });

  it('rejects an unknown public token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/public/view/does-not-exist' });
    expect(response.statusCode).toBe(404);
  });

  it('serves a MAP public view with only its own sanitized map', async () => {
    const privateMap = (await authed({ method: 'GET', url: '/api/maps/backbone-main' })).json();
    const unilateral = privateMap.links[0];
    const configured = await authed({
      method: 'PATCH',
      url: `/api/maps/backbone-main/links/${unilateral.id}`,
      payload: {
        sourceInterfaceId: unilateral.sourceInterfaceId,
        targetInterfaceId: null,
        capacityBps: unilateral.capacityBps,
        autoCapacityBps: unilateral.autoCapacityBps,
        capacitySource: unilateral.capacitySource,
        trafficMode: 'SINGLE_ENDED',
        customColor: '#34a853',
        trafficColorAToB: '#4da3ff',
        trafficColorBToA: '#f0923c',
        inlineLabelPositionAToB: 0.3,
        inlineLabelPositionBToA: 0.7,
        animationEnabled: true,
        label: unilateral.label,
        metricSource: unilateral.metricSource,
        visualStyle: unilateral.visualStyle,
        metricDisplay: unilateral.metricDisplay,
      },
    });
    expect(configured.statusCode).toBe(200);

    const created = await authed({
      method: 'POST',
      url: '/api/public-views',
      payload: { name: 'Mapa Público', type: 'MAP', mapId: 'backbone-main' },
    });
    expect(created.statusCode).toBe(201);
    const token = created.json().token as string;

    const response = await app.inject({ method: 'GET', url: `/api/public/view/${token}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().type).toBe('MAP');
    expect(response.json().map.id).toBe('backbone-main');
    expect(
      response.json().map.links.find((link: { id: string }) => link.id === unilateral.id),
    ).toMatchObject({
      trafficMode: 'SINGLE_ENDED',
      customColor: '#34a853',
      trafficColorAToB: '#4da3ff',
      trafficColorBToA: '#f0923c',
      inlineLabelPositionAToB: 0.3,
      inlineLabelPositionBToA: 0.7,
      animationEnabled: true,
    });
    const device = response.json().map.devices[0];
    expect(device).not.toHaveProperty('snmp');
    expect(device).not.toHaveProperty('ssh');
    expect(device).not.toHaveProperty('zabbix');
    expect(device).not.toHaveProperty('sourceHealth');
    expect(device).not.toHaveProperty('notes');

    const mpls = await app.inject({
      method: 'GET',
      url: `/api/public/view/${token}/hosts/${device.id}/mpls`,
    });
    expect(mpls.statusCode).toBe(200);
    expect(mpls.json()).toMatchObject({ supported: false, source: 'SNMP', vsis: [] });

    const outsideMap = await app.inject({
      method: 'GET',
      url: `/api/public/view/${token}/hosts/not-in-this-map/mpls`,
    });
    expect(outsideMap.statusCode).toBe(404);
  });

  it('serves a NOC public view with its playlist maps', async () => {
    const playlistResponse = await authed({
      method: 'POST',
      url: '/api/playlists',
      payload: {
        id: 'public-noc-playlist',
        name: 'NOC Público',
        rotationIntervalSeconds: 30,
        mapIds: ['backbone-main', 'bgp-operators'],
        isDefault: false,
      },
    });
    expect(playlistResponse.statusCode).toBe(201);
    const playlistId = playlistResponse.json().id as string;

    const created = await authed({
      method: 'POST',
      url: '/api/public-views',
      payload: { name: 'NOC Público', type: 'NOC', playlistId },
    });
    expect(created.statusCode).toBe(201);
    const token = created.json().token as string;

    const response = await app.inject({ method: 'GET', url: `/api/public/view/${token}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().type).toBe('NOC');
    expect(response.json().playlist.id).toBe(playlistId);
    expect(response.json().playlist.maps).toHaveLength(2);
    expect(response.json().playlist.rotationIntervalSeconds).toBe(30);
  });

  it('rejects a disabled public token', async () => {
    const created = await authed({
      method: 'POST',
      url: '/api/public-views',
      payload: { name: 'Desativado', type: 'MAP', mapId: 'backbone-main' },
    });
    const id = created.json().id as string;
    const token = created.json().token as string;

    await authed({ method: 'PATCH', url: `/api/public-views/${id}`, payload: { enabled: false } });
    const response = await app.inject({ method: 'GET', url: `/api/public/view/${token}` });
    expect(response.statusCode).toBe(404);
  });

  it('rejects an expired public token', async () => {
    const created = await authed({
      method: 'POST',
      url: '/api/public-views',
      payload: {
        name: 'Expirado',
        type: 'MAP',
        mapId: 'backbone-main',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    });
    const token = created.json().token as string;
    const response = await app.inject({ method: 'GET', url: `/api/public/view/${token}` });
    expect(response.statusCode).toBe(410);
  });

  it('does not expose write endpoints on the public API', async () => {
    const post = await app.inject({ method: 'POST', url: '/api/public/view/anything' });
    expect(post.statusCode).toBe(404);
    const put = await app.inject({ method: 'PUT', url: '/api/public/view/anything' });
    expect(put.statusCode).toBe(404);
  });
});
