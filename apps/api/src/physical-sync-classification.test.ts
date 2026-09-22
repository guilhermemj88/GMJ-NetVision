import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { HostRecord, NetworkInterface, PhysicalPort } from '@gmj/shared';
import { registerPhysicalRoutes } from './physical-routes';
import { DemoPhysicalRepository } from './infrastructure/physical/demo-physical-repository';
import { PhysicalService } from './infrastructure/physical/physical-service';
import { PhysicalInventoryError } from './infrastructure/physical/physical-repository';
import { findReconcilablePorts } from './infrastructure/physical/physical-domain';
import type { HostRepository } from './infrastructure/persistence/host-repository';

/**
 * Interface classification, synchronization and asset lifecycle with the real
 * catalog (`apps/api/catalog/physical-catalog-v1.yaml`) as source of truth.
 *
 * Vendor templates are authoritative: the sync only maps Device interfaces to
 * the declared panel. Generic/discovered assets may create connectors, but only
 * for PHYSICAL interfaces and always collapsed by connector key (breakout).
 */

const TIMESTAMP = '2026-09-21T12:00:00.000Z';

const MIKROTIK_KEY = 'mikrotik-crs328-24p-4splus-rm';
const HUAWEI_KEY = 'huawei-s6750-h48x8c';
const JUNIPER_KEY = 'juniper-mx80';
const JUNIPER_MODULE = 'juniper-mic-3d-20ge-sfp';

function networkInterface(deviceId: string, name: string, ifIndex: number): NetworkInterface {
  return {
    id: `if-${name}`,
    deviceId,
    name,
    alias: '',
    description: '',
    ifIndex,
    mac: '',
    mtu: 1500,
    speedBps: 1_000_000_000,
    adminStatus: 'UP',
    operStatus: 'UP',
    rxBps: 0,
    txBps: 0,
    rxUtilization: 0,
    txUtilization: 0,
    rxErrors: 0,
    txErrors: 0,
    rxDiscards: 0,
    txDiscards: 0,
  };
}

function hostRecord(id: string, names: string[]): HostRecord {
  return {
    id,
    name: id,
    displayName: id,
    hostname: id,
    ip: '10.0.0.1',
    managementIp: '10.0.0.1',
    vendor: 'Test',
    model: 'Test',
    status: 'UP',
    deviceType: 'switch',
    site: 'POP',
    source: 'MANUAL',
    discoveryMethod: 'MANUAL',
    uptimeSeconds: 0,
    pppSupported: false,
    pppOnline: 0,
    pppUpdatedAt: null,
    pppSource: null,
    updatedAt: TIMESTAMP,
    interfaces: names.map((name, index) => networkInterface(id, name, index + 1)),
    description: '',
    notes: '',
    origin: 'MANUAL',
    useZabbix: false,
    zabbix: null,
    sshEnabled: false,
    ssh: null,
    snmpEnabled: false,
    snmp: null,
    sourceHealth: {} as HostRecord['sourceHealth'],
    lastPollingAt: null,
    lastDiscoveryAt: null,
    mapIds: [],
    mapCount: 0,
    createdAt: TIMESTAMP,
  };
}

function fakeHosts(hosts: HostRecord[]): HostRepository {
  const byId = new Map(hosts.map((host) => [host.id, host]));
  return {
    listHosts: async () => [...hosts],
    getHost: async (id: string) => byId.get(id) ?? null,
  } as unknown as HostRepository;
}

interface SyncReport {
  ports: Array<{ id: string; name: string; role: string; mappedInterfaceId: string | null }>;
  created: number;
  mapped: number;
  skippedLogical: number;
  skippedUnknown: number;
  skippedByPolicy: number;
  badPorts: Array<{ id: string; name: string; interfaceName: string }>;
}

interface AssetResponse {
  id: string;
  name: string;
  ports: Array<{ name: string }>;
  slots: Array<{ id: string; index: number; module: unknown }>;
  template: {
    modules: Array<{ id: string; key?: string; catalogKey: string | null; name: string }>;
  } | null;
}

interface Harness {
  app: FastifyInstance;
  sync: (assetId: string) => Promise<SyncReport>;
  createRack: () => Promise<{ id: string }>;
  createAsset: (rackId: string, payload: Record<string, unknown>) => Promise<AssetResponse>;
}

async function harness(hosts: HostRecord[]): Promise<Harness> {
  const app = Fastify();
  const repository = new DemoPhysicalRepository(fakeHosts(hosts));
  const service = new PhysicalService(repository);
  registerPhysicalRoutes(app, { repository, service });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ message: 'Invalid request' });
    if (error instanceof PhysicalInventoryError) {
      return reply.code(error.statusCode).send({ message: error.message });
    }
    return reply
      .code(500)
      .send({ message: error instanceof Error ? error.message : 'Unknown error' });
  });
  await app.ready();
  await app.inject({ method: 'POST', url: '/api/physical/catalog/bootstrap' });
  return {
    app,
    sync: async (assetId: string) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/physical/assets/${assetId}/sync-interfaces`,
      });
      expect(response.statusCode).toBe(200);
      return response.json() as SyncReport;
    },
    createRack: async () => {
      const site = await app.inject({
        method: 'POST',
        url: '/api/physical/sites',
        payload: { name: 'POP Centro', code: 'CTO' },
      });
      const rack = await app.inject({
        method: 'POST',
        url: `/api/physical/sites/${site.json().id}/racks`,
        payload: { name: 'Rack 01', units: 42 },
      });
      return rack.json() as { id: string };
    },
    createAsset: async (rackId: string, payload: Record<string, unknown>) => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/physical/racks/${rackId}/assets`,
        payload: { startU: 1, heightU: 1, ...payload },
      });
      expect(response.statusCode).toBe(201);
      return response.json() as AssetResponse;
    },
  };
}

describe('physical sync classification', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('never creates a connector for a logical interface of a vendor template device', async () => {
    const context = await harness([
      hostRecord('host-s6750', [
        'GigabitEthernet0/0/1',
        'GigabitEthernet0/0/2',
        'XGigabitEthernet0/0/1',
        '100GE1/0/1',
        '100GE1/0/1.100',
        'Vlanif100',
        'Vlanif200',
        'Vlanif300',
        'LoopBack0',
        'Eth-Trunk1',
        'Tunnel10',
      ]),
    ]);
    app = context.app;
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, {
      name: 'S6750',
      catalogKey: HUAWEI_KEY,
      kind: 'NETWORK',
      deviceId: 'host-s6750',
    });

    const report = await context.sync(asset.id);
    const names = report.ports.map((port) => port.name);
    expect(names.some((name) => name.startsWith('Vlanif'))).toBe(false);
    expect(names).not.toContain('100GE1/0/1.100');
    expect(names).not.toContain('LoopBack0');
    expect(names).not.toContain('Eth-Trunk1');
    expect(names).not.toContain('Tunnel10');
    // vendor template is authoritative: only the declared panel exists
    expect(report.created).toBe(0);
    expect(report.ports).toHaveLength(56);
    expect(report.skippedLogical).toBe(7);
    expect(report.skippedUnknown).toBe(0);
    expect(report.skippedByPolicy).toBe(4);
  });

  it('maps the template connectors instead of duplicating them', async () => {
    const context = await harness([
      hostRecord('host-mikrotik', [
        'ether1',
        'ether2',
        'sfp-sfpplus1',
        'vlan100',
        'bridge1',
        'pppoe-out1',
      ]),
    ]);
    app = context.app;
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, {
      name: 'CRS328',
      catalogKey: MIKROTIK_KEY,
      deviceId: 'host-mikrotik',
    });

    const report = await context.sync(asset.id);
    expect(report.mapped).toBe(3);
    expect(report.created).toBe(0);
    expect(report.skippedLogical).toBe(3);
    expect(report.ports).toHaveLength(28);
    const mapped = report.ports.filter((port) => port.mappedInterfaceId).map((port) => port.name);
    expect(mapped).toEqual(['ether1', 'ether2', 'sfp-sfpplus1']);
  });

  it('does not create a connector for an unrecognized interface name', async () => {
    const context = await harness([
      hostRecord('host-generic', ['GigabitEthernet0/0/1', 'core-engine-zone']),
    ]);
    app = context.app;
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, {
      name: 'GenÃ©rico',
      kind: 'GENERIC',
      deviceId: 'host-generic',
    });

    const report = await context.sync(asset.id);
    expect(report.created).toBe(1);
    expect(report.skippedUnknown).toBe(1);
    expect(report.ports.map((port) => port.name)).toEqual(['GigabitEthernet0/0/1']);
  });

  it('creates connectors for a generic asset only when they are physical', async () => {
    const context = await harness([
      hostRecord('host-generic', ['eth0', 'eth1', 'ens192', 'vlan10', 'docker0', 'br0']),
    ]);
    app = context.app;
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, {
      name: 'Servidor',
      kind: 'SERVER',
      deviceId: 'host-generic',
    });

    const report = await context.sync(asset.id);
    expect(report.ports.map((port) => port.name).sort()).toEqual(['ens192', 'eth0', 'eth1']);
    expect(report.skippedLogical).toBe(3);
  });

  it('does not duplicate the chassis connector when the device reports breakout lanes', async () => {
    const context = await harness([
      hostRecord('host-juniper', [
        'et-0/0/0',
        'et-0/0/0:0',
        'et-0/0/0:1',
        'xe-0/0/1',
        'xe-0/0/1.100',
        'ge-0/0/0',
        'ge-0/0/0.0',
        'irb.100',
        'lo0.0',
        'ae0',
      ]),
    ]);
    app = context.app;
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, {
      name: 'MX',
      kind: 'NETWORK',
      deviceId: 'host-juniper',
    });

    const report = await context.sync(asset.id);
    expect(report.ports.map((port) => port.name).sort()).toEqual([
      'et-0/0/0',
      'ge-0/0/0',
      'xe-0/0/1',
    ]);
    expect(report.skippedLogical).toBe(7);
    expect(report.badPorts).toEqual([]);
  });

  it('collapses MikroTik QSFP28 lanes into the cage of a generic asset', async () => {
    const context = await harness([
      hostRecord('host-crs504', [
        'qsfp28-1-1',
        'qsfp28-1-2',
        'qsfp28-1-3',
        'qsfp28-1-4',
        'qsfp28-2',
        'vlan10',
      ]),
    ]);
    app = context.app;
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, {
      name: 'CRS504',
      kind: 'NETWORK',
      deviceId: 'host-crs504',
    });

    const report = await context.sync(asset.id);
    // one connector for the cage of lane 1 (lanes 2-4 find the cage already
    // created and never add extras) plus the second cage reported directly
    expect(report.created).toBe(2);
    expect(report.ports.map((port) => port.name)).toEqual(['qsfp28-1', 'qsfp28-2']);
    expect(report.skippedLogical).toBe(4);
    const inventory = await app.inject({ method: 'GET', url: '/api/physical' });
    const stored = inventory.json().sites[0].racks[0].assets[0];
    expect(
      stored.ports.filter((port: { name: string }) => port.name.startsWith('qsfp28')),
    ).toHaveLength(2);
    // the lane interface is the one linked to the cage connector
    const cage = stored.ports.find((port: { name: string }) => port.name === 'qsfp28-1');
    expect(cage.mappedInterfaceId).toBe('if-qsfp28-1-1');

    // a second sync never fabricates a connector per lane and never steals the cage
    const again = await context.sync(asset.id);
    expect(again.created).toBe(0);
    expect(again.mapped).toBe(2);
    expect(again.skippedLogical).toBe(4);
    expect(again.badPorts).toEqual([]);
    const after = (await app.inject({ method: 'GET', url: '/api/physical' }))
      .json()
      .sites[0].racks[0].assets[0].ports.filter((port: { name: string }) =>
        port.name.startsWith('qsfp28'),
      );
    expect(after).toHaveLength(2);
  });

  it('is idempotent: a second sync keeps the same ports', async () => {
    const context = await harness([
      hostRecord('host-s6750', ['GigabitEthernet0/0/1', 'Vlanif100', '100GE1/0/1.100']),
    ]);
    app = context.app;
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, {
      name: 'S6750',
      catalogKey: HUAWEI_KEY,
      kind: 'NETWORK',
      deviceId: 'host-s6750',
    });

    const first = await context.sync(asset.id);
    const second = await context.sync(asset.id);
    expect(second.ports.map((port) => port.id).sort()).toEqual(
      first.ports.map((port) => port.id).sort(),
    );
    expect(second.created).toBe(0);
    expect(second.mapped).toBe(0);
    expect(second.skippedLogical).toBe(2);
    expect(second.badPorts).toEqual([]);
  });

  it('materializes the slots and modules declared by a modular vendor template', async () => {
    const context = await harness([hostRecord('host-mx80', ['ge-0/0/0'])]);
    app = context.app;
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, {
      name: 'MX80',
      catalogKey: JUNIPER_KEY,
      kind: 'NETWORK',
      deviceId: 'host-mx80',
    });
    expect(asset.slots.length).toBe(3);
    const board = asset.template!.modules.find(
      (module) => module.catalogKey === JUNIPER_MODULE,
    )!;
    expect(board).toBeDefined();

    const installed = await app.inject({
      method: 'POST',
      url: `/api/physical/assets/${asset.id}/modules`,
      payload: { slotId: asset.slots[0]!.id, moduleTemplateId: board.id, name: board.name },
    });
    expect(installed.statusCode).toBe(201);
    expect(installed.json().ports).toHaveLength(20);
  });
});

describe('reconciliation protects operator and template ports', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('preserves MANUAL, TEMPLATE and UNKNOWN; removes only DISCOVERED logical without cable', () => {
    const base = {
      connectionId: null,
      pairedPortId: null,
      templatePortId: null,
      mappedInterface: null,
    };
    const ports = [
      { ...base, id: 'manual', name: 'Vlanif100', role: 'MANUAL' as const },
      { ...base, id: 'template', name: 'Vlanif200', role: 'TEMPLATE' as const },
      { ...base, id: 'discovered', name: 'Vlanif300', role: 'DISCOVERED' as const },
      {
        ...base,
        id: 'discovered-cable',
        name: 'Vlanif400',
        role: 'DISCOVERED' as const,
        connectionId: 'connection-1',
      },
      { ...base, id: 'unknown', name: 'core-engine-zone', role: 'DISCOVERED' as const },
      {
        ...base,
        id: 'paired',
        name: 'Vlanif500',
        role: 'DISCOVERED' as const,
        pairedPortId: 'other-port',
      },
      {
        ...base,
        id: 'from-template',
        name: 'Vlanif600',
        role: 'DISCOVERED' as const,
        templatePortId: 'template-port-1',
      },
      { ...base, id: 'physical', name: 'ether1', role: 'DISCOVERED' as const },
      {
        ...base,
        id: 'cage',
        name: 'qsfp28-1',
        role: 'DISCOVERED' as const,
        mappedInterface: { name: 'qsfp28-1-1' },
      },
      {
        ...base,
        id: 'legacy-lane',
        name: 'qsfp28-1-2',
        role: 'DISCOVERED' as const,
        mappedInterface: { name: 'qsfp28-1-2' },
      },
    ];
    const found = findReconcilablePorts(ports as unknown as PhysicalPort[]);
    // the collapsed cage (`qsfp28-1`) survives; a connector named after the lane
    // itself was fabricated by the old sync and can go
    expect(found.map((port) => port.id)).toEqual(['discovered', 'legacy-lane']);
  });

  it('keeps a MANUAL port named after a logical interface on the real endpoint', async () => {
    const context = await harness([hostRecord('host-huawei', ['GigabitEthernet0/0/1'])]);
    app = context.app;
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, { name: 'S5720', kind: 'NETWORK' });
    const manual = await app.inject({
      method: 'POST',
      url: `/api/physical/assets/${asset.id}/ports`,
      payload: { name: 'Vlanif100', order: 1, type: 'OTHER' },
    });
    expect(manual.statusCode).toBe(201);
    const reconcile = await app.inject({
      method: 'POST',
      url: `/api/physical/assets/${asset.id}/reconcile-ports`,
    });
    expect(reconcile.json()).toMatchObject({ removed: 0, kept: 0 });
    const inventory = await app.inject({ method: 'GET', url: '/api/physical' });
    expect(inventory.json().sites[0].racks[0].assets[0].ports).toHaveLength(1);
  });

  it('keeps a TEMPLATE port even when its name looks logical', async () => {
    const context = await harness([hostRecord('host-generic', ['ether1'])]);
    app = context.app;
    const rack = await context.createRack();
    const template = await app.inject({
      method: 'POST',
      url: '/api/physical/templates',
      payload: {
        name: 'Template com nome lÃ³gico',
        kind: 'NETWORK',
        heightU: 1,
        ports: [{ name: 'Vlanif700', order: 1, type: 'OTHER' }],
      },
    });
    expect(template.statusCode).toBe(201);
    const asset = await context.createAsset(rack.id, {
      name: 'Custom',
      templateId: template.json().id,
      startU: 1,
      heightU: 1,
    });
    const reconcile = await app.inject({
      method: 'POST',
      url: `/api/physical/assets/${asset.id}/reconcile-ports`,
    });
    expect(reconcile.json()).toMatchObject({ removed: 0, kept: 0 });
    const inventory = await app.inject({ method: 'GET', url: '/api/physical' });
    const ports = inventory.json().sites[0].racks[0].assets[0].ports;
    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatchObject({ name: 'Vlanif700', role: 'TEMPLATE' });
  });
});

describe('physical asset lifecycle', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('keeps the asset when the interface sync fails (create + sync are independent)', async () => {
    const context = await harness([hostRecord('host-mikrotik', ['ether1'])]);
    app = context.app;
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, { name: 'SW sem device', kind: 'NETWORK' });

    const failed = await app.inject({
      method: 'POST',
      url: `/api/physical/assets/${asset.id}/sync-interfaces`,
    });
    expect(failed.statusCode).toBe(400);
    expect(failed.json().message).toContain('Vincule um Device real');

    const inventory = await app.inject({ method: 'GET', url: '/api/physical' });
    const assets = inventory.json().sites[0].racks[0].assets as Array<{ id: string; name: string }>;
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({ id: asset.id, name: 'SW sem device' });
  });

  it('deletes an asset without cables and keeps the linked Device untouched', async () => {
    const context = await harness([hostRecord('host-mikrotik', ['ether1'])]);
    app = context.app;
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, {
      name: 'SW-01',
      kind: 'NETWORK',
      deviceId: 'host-mikrotik',
    });
    const synced = await context.sync(asset.id);
    expect(synced.created).toBe(1);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/physical/assets/${asset.id}`,
    });
    expect(response.statusCode).toBe(204);
    const inventory = await app.inject({ method: 'GET', url: '/api/physical' });
    expect(inventory.json().sites[0].racks[0].assets).toEqual([]);
    const recreated = await context.createAsset(rack.id, {
      name: 'SW-01 novo',
      kind: 'NETWORK',
      deviceId: 'host-mikrotik',
    });
    expect(recreated.id).not.toBe(asset.id);
  });

  it('refuses to delete an asset that still owns a cable', async () => {
    const context = await harness([hostRecord('host-mikrotik', ['ether1'])]);
    app = context.app;
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, { name: 'SW-01', kind: 'NETWORK' });
    const peer = await context.createAsset(rack.id, {
      name: 'Patch',
      kind: 'GENERIC',
      startU: 8,
      heightU: 1,
    });
    const portA = await app.inject({
      method: 'POST',
      url: `/api/physical/assets/${asset.id}/ports`,
      payload: { name: 'P1', order: 1, type: 'RJ45' },
    });
    const portB = await app.inject({
      method: 'POST',
      url: `/api/physical/assets/${peer.id}/ports`,
      payload: { name: 'P1', order: 1, type: 'RJ45' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/physical/connections',
      payload: { portAId: portA.json().id, portBId: portB.json().id },
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/physical/assets/${asset.id}`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain('Desconecte os cabos');
    const inventory = await app.inject({ method: 'GET', url: '/api/physical' });
    expect(inventory.json().sites[0].racks[0].assets).toHaveLength(2);
  });
});

