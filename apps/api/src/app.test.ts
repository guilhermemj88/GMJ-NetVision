import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { DemoHostRepositoryAdapter } from './infrastructure/persistence/demo-host-repository-adapter';

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

  it('serves active alarms and history in demo mode', async () => {
    const active = await app.inject({ method: 'GET', url: '/api/alarms' });
    expect(active.statusCode).toBe(200);
    expect(active.json()).toEqual([]);

    const history = await app.inject({ method: 'GET', url: '/api/alarms/history?limit=10' });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual([]);
  });

  it.each(['SOURCE', 'TARGET'] as const)('creates and edits a %s monitored SUM link without a conceptual interface', async (side) => {
    const map = (await app.inject({ method: 'GET', url: '/api/maps/backbone-main' })).json();
    const host = map.devices.find((device: { interfaces: unknown[] }) => device.interfaces.length >= 2);
    const generic = (await app.inject({ method: 'POST', url: `/api/maps/${map.id}/generic-nodes`, payload: { type: 'carrier', label: 'FTI', position: { x: 20, y: 30 } } })).json();
    const settings = { capacityBps: 100000000000, autoCapacityBps: 100000000000, capacitySource: 'MANUAL', label: 'FTI', metricSource: 'DEMO', visualStyle: null, metricDisplay: null };
    const payload = { ...settings,
      ...(side === 'SOURCE' ? { sourceDeviceId: host.id, targetNodeId: generic.id } : { targetDeviceId: host.id, sourceNodeId: generic.id }),
      sourceInterfaceId: null, targetInterfaceId: null, aggregationMode: 'SUM',
      metricSources: host.interfaces.slice(0, 2).map((item: { id: string }) => ({ side, interfaceId: item.id })),
      trafficColorAToB: '#112233', trafficColorBToA: '#abcdef' };
    // Omitted mode is inferred only for DEVICE ↔ GENERIC creation.
    const response = await app.inject({ method: 'POST', url: `/api/maps/${map.id}/links`, payload });
    expect(response.statusCode).toBe(201);
    const link = response.json();
    expect(link).toMatchObject({ trafficMode: 'SINGLE_ENDED', aggregationMode: 'SUM', metricSources: payload.metricSources, trafficColorAToB: '#112233', trafficColorBToA: '#abcdef' });
    const expectedRx = host.interfaces.slice(0, 2).reduce((sum: number, item: { rxBps: number }) => sum + item.rxBps, 0);
    const expectedTx = host.interfaces.slice(0, 2).reduce((sum: number, item: { txBps: number }) => sum + item.txBps, 0);
    expect(link).toMatchObject({ rxBps: expectedRx, txBps: expectedTx });
    expect(link.directions.A_TO_B.bps).toBe(side === 'SOURCE' ? expectedTx : expectedRx);
    // A partial telemetry edit must validate against the already-persisted side.
    const edited = await app.inject({ method: 'PATCH', url: `/api/maps/${map.id}/links/${link.id}`, payload: { ...settings, trafficMode: 'SINGLE_ENDED' } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ rxBps: expectedRx, txBps: expectedTx, metricSources: payload.metricSources, trafficColorAToB: '#112233', trafficColorBToA: '#abcdef' });
    const reload = (await app.inject({ method: 'GET', url: `/api/maps/${map.id}` })).json();
    expect(reload.links.find((item: { id: string }) => item.id === link.id)).toMatchObject({ rxBps: expectedRx, txBps: expectedTx });
    expect(reload.devices).toHaveLength(map.devices.length);
  });

  it('persists manual visual path curves, resets and automatic layout without changing link options', async () => {
    const map = (await app.inject({ method: 'GET', url: '/api/maps/backbone-main' })).json();
    const link = map.links[0];
    const visualPaths = [
      { order: 0, label: 'Principal', customColor: '#123456', curvature: 400, enabled: true },
      { order: 1, label: 'Reserva', customColor: null, curvature: -400, enabled: false },
      { order: 2, label: 'Terceiro', customColor: '#abcdef', curvature: 150, enabled: true },
    ];
    for (const geometry of [
      { visualPaths, linkLayoutMode: 'MANUAL' },
      { visualPaths: visualPaths.map((path) => ({ ...path, curvature: 0 })), linkLayoutMode: 'MANUAL' },
      { visualPaths: visualPaths.map((path) => ({ ...path, curvature: 0 })), linkLayoutMode: 'AUTO' },
    ]) {
      const response = await app.inject({
        method: 'PATCH', url: `/api/maps/${map.id}/links/${link.id}`,
        payload: {
          capacityBps: link.capacityBps, autoCapacityBps: link.autoCapacityBps,
          capacitySource: link.capacitySource, label: link.label, metricSource: link.metricSource,
          visualStyle: link.visualStyle, metricDisplay: link.metricDisplay, ...geometry,
        },
      });
      expect(response.statusCode).toBe(200);
      const persisted = (await app.inject({ method: 'GET', url: `/api/maps/${map.id}` })).json()
        .links.find((item: { id: string }) => item.id === link.id);
      expect(persisted).toMatchObject({
        ...geometry, trafficMode: link.trafficMode, capacityBps: link.capacityBps,
        sourceInterfaceId: link.sourceInterfaceId, targetInterfaceId: link.targetInterfaceId,
        aggregationMode: link.aggregationMode, customColor: link.customColor,
        animationEnabled: link.animationEnabled,
      });
    }
  });

  it('creates, updates and returns persistent single-ended link options', async () => {
    const map = (await app.inject({ method: 'GET', url: '/api/maps/backbone-main' })).json();
    const source = map.devices.find(
      (device: { interfaces: unknown[] }) => device.interfaces.length,
    );
    const genericNode = await app.inject({
      method: 'POST',
      url: '/api/maps/backbone-main/generic-nodes',
      payload: { type: 'internet', label: 'TRANSIT', position: { x: 100, y: 100 } },
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/maps/backbone-main/links',
      payload: {
        sourceDeviceId: source.id,
        sourceInterfaceId: source.interfaces[0].id,
        targetNodeId: genericNode.json().id,
        targetInterfaceId: null,
        capacityBps: source.interfaces[0].speedBps,
        autoCapacityBps: source.interfaces[0].speedBps,
        capacitySource: 'AUTO',
        trafficMode: 'SINGLE_ENDED',
        customColor: '#34a853',
        animationEnabled: true,
        label: 'Internet Transit',
        metricSource: 'DEMO',
        visualStyle: null,
        metricDisplay: null,
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      trafficMode: 'SINGLE_ENDED',
      customColor: '#34a853',
      animationEnabled: true,
      status: 'UP',
      autoCapacityBps: source.interfaces[0].speedBps,
    });

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/maps/backbone-main/links/${created.json().id}`,
      payload: {
        sourceInterfaceId: source.interfaces[0].id,
        targetInterfaceId: null,
        capacityBps: source.interfaces[0].speedBps,
        autoCapacityBps: source.interfaces[0].speedBps,
        capacitySource: 'AUTO',
        trafficMode: 'SINGLE_ENDED',
        customColor: '#4285f4',
        animationEnabled: false,
        label: 'PNI',
        metricSource: 'DEMO',
        visualStyle: null,
        metricDisplay: null,
      },
    });
    expect(updated.json()).toMatchObject({
      trafficMode: 'SINGLE_ENDED',
      customColor: '#4285f4',
      animationEnabled: false,
      label: 'PNI',
    });

    const persisted = (await app.inject({ method: 'GET', url: '/api/maps/backbone-main' }))
      .json()
      .links.find((link: { id: string }) => link.id === created.json().id);
    expect(persisted).toMatchObject({
      trafficMode: 'SINGLE_ENDED',
      customColor: '#4285f4',
      animationEnabled: false,
    });
  });

  it('persists per-link directional traffic colors and inline label positions', async () => {
    const map = (await app.inject({ method: 'GET', url: '/api/maps/backbone-main' })).json();
    const source = map.devices.find(
      (device: { id: string; interfaces: unknown[] }) =>
        device.interfaces.length >= 2 && device.id !== 'customers',
    );
    const target = map.devices.find(
      (device: { id: string; interfaces: unknown[] }) =>
        device.id !== source.id && device.interfaces.length >= 2,
    );
    const payload = {
      sourceDeviceId: source.id,
      sourceInterfaceId: source.interfaces[0].id,
      targetDeviceId: target.id,
      targetInterfaceId: target.interfaces[0].id,
      capacityBps: 1_000_000_000,
      autoCapacityBps: 1_000_000_000,
      capacitySource: 'AUTO',
      trafficMode: 'BIDIRECTIONAL',
      customColor: null,
      animationEnabled: null,
      label: 'bidirectional colors',
      metricSource: 'DEMO',
      visualStyle: null,
      metricDisplay: null,
    };

    const created = await app.inject({
      method: 'POST',
      url: '/api/maps/backbone-main/links',
      payload: {
        ...payload,
        trafficColorAToB: '#4da3ff',
        trafficColorBToA: '#f0923c',
        inlineLabelPositionAToB: 0.25,
        inlineLabelPositionBToA: 0.75,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      trafficColorAToB: '#4da3ff',
      trafficColorBToA: '#f0923c',
      inlineLabelPositionAToB: 0.25,
      inlineLabelPositionBToA: 0.75,
    });

    const reset = await app.inject({
      method: 'PATCH',
      url: `/api/maps/backbone-main/links/${created.json().id}`,
      payload: {
        ...payload,
        sourceInterfaceId: source.interfaces[0].id,
        targetInterfaceId: target.interfaces[0].id,
        trafficColorAToB: null,
        trafficColorBToA: null,
        inlineLabelPositionAToB: null,
        inlineLabelPositionBToA: null,
        label: 'reset colors',
      },
    });
    expect(reset.json()).toMatchObject({
      trafficColorAToB: null,
      trafficColorBToA: null,
      inlineLabelPositionAToB: null,
      inlineLabelPositionBToA: null,
    });

    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/maps/backbone-main/links/${created.json().id}`,
      payload: {
        ...payload,
        sourceInterfaceId: source.interfaces[0].id,
        targetInterfaceId: target.interfaces[0].id,
        inlineLabelPositionAToB: 0.05,
      },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('returns MPLS unavailable without generating demo data', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/hosts/core-01/mpls' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      supported: false,
      source: 'SNMP',
      summary: { vsiTotal: 0, pwTotal: 0 },
      vsis: [],
    });
  });

  it('exposes optical history with the supported period contract', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/interfaces/core-01-if-1/optical-history?period=6h',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/interfaces/core-01-if-1/optical-history?period=30d',
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('returns Lane 0..N from the optical-history endpoint', async () => {
    const history = vi
      .spyOn(DemoHostRepositoryAdapter.prototype, 'getInterfaceOpticalHistory')
      .mockResolvedValue([
        {
          timestamp: '2026-08-23T12:00:00.000Z',
          sampleCount: 1,
          rxAvg: -3.71,
          rxMin: -3.71,
          rxMax: -3.71,
          txAvg: 0.77,
          txMin: 0.77,
          txMax: 0.77,
          lanes: [0, 2, 5].map((lane) => ({
            lane,
            sampleCount: 1,
            rxAvg: -3.71 + lane,
            rxMin: -3.71 + lane,
            rxMax: -3.71 + lane,
            txAvg: 0.77 + lane,
            txMin: 0.77 + lane,
            txMax: 0.77 + lane,
          })),
        },
      ]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/interfaces/if-100ge/optical-history?period=15m',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()[0].lanes.map((lane: { lane: number }) => lane.lane)).toEqual([0, 2, 5]);
    history.mockRestore();
  });

  it.each(['15m', '1h', '6h'] as const)(
    'returns Lane 0..3 from the optical-history endpoint for period=%s',
    async (period) => {
      const history = vi
        .spyOn(DemoHostRepositoryAdapter.prototype, 'getInterfaceOpticalHistory')
        .mockResolvedValue([
          {
            timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
            sampleCount: 1,
            rxAvg: -3.71,
            rxMin: -3.71,
            rxMax: -3.71,
            txAvg: 0.77,
            txMin: 0.77,
            txMax: 0.77,
            lanes: [0, 1, 2, 3].map((lane) => ({
              lane,
              sampleCount: 1,
              rxAvg: -3.71 + lane,
              rxMin: -3.71 + lane,
              rxMax: -3.71 + lane,
              txAvg: 0.77 + lane,
              txMin: 0.77 + lane,
              txMax: 0.77 + lane,
            })),
          },
        ]);

      const response = await app.inject({
        method: 'GET',
        url: `/api/interfaces/if-100ge/optical-history?period=${period}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()[0].lanes.map((lane: { lane: number }) => lane.lane)).toEqual([0, 1, 2, 3]);
      history.mockRestore();
    },
  );

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

  it('persists the position source supplied by the layout editor', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/maps/backbone-main/nodes/positions',
      payload: {
        nodes: [
          {
            nodeId: 'node-core-01',
            position: { x: 222, y: 333 },
            positionSource: 'AUTO',
          },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(
      response.json().nodes.find((node: { id: string }) => node.id === 'node-core-01'),
    ).toMatchObject({ position: { x: 222, y: 333 }, positionSource: 'AUTO' });
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

  it('lists the global host inventory independently from map membership', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/hosts?q=core&sort=hostname' });
    expect(response.statusCode).toBe(200);
    expect(response.json().length).toBeGreaterThan(0);
    expect(response.json()[0]).toMatchObject({
      displayName: expect.any(String),
      mapIds: expect.any(Array),
      sourceHealth: expect.objectContaining({ ZABBIX: expect.any(Object) }),
    });
    for (const host of response.json()) {
      expect(host.ssh ?? {}).not.toHaveProperty('password');
      expect(host.snmp ?? {}).not.toHaveProperty('community');
      expect(host.snmp ?? {}).not.toHaveProperty('authPassword');
      expect(host.snmp ?? {}).not.toHaveProperty('privacyPassword');
      expect(host.zabbix ?? {}).not.toHaveProperty('token');
    }
  });

  it('searches the global interface inventory by name, alias, description and ifIndex', async () => {
    const byName = await app.inject({
      method: 'GET',
      url: '/api/interfaces/search?q=100GE1%2F0%2F1',
    });
    expect(byName.statusCode).toBe(200);
    expect(byName.json().length).toBeGreaterThan(0);
    expect(byName.json()[0]).toMatchObject({
      interfaceName: '100GE1/0/1',
      ifIndex: 1000,
      vlan: null,
    });
    expect(byName.json()[0]).toHaveProperty('maps');

    const byAlias = await app.inject({
      method: 'GET',
      url: '/api/interfaces/search?q=uplink-primary',
    });
    expect(byAlias.json().some((item: { alias: string }) => item.alias === 'UPLINK-PRIMARY')).toBe(
      true,
    );

    const byDescription = await app.inject({
      method: 'GET',
      url: '/api/interfaces/search?q=backbone%20optical',
    });
    expect(
      byDescription
        .json()
        .some((item: { description: string }) => item.description === 'Backbone optical link'),
    ).toBe(true);

    const byIfIndex = await app.inject({ method: 'GET', url: '/api/interfaces/search?q=1000' });
    expect(byIfIndex.json().every((item: { ifIndex: number }) => item.ifIndex === 1000)).toBe(true);
  });

  it('limits interface search results and returns an empty list when nothing matches', async () => {
    const limited = await app.inject({
      method: 'GET',
      url: '/api/interfaces/search?q=GE&limit=2',
    });
    expect(limited.statusCode).toBe(200);
    expect(limited.json()).toHaveLength(2);

    const empty = await app.inject({
      method: 'GET',
      url: '/api/interfaces/search?q=definitely-no-such-interface',
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual([]);
  });

  it('creates, edits, maps and removes a manual host without duplicating Device', async () => {
    const payload = {
      hostname: 'lab-router-01',
      displayName: 'LAB Router 01',
      managementIp: '10.250.0.1',
      vendor: 'GMJ',
      model: 'Virtual',
      deviceType: 'router',
      site: 'Lab',
      description: 'Host de teste',
      notes: '',
      origin: 'MANUAL',
      zabbix: { enabled: false, hostId: '', hostName: '', primaryInterfaceId: '', ip: '' },
      ssh: { enabled: false, host: '10.250.0.1', port: 22, username: '' },
      snmp: {
        enabled: false,
        version: 'SNMP_V2C',
        host: '10.250.0.1',
        port: 161,
        username: '',
        securityLevel: 'NO_AUTH_NO_PRIV',
        authProtocol: null,
        privacyProtocol: null,
      },
    };
    const created = await app.inject({ method: 'POST', url: '/api/hosts', payload });
    expect(created.statusCode).toBe(201);
    expect(created.json().mapCount).toBe(0);

    const mapped = await app.inject({
      method: 'POST',
      url: `/api/hosts/${created.json().id}/maps`,
      payload: { mapId: 'backbone-main', position: { x: 222, y: 333 } },
    });
    expect(mapped.statusCode).toBe(201);
    const map = await app.inject({ method: 'GET', url: '/api/maps/backbone-main' });
    expect(
      map.json().nodes.filter((node: { deviceId: string }) => node.deviceId === created.json().id),
    ).toHaveLength(1);
    const core = map.json().devices.find((device: { id: string }) => device.id === 'core-01');
    const relatedLink = await app.inject({
      method: 'POST',
      url: '/api/maps/backbone-main/links',
      payload: {
        sourceDeviceId: created.json().id,
        sourceInterfaceId: created.json().interfaces[0].id,
        targetDeviceId: core.id,
        targetInterfaceId: core.interfaces[0].id,
        capacityBps: 1_000_000_000,
        autoCapacityBps: 1_000_000_000,
        capacitySource: 'AUTO',
        trafficMode: 'BIDIRECTIONAL',
        customColor: null,
        animationEnabled: null,
        label: 'host deletion test',
        metricSource: 'DEMO',
        visualStyle: null,
        metricDisplay: null,
      },
    });
    expect(relatedLink.statusCode).toBe(201);

    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/hosts/${created.json().id}`,
      payload: { displayName: 'LAB Router atualizado' },
    });
    expect(edited.json().displayName).toBe('LAB Router atualizado');
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/hosts/${created.json().id}`,
    });
    expect(removed.statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: `/api/hosts/${created.json().id}` })).statusCode,
    ).toBe(404);
    const mapAfterDelete = await app.inject({ method: 'GET', url: '/api/maps/backbone-main' });
    expect(
      mapAfterDelete
        .json()
        .nodes.some((node: { deviceId: string }) => node.deviceId === created.json().id),
    ).toBe(false);
    expect(
      mapAfterDelete
        .json()
        .links.some(
          (link: { sourceDeviceId: string; targetDeviceId: string }) =>
            link.sourceDeviceId === created.json().id || link.targetDeviceId === created.json().id,
        ),
    ).toBe(false);
  });

  it('stores, validates and clears the optional SSH context command', async () => {
    const payload = {
      hostname: 'ne8-ixbr-01',
      displayName: 'NE8 IXBR',
      managementIp: '10.250.9.8',
      vendor: 'Huawei',
      model: 'NE8',
      deviceType: 'router',
      site: 'IX',
      description: '',
      notes: '',
      origin: 'MANUAL',
      zabbix: { enabled: false, hostId: '', hostName: '', primaryInterfaceId: '', ip: '' },
      ssh: {
        enabled: true,
        host: '10.250.9.1',
        port: 22,
        username: 'operator',
        contextCommand: 'switch virtual-system IMPLANTAR-IXBR',
      },
      snmp: {
        enabled: true,
        version: 'SNMP_V2C',
        host: '10.250.9.8',
        port: 161,
        username: '',
        securityLevel: 'NO_AUTH_NO_PRIV',
        authProtocol: null,
        privacyProtocol: null,
      },
    };
    const created = await app.inject({ method: 'POST', url: '/api/hosts', payload });
    expect(created.statusCode).toBe(201);
    expect(created.json().ssh.contextCommand).toBe('switch virtual-system IMPLANTAR-IXBR');
    expect(created.json().ssh.password).toBeUndefined();
    expect(JSON.stringify(created.json())).not.toMatch(/"password"\s*:/i);

    const hostId = created.json().id;
    const invalid = await app.inject({
      method: 'PATCH',
      url: `/api/hosts/${hostId}`,
      payload: {
        ssh: {
          enabled: true,
          host: '10.250.9.1',
          port: 22,
          username: 'operator',
          contextCommand: 'switch virtual-system A; display bgp peer',
        },
      },
    });
    expect(invalid.statusCode).toBe(400);

    // Updating only SSH must not touch the SNMP configuration.
    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/hosts/${hostId}`,
      payload: {
        ssh: {
          enabled: true,
          host: '10.250.9.1',
          port: 22,
          username: 'operator',
          contextCommand: 'switch virtual-system OTHER',
        },
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().ssh.contextCommand).toBe('switch virtual-system OTHER');
    expect(edited.json().snmp).toMatchObject({ host: '10.250.9.8', port: 161, version: 'SNMP_V2C' });

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/hosts/${hostId}`,
      payload: {
        ssh: {
          enabled: true,
          host: '10.250.9.1',
          port: 22,
          username: 'operator',
          contextCommand: '',
        },
      },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().ssh.contextCommand).toBeNull();

    await app.inject({ method: 'DELETE', url: `/api/hosts/${hostId}` });
  });

  it('removes a host from multiple maps without leaving orphan nodes or links', async () => {
    const mapIds = ['backbone-main', 'bgp-operators', 'access-olts'];
    const existing = await app.inject({ method: 'GET', url: '/api/hosts/core-01' });
    expect(existing.statusCode).toBe(200);
    expect(existing.json().mapCount).toBe(mapIds.length);

    for (const mapId of mapIds) {
      const map = await app.inject({ method: 'GET', url: `/api/maps/${mapId}` });
      expect(
        map.json().nodes.some((node: { deviceId: string }) => node.deviceId === 'core-01'),
      ).toBe(true);
      expect(
        map
          .json()
          .links.some(
            (link: { sourceDeviceId: string; targetDeviceId: string }) =>
              link.sourceDeviceId === 'core-01' || link.targetDeviceId === 'core-01',
          ),
      ).toBe(true);
    }

    expect((await app.inject({ method: 'DELETE', url: '/api/hosts/core-01' })).statusCode).toBe(
      204,
    );

    for (const mapId of mapIds) {
      const map = await app.inject({ method: 'GET', url: `/api/maps/${mapId}` });
      const nodeDeviceIds = new Set(
        map.json().nodes.map((node: { deviceId: string }) => node.deviceId),
      );
      expect(nodeDeviceIds.has('core-01')).toBe(false);
      expect(
        map
          .json()
          .links.some(
            (link: { sourceDeviceId: string; targetDeviceId: string }) =>
              link.sourceDeviceId === 'core-01' || link.targetDeviceId === 'core-01',
          ),
      ).toBe(false);
      expect(
        map
          .json()
          .links.every(
            (link: { sourceDeviceId: string; targetDeviceId: string }) =>
              nodeDeviceIds.has(link.sourceDeviceId) && nodeDeviceIds.has(link.targetDeviceId),
          ),
      ).toBe(true);
    }
  });

  it('removes a Zabbix host only from NetVision and allows importing it again', async () => {
    const payload = {
      hostname: 'zabbix-delete-01',
      displayName: 'Zabbix Delete 01',
      managementIp: '10.251.0.1',
      vendor: 'Huawei',
      model: 'S6730',
      deviceType: 'switch',
      site: 'Lab',
      description: 'Importado do Zabbix',
      notes: '',
      origin: 'ZABBIX',
      zabbix: {
        enabled: true,
        hostId: 'zbx-delete-01',
        hostName: 'zabbix-delete-01',
        primaryInterfaceId: 'zbx-if-01',
        ip: '10.251.0.1',
      },
      ssh: { enabled: false, host: '10.251.0.1', port: 22, username: '' },
      snmp: {
        enabled: false,
        version: 'SNMP_V2C',
        host: '10.251.0.1',
        port: 161,
        username: '',
        securityLevel: 'NO_AUTH_NO_PRIV',
        authProtocol: null,
        privacyProtocol: null,
      },
    };
    const created = await app.inject({ method: 'POST', url: '/api/hosts', payload });
    expect(created.statusCode).toBe(201);
    const externalFetch = vi.spyOn(globalThis, 'fetch');

    try {
      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/hosts/${created.json().id}`,
      });
      expect(removed.statusCode).toBe(204);
      expect(externalFetch).not.toHaveBeenCalled();
    } finally {
      externalFetch.mockRestore();
    }

    const importedAgain = await app.inject({ method: 'POST', url: '/api/hosts', payload });
    expect(importedAgain.statusCode).toBe(201);
    expect(importedAgain.json().id).not.toBe(created.json().id);
    expect(importedAgain.json()).toMatchObject({ origin: 'ZABBIX', useZabbix: true });
  });

  it('returns 404 when deleting a host that does not exist', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/hosts/host-that-does-not-exist',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ message: 'Host not found' });
  });

  it('keeps Zabbix import as preview/select/apply and does not add nodes automatically', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/maps/backbone-main' });
    const preview = await app.inject({ method: 'POST', url: '/api/hosts/import/zabbix/preview' });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().hosts.length).toBeGreaterThan(0);
    const candidate = preview
      .json()
      .hosts.find((host: { alreadyRegistered: boolean }) => !host.alreadyRegistered);
    const imported = await app.inject({
      method: 'POST',
      url: '/api/hosts/import/zabbix',
      payload: { previewId: preview.json().id, hostIds: [candidate.hostId] },
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json().imported).toHaveLength(1);
    expect(imported.json().imported[0].mapCount).toBe(0);
    const after = await app.inject({ method: 'GET', url: '/api/maps/backbone-main' });
    expect(after.json().nodes).toHaveLength(before.json().nodes.length);
  });

  it('does not mutate topology during discovery preview and changes it only on apply', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/maps/backbone-main' });
    const preview = await app.inject({
      method: 'POST',
      url: '/api/hosts/core-01/discovery/preview',
      payload: { mapId: 'backbone-main' },
    });
    expect(preview.statusCode).toBe(200);
    const afterPreview = await app.inject({ method: 'GET', url: '/api/maps/backbone-main' });
    expect(afterPreview.json().nodes).toHaveLength(before.json().nodes.length);
    expect(afterPreview.json().links).toHaveLength(before.json().links.length);

    const candidate = preview
      .json()
      .neighbors.find((neighbor: { linkExists: boolean }) => !neighbor.linkExists);
    if (candidate) {
      const applied = await app.inject({
        method: 'POST',
        url: '/api/hosts/core-01/discovery/apply',
        payload: {
          previewId: preview.json().id,
          selections: [{ neighborId: candidate.id, action: 'ADD' }],
        },
      });
      expect(applied.statusCode).toBe(200);
    }
  });

  it('rejects plaintext credentials when encryption is not configured', async () => {
    await app.close();
    app = await buildApp({ credentialEncryptionKey: null });
    const response = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      payload: {
        hostname: 'secret-test',
        displayName: 'Secret test',
        managementIp: '10.0.0.9',
        vendor: '',
        model: '',
        deviceType: 'generic',
        site: '',
        description: '',
        notes: '',
        origin: 'MANUAL',
        zabbix: { enabled: false, hostId: '', hostName: '', primaryInterfaceId: '', ip: '' },
        ssh: {
          enabled: true,
          host: '10.0.0.9',
          port: 22,
          username: 'admin',
          password: 'never-return-me',
        },
        snmp: {
          enabled: false,
          version: 'SNMP_V2C',
          host: '10.0.0.9',
          port: 161,
          username: '',
          securityLevel: 'NO_AUTH_NO_PRIV',
          authProtocol: null,
          privacyProtocol: null,
        },
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain('never-return-me');
  });

  it('edits an existing conceptual node without touching links, position or identity', async () => {
    const map = (await app.inject({ method: 'GET', url: '/api/maps/backbone-main' })).json();
    const host = map.devices.find(
      (device: { id: string; interfaces: unknown[] }) =>
        device.interfaces.length > 0 && device.id !== 'customers',
    );
    const created = (
      await app.inject({
        method: 'POST',
        url: `/api/maps/${map.id}/generic-nodes`,
        payload: { type: 'CARRIER', label: 'Operadora A', position: { x: 512.5, y: 348.25 } },
      })
    ).json();
    const link = (
      await app.inject({
        method: 'POST',
        url: `/api/maps/${map.id}/links`,
        payload: {
          sourceDeviceId: host.id,
          sourceInterfaceId: host.interfaces[0].id,
          targetNodeId: created.id,
          targetInterfaceId: null,
          capacityBps: host.interfaces[0].speedBps,
          autoCapacityBps: host.interfaces[0].speedBps,
          capacitySource: 'AUTO',
          label: 'PNI Operadora A',
          metricSource: 'DEMO',
          visualStyle: null,
          metricDisplay: null,
        },
      })
    ).json();

    // Position and internals are not part of the editable contract and are dropped.
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/maps/${map.id}/nodes/${created.id}`,
      payload: {
        label: 'Operadora B',
        genericType: 'DATACENTER',
        locked: true,
        position: { x: 0, y: 0 },
        deviceId: 'hacked',
        nodeKind: 'DEVICE',
        mapId: 'other-map',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: created.id,
      mapId: map.id,
      deviceId: null,
      nodeKind: 'GENERIC',
      genericType: 'DATACENTER',
      label: 'Operadora B',
      locked: true,
      position: { x: 512.5, y: 348.25 },
      positionSource: 'MANUAL',
    });

    // survives a reload, and the associated link is still there and still points at it
    const reload = (await app.inject({ method: 'GET', url: `/api/maps/${map.id}` })).json();
    const persisted = reload.nodes.find((node: { id: string }) => node.id === created.id);
    expect(persisted).toMatchObject({
      id: created.id,
      mapId: map.id,
      deviceId: null,
      genericType: 'DATACENTER',
      label: 'Operadora B',
      locked: true,
      position: { x: 512.5, y: 348.25 },
    });
    expect(reload.links.find((item: { id: string }) => item.id === link.id)).toMatchObject({
      id: link.id,
      // the link had no DEVICE on the target side, so it always is SINGLE_ENDED
      targetNodeId: created.id,
      label: 'PNI Operadora A',
    });

    // a partial edit only changes what was sent
    const partial = await app.inject({
      method: 'PATCH',
      url: `/api/maps/${map.id}/nodes/${created.id}`,
      payload: { locked: false },
    });
    expect(partial.statusCode).toBe(200);
    expect(partial.json()).toMatchObject({
      label: 'Operadora B',
      genericType: 'DATACENTER',
      locked: false,
    });
  });

  it('refuses to edit DEVICE nodes or unknown conceptual nodes through the node endpoint', async () => {
    const map = (await app.inject({ method: 'GET', url: '/api/maps/backbone-main' })).json();
    const deviceNode = map.nodes.find((node: { deviceId: string | null }) => node.deviceId);
    const before = structuredClone(deviceNode);

    const deviceEdit = await app.inject({
      method: 'PATCH',
      url: `/api/maps/${map.id}/nodes/${deviceNode.id}`,
      payload: { label: 'Nope', genericType: 'CLOUD', locked: true },
    });
    expect(deviceEdit.statusCode).toBe(404);

    const missing = await app.inject({
      method: 'PATCH',
      url: `/api/maps/${map.id}/nodes/does-not-exist`,
      payload: { label: 'Nope' },
    });
    expect(missing.statusCode).toBe(404);

    const reload = (await app.inject({ method: 'GET', url: `/api/maps/${map.id}` })).json();
    expect(reload.nodes.find((node: { id: string }) => node.id === deviceNode.id)).toEqual(before);
  });

  it('rejects invalid conceptual node payloads', async () => {
    const map = (await app.inject({ method: 'GET', url: '/api/maps/backbone-main' })).json();
    const node = (
      await app.inject({
        method: 'POST',
        url: `/api/maps/${map.id}/generic-nodes`,
        payload: { type: 'CLOUD', label: 'Transit', position: { x: 10, y: 10 } },
      })
    ).json();

    for (const payload of [{ label: '' }, { genericType: '' }, { locked: 'yes' }, { label: 'x'.repeat(121) }]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/maps/${map.id}/nodes/${node.id}`,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }

    const reload = (await app.inject({ method: 'GET', url: `/api/maps/${map.id}` })).json();
    expect(reload.nodes.find((item: { id: string }) => item.id === node.id)).toMatchObject({
      label: 'Transit',
      genericType: 'CLOUD',
      locked: false,
    });
  });

  it('persists the manual link connection sides without touching the logical endpoints', async () => {
    const map = (await app.inject({ method: 'GET', url: '/api/maps/backbone-main' })).json();
    const source = map.devices.find(
      (device: { id: string; interfaces: unknown[] }) =>
        device.interfaces.length > 0 && device.id !== 'customers',
    );
    const target = map.devices.find(
      (device: { id: string; interfaces: unknown[] }) =>
        device.interfaces.length > 0 && device.id !== source.id && device.id !== 'customers',
    );
    const payload = {
      sourceDeviceId: source.id,
      sourceInterfaceId: source.interfaces[0].id,
      targetDeviceId: target.id,
      targetInterfaceId: target.interfaces[0].id,
      capacityBps: 1_000_000_000,
      autoCapacityBps: 1_000_000_000,
      capacitySource: 'MANUAL',
      label: 'Rota manual',
      metricSource: 'DEMO',
      visualStyle: null,
      metricDisplay: null,
      sourceHandleSide: 'BOTTOM',
      targetHandleSide: 'LEFT',
    };

    const created = await app.inject({
      method: 'POST',
      url: `/api/maps/${map.id}/links`,
      payload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      sourceHandleSide: 'BOTTOM',
      targetHandleSide: 'LEFT',
    });
    const linkId = created.json().id;

    // a partial patch only changes the side that was sent
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/maps/${map.id}/links/${linkId}`,
      payload: {
        capacityBps: payload.capacityBps,
        autoCapacityBps: payload.autoCapacityBps,
        capacitySource: payload.capacitySource,
        label: payload.label,
        metricSource: payload.metricSource,
        visualStyle: null,
        metricDisplay: null,
        sourceHandleSide: 'TOP',
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      sourceHandleSide: 'TOP',
      targetHandleSide: 'LEFT',
      sourceDeviceId: source.id,
      targetDeviceId: target.id,
      sourceInterfaceId: source.interfaces[0].id,
      targetInterfaceId: target.interfaces[0].id,
      label: 'Rota manual',
    });

    // survives a reload, and the link was never removed
    const reload = (await app.inject({ method: 'GET', url: `/api/maps/${map.id}` })).json();
    expect(reload.links.find((item: { id: string }) => item.id === linkId)).toMatchObject({
      id: linkId,
      sourceDeviceId: source.id,
      targetDeviceId: target.id,
      sourceHandleSide: 'TOP',
      targetHandleSide: 'LEFT',
    });
  });

  it('defaults the connection sides to AUTO and rejects unknown sides', async () => {
    const map = (await app.inject({ method: 'GET', url: '/api/maps/backbone-main' })).json();
    // links seeded before this feature carry no side information
    expect(map.links[0]).toMatchObject({ sourceHandleSide: 'AUTO', targetHandleSide: 'AUTO' });

    const link = map.links[0];
    const base = {
      capacityBps: link.capacityBps,
      autoCapacityBps: link.autoCapacityBps,
      capacitySource: link.capacitySource,
      label: link.label,
      metricSource: link.metricSource,
      visualStyle: link.visualStyle,
      metricDisplay: link.metricDisplay,
    };
    for (const side of ['SIDEWAYS', 'top', '', 'TOP ']) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/maps/${map.id}/links/${link.id}`,
        payload: { ...base, sourceHandleSide: side },
      });
      expect(response.statusCode).toBe(400);
    }

    // the link is untouched by the rejected attempts
    const reload = (await app.inject({ method: 'GET', url: `/api/maps/backbone-main` })).json();
    expect(reload.links.find((item: { id: string }) => item.id === link.id)).toMatchObject({
      sourceHandleSide: 'AUTO',
      targetHandleSide: 'AUTO',
      sourceDeviceId: link.sourceDeviceId,
      targetDeviceId: link.targetDeviceId,
    });
  });
});
