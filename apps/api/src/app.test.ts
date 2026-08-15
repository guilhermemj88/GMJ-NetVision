import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
});
