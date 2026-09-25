import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { HostRecord, NetworkInterface, PhysicalPort } from '@gmj/shared';
import { registerPhysicalRoutes } from './physical-routes';
import { DemoPhysicalRepository } from './infrastructure/physical/demo-physical-repository';
import { PhysicalService } from './infrastructure/physical/physical-service';
import { PhysicalInventoryError } from './infrastructure/physical/physical-repository';
import {
  correlateCatalogPanelAliases,
  correlatePanelLabels,
  findReconcilablePorts,
  panelFamilyIdentity,
  planInterfaceSync,
} from './infrastructure/physical/physical-domain';
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
  unrecognized: Array<{ interfaceName: string; classification: string; reason: string }>;
  ignoredLogical: Array<{ interfaceName: string; classification: string; reason: string }>;
  badPorts: Array<{ id: string; name: string; interfaceName: string }>;
}

interface AssetResponse {
  id: string;
  name: string;
  ports: Array<{ id: string; name: string }>;
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
    // V1.1: 24 ether + 4 SFP+ + 1 console declarado pelo fabricante
    expect(report.ports).toHaveLength(29);
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

/**
 * O painel do catálogo usa rótulos curtos (`100GE-1`) enquanto o CLI reporta o
 * nome hierárquico (`100GE1/0/1`). A correlação é ordinal por família e nunca
 * adivinha quando as contagens divergem.
 */
describe('correlação entre rótulo de painel e nome CLI', () => {
  it('identifica a família sem confundir 100GE com 10GE', () => {
    expect(panelFamilyIdentity('100GE-1')).toMatchObject({
      family: '100ge',
      kind: 'label',
      numbers: [100, 1],
    });
    expect(panelFamilyIdentity('100GE1/0/1')).toMatchObject({
      family: '100ge',
      kind: 'hierarchical',
      numbers: [100, 1, 0, 1],
    });
    expect(panelFamilyIdentity('10GE-1')?.family).toBe('10ge');
    expect(panelFamilyIdentity('10GE1/0/28')?.family).toBe('10ge');
    expect(panelFamilyIdentity('SFP+-1')?.family).toBe('sfpplus');
    expect(panelFamilyIdentity('sfp-sfpplus1')?.family).toBe('sfpsfpplus');
    // a forma do nome é neutra: quem separa lógicas de físicas é classifyPhysicalInterface
    expect(panelFamilyIdentity('Vlanif100')?.kind).toBe('label');
    expect(panelFamilyIdentity('ge-0/0/0')?.kind).toBe('hierarchical');
    expect(panelFamilyIdentity('sfp1')?.kind).toBe('label');
  });

  it('correlaciona por posição quando a família tem as mesmas portas dos dois lados', () => {
    const ports = Array.from({ length: 20 }, (_value, index) => ({
      id: `port-25ge-${index + 1}`,
      name: `25GE-${index + 1}`,
      side: 'DEVICE' as const,
      mappedInterfaceId: null,
    }));
    const interfaces = Array.from({ length: 20 }, (_value, index) => ({
      id: `if-25ge-${index + 1}`,
      name: `25GE1/0/${index + 1}`,
    }));
    const correlation = correlatePanelLabels(ports, interfaces);
    expect(correlation.size).toBe(20);
    expect(correlation.get('if-25ge-5')).toBe('port-25ge-5');
    expect(correlation.get('if-25ge-20')).toBe('port-25ge-20');
  });

  it('não correlaciona quando o device reporta um subconjunto da família', () => {
    const ports = Array.from({ length: 20 }, (_value, index) => ({
      id: `port-25ge-${index + 1}`,
      name: `25GE-${index + 1}`,
      side: 'DEVICE' as const,
      mappedInterfaceId: null,
    }));
    const interfaces = Array.from({ length: 4 }, (_value, index) => ({
      id: `if-25ge-${index + 1}`,
      name: `25GE1/0/${index + 1}`,
    }));
    expect(correlatePanelLabels(ports, interfaces).size).toBe(0);
  });

  it('não correlaciona dois nomes hierárquicos entre si', () => {
    const ports = [
      { id: 'port-1', name: '100GE1/0/1', side: 'DEVICE' as const, mappedInterfaceId: null },
      { id: 'port-2', name: '100GE1/0/2', side: 'DEVICE' as const, mappedInterfaceId: null },
    ];
    const interfaces = [
      { id: 'if-1', name: '100GE1/0/1' },
      { id: 'if-2', name: '100GE1/0/2' },
    ];
    expect(correlatePanelLabels(ports, interfaces).size).toBe(0);
  });

  it('mapeia as 56 portas do F1A-8H20Q pelo painel declarado no catálogo', async () => {
    // numeração FÍSICA do painel (0-55), igual à declaração do catálogo
    const names = [
      ...Array.from({ length: 28 }, (_value, index) => `10GE1/0/${index}`),
      ...Array.from({ length: 8 }, (_value, index) => `25GE1/0/${28 + index}`),
      ...Array.from({ length: 12 }, (_value, index) => `25GE1/0/${36 + index}`),
      ...Array.from({ length: 8 }, (_value, index) => `100GE1/0/${48 + index}`),
    ];
    const context = await harness([hostRecord('host-f1a', names)]);
    const app = context.app;
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, {
      name: 'BHE-VTA-F1A-BGP',
      catalogKey: 'huawei-ne8000-f1a-8h20q',
      kind: 'NETWORK',
      deviceId: 'host-f1a',
    });
    expect(asset.ports).toHaveLength(56);

    const report = await context.sync(asset.id);
    expect(report.created).toBe(0);
    expect(report.mapped).toBe(56);
    expect(report.skippedLogical).toBe(0);
    expect(report.skippedByPolicy).toBe(0);
    expect(report.unrecognized).toEqual([]);
    const mapped = report.ports.filter((port) => port.mappedInterfaceId).map((port) => port.name);
    expect(mapped).toHaveLength(56);
    expect(mapped).toContain('10GE-0');
    expect(mapped).toContain('25GE-28');
    expect(mapped).toContain('25GE-47');
    expect(mapped).toContain('100GE-55');
    await app.close();
  });
});

/**
 * `XGigabitEthernet`/`100GE` do VRP só viram `10GE-N`/`QSFP28-N` nos modelos do
 * S6730: a exceção é amarrada ao `catalogKey` e nunca vale como regra global.
 */
describe('alias de painel do catálogo (S6730)', () => {
  const S6730_H48 = 'huawei-s6730-h48x6c';
  const S6730_H24 = 'huawei-s6730-h24x6c';

  const cliNames = (servicePorts: number, uplinkPorts: number, slot = '0/0'): string[] => [
    ...Array.from(
      { length: servicePorts },
      (_value, index) => `XGigabitEthernet${slot}/${index + 1}`,
    ),
    ...Array.from({ length: uplinkPorts }, (_value, index) => `100GE${slot}/${index + 1}`),
  ];

  const ifTargets = (names: readonly string[]) =>
    names.map((name) => ({ id: `if-${name}`, name }));

  const panel = (servicePorts: number, uplinkPorts = 6) => [
    ...Array.from({ length: servicePorts }, (_value, index) => ({
      id: `port-10ge-${index + 1}`,
      name: `10GE-${index + 1}`,
      side: 'DEVICE' as const,
      mappedInterfaceId: null,
    })),
    ...Array.from({ length: uplinkPorts }, (_value, index) => ({
      id: `port-qsfp28-${index + 1}`,
      name: `QSFP28-${index + 1}`,
      side: 'DEVICE' as const,
      mappedInterfaceId: null,
    })),
  ];

  it('correlaciona as duas famílias pelo ordinal final do CLI, sem exigir slot 0/0', () => {
    const correlation = correlateCatalogPanelAliases(
      panel(48),
      ifTargets([...cliNames(48, 0, '1/0'), ...cliNames(0, 6)]),
      S6730_H48,
    );
    expect(correlation.size).toBe(54);
    expect(correlation.get('if-XGigabitEthernet1/0/1')).toBe('port-10ge-1');
    expect(correlation.get('if-XGigabitEthernet1/0/48')).toBe('port-10ge-48');
    expect(correlation.get('if-100GE0/0/1')).toBe('port-qsfp28-1');
    expect(correlation.get('if-100GE0/0/6')).toBe('port-qsfp28-6');
  });

  it('não adivinha subconjunto nem aceita ordinal duplicado', () => {
    const subset = correlateCatalogPanelAliases(
      panel(48),
      ifTargets(cliNames(48, 3)),
      S6730_H48,
    );
    expect(subset.size).toBe(48);
    expect(subset.get('if-100GE0/0/1')).toBeUndefined();

    const duplicated = correlateCatalogPanelAliases(
      panel(0),
      ifTargets([
        '100GE0/0/1',
        '100GE1/0/1',
        '100GE0/0/3',
        '100GE0/0/4',
        '100GE0/0/5',
        '100GE0/0/6',
      ]),
      S6730_H48,
    );
    expect(duplicated.size).toBe(0);
  });

  it('não correlaciona fora dos catalogKey do S6730', () => {
    const names = ifTargets(cliNames(48, 6));
    expect(correlateCatalogPanelAliases(panel(48), names, 'huawei-s6750-h48x8c').size).toBe(0);
    expect(
      correlateCatalogPanelAliases(panel(48), names, 'huawei-ne8000-f1a-8h20q').size,
    ).toBe(0);
    expect(correlateCatalogPanelAliases(panel(48), names, null).size).toBe(0);
    expect(correlateCatalogPanelAliases(panel(48), names, S6730_H48 + '-x').size).toBe(0);
  });

  it('mapeia as 54 portas do S6730-H48X6C e continua idempotente', async () => {
    const context = await harness([hostRecord('host-s6730-h48', cliNames(48, 6))]);
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, {
      name: 'SW-CORE-S6730-48',
      catalogKey: S6730_H48,
      kind: 'NETWORK',
      deviceId: 'host-s6730-h48',
    });
    expect(asset.ports).toHaveLength(54);

    const report = await context.sync(asset.id);
    expect(report.created).toBe(0);
    expect(report.mapped).toBe(54);
    expect(report.skippedByPolicy).toBe(0);
    const mappedInterface = (portName: string) =>
      report.ports.find((port) => port.name === portName)?.mappedInterfaceId;
    expect(mappedInterface('10GE-1')).toBe('if-XGigabitEthernet0/0/1');
    expect(mappedInterface('10GE-48')).toBe('if-XGigabitEthernet0/0/48');
    expect(mappedInterface('QSFP28-1')).toBe('if-100GE0/0/1');
    expect(mappedInterface('QSFP28-6')).toBe('if-100GE0/0/6');

    const again = await context.sync(asset.id);
    expect(again.created).toBe(0);
    expect(again.mapped).toBe(54);
    expect(again.skippedByPolicy).toBe(0);
    await context.app.close();
  });

  it('mapeia as 30 portas do S6730-H24X6C', async () => {
    const context = await harness([hostRecord('host-s6730-h24', cliNames(24, 6))]);
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, {
      name: 'SW-ACCESS-S6730-24',
      catalogKey: S6730_H24,
      kind: 'NETWORK',
      deviceId: 'host-s6730-h24',
    });
    expect(asset.ports).toHaveLength(30);

    const report = await context.sync(asset.id);
    expect(report.created).toBe(0);
    expect(report.mapped).toBe(30);
    expect(report.skippedByPolicy).toBe(0);
    const mappedInterface = (portName: string) =>
      report.ports.find((port) => port.name === portName)?.mappedInterfaceId;
    expect(mappedInterface('10GE-1')).toBe('if-XGigabitEthernet0/0/1');
    expect(mappedInterface('10GE-24')).toBe('if-XGigabitEthernet0/0/24');
    expect(mappedInterface('QSFP28-6')).toBe('if-100GE0/0/6');
    await context.app.close();
  });

  it('não associa as 3 interfaces 100GE quando o painel declara 6 QSFP28', async () => {
    const context = await harness([hostRecord('host-s6730-subset', cliNames(48, 3))]);
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, {
      name: 'SW-PARCIAL-S6730-48',
      catalogKey: S6730_H48,
      kind: 'NETWORK',
      deviceId: 'host-s6730-subset',
    });

    const report = await context.sync(asset.id);
    expect(report.created).toBe(0);
    expect(report.mapped).toBe(48);
    expect(report.skippedByPolicy).toBe(3);
    const mapped = report.ports.filter((port) => port.mappedInterfaceId).map((port) => port.name);
    expect(mapped).toContain('10GE-1');
    expect(mapped).toContain('10GE-48');
    expect(mapped.some((name) => name.startsWith('QSFP28'))).toBe(false);
    await context.app.close();
  });

  it('mantém o alias restrito: os mesmos nomes não mapeiam em S6750 nem no F1A', async () => {
    const names = cliNames(48, 6);
    for (const catalogKey of ['huawei-s6750-h48x8c', 'huawei-ne8000-f1a-8h20q']) {
      const context = await harness([hostRecord(`host-outro-${catalogKey}`, names)]);
      const rack = await context.createRack();
      const asset = await context.createAsset(rack.id, {
        name: `OUTRO-${catalogKey}`,
        catalogKey,
        kind: 'NETWORK',
        deviceId: `host-outro-${catalogKey}`,
      });
      const report = await context.sync(asset.id);
      expect(report.created).toBe(0);
      expect(report.mapped).toBe(0);
      expect(report.skippedByPolicy).toBe(54);
      await context.app.close();
    }
  });
});

/**
 * S6750-H36C: o painel declara 36 QSFP28 (`QSFP28-1..36`) e o VRP apresenta as
 * mesmas portas como `100GE<slot>/<subslot>/N`. O alias do modelo correlaciona
 * **somente pelo ordinal final** — o slot/member varia e não pode ser fixado.
 */
describe('alias de painel do catálogo (S6750-H36C)', () => {
  const S6750_H36C = 'huawei-s6750-h36c';

  const qsfpPanel = () =>
    Array.from({ length: 36 }, (_value, index) => ({
      id: `port-qsfp28-${index + 1}`,
      name: `QSFP28-${index + 1}`,
      side: 'DEVICE' as const,
      mappedInterfaceId: null,
    }));

  const hundredGe = (count = 36, slot = '1/0') =>
    Array.from({ length: count }, (_value, index) => `100GE${slot}/${index + 1}`);

  const ifTargets = (names: readonly string[]) =>
    names.map((name) => ({ id: `if-${name}`, name }));

  it('correlaciona as 36 portas QSFP28 com 100GE1/0/1..36', () => {
    const correlation = correlateCatalogPanelAliases(
      qsfpPanel(),
      ifTargets(hundredGe(36, '1/0')),
      S6750_H36C,
    );

    expect(correlation.size).toBe(36);
    expect(correlation.get('if-100GE1/0/1')).toBe('port-qsfp28-1');
    expect(correlation.get('if-100GE1/0/18')).toBe('port-qsfp28-18');
    expect(correlation.get('if-100GE1/0/36')).toBe('port-qsfp28-36');
  });

  it('não fixa o slot: 100GE2/0/1..36 correlaciona igual', () => {
    const correlation = correlateCatalogPanelAliases(
      qsfpPanel(),
      ifTargets(hundredGe(36, '2/0')),
      S6750_H36C,
    );

    expect(correlation.size).toBe(36);
    expect(correlation.get('if-100GE2/0/1')).toBe('port-qsfp28-1');
    expect(correlation.get('if-100GE2/0/36')).toBe('port-qsfp28-36');
  });

  it('não aplica correlação parcial quando falta uma interface', () => {
    const correlation = correlateCatalogPanelAliases(
      qsfpPanel(),
      ifTargets(hundredGe(35, '1/0')),
      S6750_H36C,
    );

    expect(correlation.size).toBe(0);
  });

  it('ordinal duplicado invalida a correlação da família', () => {
    const correlation = correlateCatalogPanelAliases(
      qsfpPanel(),
      ifTargets([...hundredGe(34, '1/0'), '100GE9/0/35', '100GE9/0/35', '100GE9/0/36']),
      S6750_H36C,
    );

    expect(correlation.size).toBe(0);
  });

  it('não vaza para outros modelos', () => {
    // O S6730 está fora de propósito: ele tem alias próprio (teste acima).
    for (const catalogKey of [
      'huawei-s6750-h48x8c',
      'huawei-s6750-h24x6c',
      'huawei-ne8000-f1a-8h20q',
      'mikrotik-crs328-24p-4splus-rm',
    ]) {
      expect(
        correlateCatalogPanelAliases(qsfpPanel(), ifTargets(hundredGe(36, '1/0')), catalogKey).size,
      ).toBe(0);
    }
  });

  it('mapeia as 36 portas no sync completo e ignora interfaces lógicas', async () => {
    const names = [...hundredGe(36, '1/0'), 'Vlanif1161', 'Eth-Trunk10', 'LoopBack0'];
    const context = await harness([hostRecord('host-s6750-h36c', names)]);
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, {
      name: 'SW-CORE-S6750-36',
      catalogKey: S6750_H36C,
      kind: 'NETWORK',
      deviceId: 'host-s6750-h36c',
    });
    expect(asset.ports).toHaveLength(36);
    // O painel cobre exatamente QSFP28-1..36: um offset duplicado
    // (`{n+32}` + `panelNumberStart: 33`) renomeava as uplinks para
    // QSFP28-65..68 e derrubava a correlação — guarda contra a regressão.
    const ordinals = asset.ports
      .map((port) => Number(/^QSFP28-(\d+)$/.exec(port.name)?.[1] ?? Number.NaN))
      .sort((a, b) => a - b);
    expect(ordinals).toEqual(Array.from({ length: 36 }, (_value, index) => index + 1));

    const report = await context.sync(asset.id);
    expect(report.created).toBe(0);
    expect(report.mapped).toBe(36);
    expect(report.skippedByPolicy).toBe(0);

    const mappedInterface = (portName: string) =>
      report.ports.find((port) => port.name === portName)?.mappedInterfaceId;
    expect(mappedInterface('QSFP28-1')).toBe('if-100GE1/0/1');
    expect(mappedInterface('QSFP28-36')).toBe('if-100GE1/0/36');

    // Interface lógica nunca vira porta física (nem ganha conector).
    expect(
      report.ports.some((port) => /vlanif|eth-?trunk|loopback/i.test(port.name)),
    ).toBe(false);
    expect(report.created).toBe(0);

    const again = await context.sync(asset.id);
    expect(again.created).toBe(0);
    expect(again.mapped).toBe(36);
    expect(again.skippedByPolicy).toBe(0);
    await context.app.close();
  });

  it('preserva o comportamento já existente do S6730', () => {
    const panel = [
      ...Array.from({ length: 48 }, (_value, index) => ({
        id: `port-10ge-${index + 1}`,
        name: `10GE-${index + 1}`,
        side: 'DEVICE' as const,
        mappedInterfaceId: null,
      })),
      ...Array.from({ length: 6 }, (_value, index) => ({
        id: `port-qsfp28-${index + 1}`,
        name: `QSFP28-${index + 1}`,
        side: 'DEVICE' as const,
        mappedInterfaceId: null,
      })),
    ];
    const names = [
      ...Array.from({ length: 48 }, (_value, index) => `XGigabitEthernet0/0/${index + 1}`),
      ...Array.from({ length: 6 }, (_value, index) => `100GE0/0/${index + 1}`),
    ];

    const correlation = correlateCatalogPanelAliases(panel, ifTargets(names), 'huawei-s6730-h48x6c');

    expect(correlation.size).toBe(54);
    expect(correlation.get('if-XGigabitEthernet0/0/1')).toBe('port-10ge-1');
    expect(correlation.get('if-100GE0/0/6')).toBe('port-qsfp28-6');
  });
});

/**
 * A identidade apresentada da porta é o **nome de interface do catálogo**
 * (`interfaceNamePattern`) e, quando existe, a interface real do Device. A
 * correlação usa essa declaração antes do nome persistido, sem nunca escolher
 * por posição quando há ambiguidade.
 */
describe('sincronização pelo nome de interface do catálogo', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  const CRS326 = 'mikrotik-crs326-24splus-2qplus-rm';

  it('mapeia pelo interfaceName declarado mesmo com a porta renomeada', async () => {
    const context = await harness([
      hostRecord('host-crs326', ['sfp-sfpplus1', 'sfp-sfpplus2', 'qsfpplus1']),
    ]);
    app = context.app;
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, {
      name: 'CRS326',
      catalogKey: CRS326,
      kind: 'NETWORK',
      deviceId: 'host-crs326',
    });
    const port = asset.ports.find((item) => item.name === 'sfp-sfpplus1')!;
    expect(port).toBeDefined();

    // O operador renomeia a porta física: a identidade persistida continua
    // estável e o catálogo segue sendo a fonte da correlação.
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/physical/ports/${port.id}`,
      payload: { name: 'UPLINK-FIBRA-01' },
    });
    expect(renamed.statusCode).toBe(200);

    const report = await context.sync(asset.id);
    const mapped = report.ports.find((item) => item.id === port.id)!;
    expect(mapped.mappedInterfaceId).toBe('if-sfp-sfpplus1');
    expect(mapped.name).toBe('UPLINK-FIBRA-01');
    expect(report.ports.find((item) => item.name === 'qsfpplus1')?.mappedInterfaceId).toBe(
      'if-qsfpplus1',
    );
  });

  it('aceita o nome normalizado (espaçamento/caixa) quando o exato não bate', async () => {
    const context = await harness([hostRecord('host-crs326-space', ['SFP-SFPP LUS1'])]);
    app = context.app;
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, {
      name: 'CRS326',
      catalogKey: CRS326,
      kind: 'NETWORK',
      deviceId: 'host-crs326-space',
    });
    const report = await context.sync(asset.id);
    const mapped = report.ports.find((item) => item.mappedInterfaceId);
    expect(mapped?.name).toBe('sfp-sfpplus1');
    expect(mapped?.mappedInterfaceId).toBe('if-SFP-SFPP LUS1');
  });

  it('catálogo ambíguo não é resolvido por posição (não mapeia)', () => {
    const plan = planInterfaceSync(
      [
        {
          id: 'port-1',
          name: 'PORTA-A',
          side: 'DEVICE',
          mappedInterfaceId: null,
          catalogInterfaceName: '100GE1/0/1',
        },
        {
          id: 'port-2',
          name: 'PORTA-B',
          side: 'DEVICE',
          mappedInterfaceId: null,
          catalogInterfaceName: '100GE1/0/1',
        },
      ],
      [{ id: 'if-1', name: '100GE1/0/1' }],
      { vendorTemplate: true, catalogKey: 'huawei-s6750-h36c' },
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]!.action).not.toBe('MAP');
    expect(plan[0]!.portId).toBeNull();
  });

  it('o nome do catálogo vence a identidade persistida quando as duas casam', () => {
    const plan = planInterfaceSync(
      [
        {
          id: 'port-1',
          name: 'sfp-sfpplus1',
          side: 'DEVICE',
          mappedInterfaceId: null,
          catalogInterfaceName: 'sfp-sfpplus1',
        },
      ],
      [{ id: 'if-1', name: 'sfp-sfpplus1' }],
      { vendorTemplate: true, catalogKey: CRS326 },
    );
    expect(plan[0]).toMatchObject({ action: 'MAP', portId: 'port-1' });
    expect(plan[0]!.reason).toContain('catálogo');
  });

  it('equipamento genérico passa a expor a interface real depois do sync', async () => {
    const context = await harness([hostRecord('host-generic-eth', ['ether1', 'ether2'])]);
    app = context.app;
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, {
      name: 'SW-GEN-01',
      kind: 'GENERIC',
      deviceId: 'host-generic-eth',
      genericPorts: { count: 2, prefix: 'port', side: 'DEVICE', type: 'RJ45' },
    });
    expect(asset.ports.map((item) => item.name)).toEqual(['port1', 'port2']);

    const report = await context.sync(asset.id);
    const created = report.ports.filter((item) => item.mappedInterfaceId);
    expect(created.map((item) => item.name).sort()).toEqual(['ether1', 'ether2']);
    // porta genérica sem interface continua existindo (nada é removido)
    expect(report.ports.some((item) => item.name === 'port1')).toBe(true);
  });
});

/**
 * Diagnóstico do sync: o operador precisa **ver os nomes reais** que o
 * equipamento respondeu e que não viraram conector (caso F1A-8H20Q em produção:
 * `100GE0/1/48`… com `100GE-48`… no painel). Nada é mapeado por posição para
 * "limpar" o aviso.
 */
describe('diagnóstico do sync de interfaces', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  it('lista os nomes físicos não reconhecidos com motivo (F1A-8H20Q)', async () => {
    const context = await harness([
      hostRecord('host-f1a-live', [
        // evidência de campo do BHE-VTA-F1A-BGP-01
        '100GE0/1/48',
        '100GE0/1/49',
        '100GE0/1/51',
        // famílias ainda sem captura confirmada
        '25GE0/1/28',
        '10GE0/1/0',
        // lógicas: continuam ignoradas, mas agora aparecem no diagnóstico
        'Vlanif100',
        'LoopBack0',
        'Eth-Trunk1',
      ]),
    ]);
    app = context.app;
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, {
      name: 'BHE-VTA-F1A-BGP-01',
      catalogKey: 'huawei-ne8000-f1a-8h20q',
      kind: 'NETWORK',
      deviceId: 'host-f1a-live',
    });

    const report = await context.sync(asset.id);
    const names = report.unrecognized.map((item) => item.interfaceName);
    expect(names).toEqual([
      '100GE0/1/48',
      '100GE0/1/49',
      '100GE0/1/51',
      '25GE0/1/28',
      '10GE0/1/0',
    ]);
    for (const item of report.unrecognized) {
      expect(item.classification).toBe('PHYSICAL');
      expect(item.reason).toContain('Template de fabricante');
    }
    // nunca mapeadas silenciosamente, nem quando a contagem não fecha
    expect(report.mapped).toBe(0);
    expect(
      report.ports.filter((port) => port.mappedInterfaceId !== null),
    ).toHaveLength(0);
    // as lógicas aparecem no diagnóstico, separadas
    expect(report.ignoredLogical.map((item) => item.interfaceName)).toEqual([
      'Vlanif100',
      'LoopBack0',
      'Eth-Trunk1',
    ]);
    expect(report.skippedLogical).toBe(3);
  });

  it('mantém a prioridade da interface já mapeada e não a reavalia', async () => {
    const context = await harness([hostRecord('host-keep', ['100GE0/1/48', 'Vlanif10'])]);
    app = context.app;
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, {
      name: 'F1A-KEEP',
      catalogKey: 'huawei-ne8000-f1a-8h20q',
      kind: 'NETWORK',
      deviceId: 'host-keep',
    });
    const port = asset.ports.find((item) => item.name === '100GE-48')!;
    // vínculo manual do operador: o sync não pode roubá-lo
    const linked = await app.inject({
      method: 'PATCH',
      url: `/api/physical/ports/${port.id}`,
      payload: { mappedInterfaceId: 'if-100GE0/1/48' },
    });
    expect(linked.statusCode).toBe(200);

    const report = await context.sync(asset.id);
    const mapped = report.ports.find((item) => item.id === port.id)!;
    expect(mapped.mappedInterfaceId).toBe('if-100GE0/1/48');
    // a interface já mapeada não entra no diagnóstico de desconhecidas
    expect(report.unrecognized.map((item) => item.interfaceName)).not.toContain('100GE0/1/48');
    expect(report.ignoredLogical.map((item) => item.interfaceName)).toContain('Vlanif10');
  });

  it('nomes desconhecidos não criam conector nem em template de fabricante', async () => {
    const context = await harness([hostRecord('host-unknown', ['FE0/0/1', 'XYZ-9'])]);
    app = context.app;
    const rack = await context.createRack();
    const asset = await context.createAsset(rack.id, {
      name: 'SW-UNKNOWN',
      catalogKey: 'huawei-s6730-h48x6c',
      kind: 'NETWORK',
      deviceId: 'host-unknown',
    });

    const before = asset.ports.length;
    const report = await context.sync(asset.id);
    expect(report.created).toBe(0);
    expect(report.ports).toHaveLength(before);
    expect(report.unrecognized.map((item) => item.interfaceName)).toEqual(['FE0/0/1', 'XYZ-9']);
    for (const item of report.unrecognized) {
      expect(item.classification).toBe('UNKNOWN');
      expect(item.reason).toContain('não reconhecido');
    }
  });
});

