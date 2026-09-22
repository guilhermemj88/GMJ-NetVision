import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { LldpAdjacencyProposal, LldpTopologyPreview } from '@gmj/shared';
import { classifyPhysicalInterface } from '@gmj/shared';
import { registerPhysicalRoutes } from './physical-routes';
import { DemoPhysicalRepository } from './infrastructure/physical/demo-physical-repository';
import { PHYSICAL_CATALOG } from './infrastructure/physical/physical-catalog';
import { PhysicalService } from './infrastructure/physical/physical-service';
import { PhysicalInventoryError } from './infrastructure/physical/physical-repository';
import { loadPhysicalCatalog } from './infrastructure/physical/physical-catalog-yaml';
import { DemoHostRepositoryAdapter } from './infrastructure/persistence/demo-host-repository-adapter';
import { DemoMapRepository } from './infrastructure/persistence/demo-map-repository';

/**
 * DCIM catalog (real YAML), modules, Device/Interface integration and the LLDP
 * reuse. The YAML is the source of truth: expectations are derived from it
 * instead of hard-coded fallback values.
 */

const hosts = new DemoHostRepositoryAdapter(new DemoMapRepository());
const catalog = loadPhysicalCatalog(PHYSICAL_CATALOG);

const MIKROTIK_KEY = 'mikrotik-crs328-24p-4splus-rm';
const MIKROTIK_PORTS = 28;
const JUNIPER_KEY = 'juniper-mx80';
const JUNIPER_MODULE = 'juniper-mic-3d-20ge-sfp';
const HUAWEI_KEY = 'huawei-s6750-h48x8c';
const UNVERIFIED_WITHOUT_STRUCTURE = 'huawei-s6720-family';
const MODULAR_OLT = 'vsol-v5600x7';
const FRACTIONAL_HEIGHT = 'juniper-mx104';

async function buildDcimApp() {
  const app = Fastify();
  const repository = new DemoPhysicalRepository(hosts);
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
  return { app, service };
}

function adjacency(
  localPortName: string,
  remotePortName: string,
  partial: Partial<LldpAdjacencyProposal> = {},
): LldpAdjacencyProposal {
  return {
    id: partial.id ?? `adj-${localPortName}`,
    sourceHostId: partial.sourceHostId ?? 'host-a',
    sourceHostname: 'SW-A',
    sourcePort: localPortName,
    sourceIfIndex: null,
    sourceInterfaceId: partial.sourceInterfaceId ?? null,
    sourceSpeedBps: null,
    targetHostId: partial.targetHostId ?? 'host-b',
    targetHostname: partial.targetHostname ?? 'SW-B',
    targetManagementAddress: null,
    targetChassisId: null,
    targetPort: remotePortName,
    targetPortDescription: null,
    targetInterfaceId: partial.targetInterfaceId ?? null,
    targetSpeedBps: null,
    confidence: partial.confidence ?? 'CONFIRMED',
    signals: [],
    reasons: [],
    duplicate: false,
    existingLinkId: null,
    source: 'LLDP_SNMP',
  };
}

function preview(adjacencies: LldpAdjacencyProposal[]): LldpTopologyPreview {
  return {
    id: 'preview-1',
    mapId: 'map-1',
    createdAt: '2026-09-21T12:00:00.000Z',
    stats: {
      hostsQueried: 2,
      hostsFailed: 0,
      adjacencies: adjacencies.length,
      confirmed: adjacencies.filter((item) => item.confidence === 'CONFIRMED').length,
      probable: 0,
      ambiguous: adjacencies.filter((item) => item.confidence === 'AMBIGUOUS').length,
      unknownNeighbor: 0,
    },
    adjacencies,
    warnings: [],
  };
}

describe('physical DCIM catalog, modules and LLDP (catálogo YAML real)', () => {
  let app: FastifyInstance;
  let service: PhysicalService;

  beforeEach(async () => {
    ({ app, service } = await buildDcimApp());
  });

  afterEach(async () => {
    await app.close();
  });

  async function createRack(name = 'Rack 01', units = 42) {
    const site = await app.inject({
      method: 'POST',
      url: '/api/physical/sites',
      payload: { name: 'POP Centro', code: 'CTO' },
    });
    const rack = await app.inject({
      method: 'POST',
      url: `/api/physical/sites/${site.json().id}/racks`,
      payload: { name, units },
    });
    return rack.json() as { id: string };
  }

  async function bootstrap() {
    const response = await app.inject({ method: 'POST', url: '/api/physical/catalog/bootstrap' });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      created: number;
      updated: number;
      total: number;
      source: string;
      path: string | null;
      warnings: string[];
      unsupportedFields: string[];
      counts: { templates: number; moduleTemplates: number; vendorVerified: number };
    };
  }

  describe('catálogo versionado', () => {
    it('serve o catálogo do YAML (source=yaml) com identidade para toda entrada', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/physical/catalog' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.source).toBe('yaml');
      expect(body.path).toMatch(/physical-catalog-v1\.yaml$/);
      expect(body.total).toBe(catalog.counts.templates);
      expect(body.counts.templates).toBe(catalog.counts.templates);
      expect(body.counts.moduleTemplates).toBe(catalog.counts.moduleTemplates);
      expect(body.unsupportedFields).toEqual([]);
      const keys = new Set(body.entries.map((entry: { catalogKey: string }) => entry.catalogKey));
      expect(keys.size).toBe(body.entries.length);
      expect(keys.has(MIKROTIK_KEY)).toBe(true);
    });

    it('não inventa estrutura para modelos não verificados', () => {
      for (const entry of catalog.entries) {
        expect(entry.heightU).toBeGreaterThanOrEqual(1);
        if (!entry.structureConfirmed) {
          expect(entry.ports).toHaveLength(0);
          expect(entry.slots).toHaveLength(0);
        }
        // estrutura declarada nunca é vazia quando marcada como confirmada por conteúdo
        if (entry.ports.length) expect(entry.portSummary).toBeTruthy();
      }
      // um modelo de fabricante verificado traz a estrutura declarada no YAML
      const huawei = catalog.entries.find((entry) => entry.catalogKey === HUAWEI_KEY)!;
      expect(huawei.vendorVerified).toBe(true);
      expect(huawei.structureConfirmed).toBe(true);
      expect(huawei.ports.length).toBeGreaterThan(0);
      expect(huawei.referenceUrl).toMatch(/^https?:\/\//);
    });

    it('faz bootstrap idempotente dos templates SYSTEM', async () => {
      const first = await bootstrap();
      expect(first.source).toBe('yaml');
      expect(first.created).toBe(catalog.counts.templates);
      const second = await bootstrap();
      expect(second.created).toBe(0);
      expect(second.total).toBe(catalog.counts.templates);
      const inventory = await app.inject({ method: 'GET', url: '/api/physical' });
      const templates = inventory.json().templates as Array<{ catalogKey: string | null }>;
      expect(templates).toHaveLength(catalog.counts.templates);
      expect(new Set(templates.map((template) => template.catalogKey)).size).toBe(
        catalog.counts.templates,
      );
    });

    it('preserva templates CUSTOM em novas sincronizações', async () => {
      await bootstrap();
      const custom = await app.inject({
        method: 'POST',
        url: '/api/physical/templates',
        payload: { name: 'DIO do POP', kind: 'DIO', heightU: 2 },
      });
      expect(custom.statusCode).toBe(201);
      await bootstrap();
      const inventory = await app.inject({ method: 'GET', url: '/api/physical' });
      const templates = inventory.json().templates as Array<{ id: string; origin: string }>;
      expect(templates.filter((template) => template.origin === 'CUSTOM')).toHaveLength(1);
      expect(templates.some((template) => template.id === custom.json().id)).toBe(true);
    });
  });

  describe('equipamento a partir do template', () => {
    it('materializa as portas declaradas no YAML', async () => {
      await bootstrap();
      const rack = await createRack();
      const response = await app.inject({
        method: 'POST',
        url: `/api/physical/racks/${rack.id}/assets`,
        payload: { name: 'CRS328-01', catalogKey: MIKROTIK_KEY, startU: 1, heightU: 1 },
      });
      expect(response.statusCode).toBe(201);
      const asset = response.json();
      expect(asset.template).toMatchObject({ catalogKey: MIKROTIK_KEY, structureConfirmed: true });
      expect(asset.ports).toHaveLength(MIKROTIK_PORTS);
      expect(asset.ports.every((port: { role: string }) => port.role === 'TEMPLATE')).toBe(true);
      expect(asset.ports.map((port: { name: string }) => port.name)).toContain('sfp-sfpplus4');
      expect(asset.ports[0]).toMatchObject({ name: 'ether1', type: 'RJ45' });
    });

    it('usa a altura do template como fonte de verdade (inclusive fracionária)', async () => {
      await bootstrap();
      const rack = await createRack();
      const response = await app.inject({
        method: 'POST',
        url: `/api/physical/racks/${rack.id}/assets`,
        payload: { name: 'MX104', catalogKey: FRACTIONAL_HEIGHT, startU: 1, heightU: 2 },
      });
      expect(response.statusCode).toBe(201);
      // MX104 declares 3.5U in the YAML: occupies 4U, catalog keeps the exact value
      expect(response.json().heightU).toBe(4);
      expect(catalog.entries.find((entry) => entry.catalogKey === FRACTIONAL_HEIGHT)?.heightUExact).toBe(
        3.5,
      );
    });

    it('aceita a altura real de um modelo sem estrutura confirmada', async () => {
      await bootstrap();
      const rack = await createRack();
      const response = await app.inject({
        method: 'POST',
        url: `/api/physical/racks/${rack.id}/assets`,
        payload: {
          name: 'S6720',
          catalogKey: UNVERIFIED_WITHOUT_STRUCTURE,
          startU: 1,
          heightU: 10,
        },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ heightU: 10 });
      expect(response.json().template).toMatchObject({ structureConfirmed: false });
      expect(response.json().ports).toHaveLength(0);
    });

    it('cria slots vazios do chassi modular sem inventar placas', async () => {
      await bootstrap();
      const rack = await createRack();
      const response = await app.inject({
        method: 'POST',
        url: `/api/physical/racks/${rack.id}/assets`,
        payload: { name: 'V5600X7', catalogKey: MODULAR_OLT, startU: 1, heightU: 1 },
      });
      expect(response.statusCode).toBe(201);
      const asset = response.json();
      expect(asset.slots).toHaveLength(7);
      expect(asset.slots.every((slot: { module: unknown }) => slot.module === null)).toBe(true);
      expect(asset.modules).toHaveLength(0);
      expect(asset.ports).toHaveLength(0);
    });

    it('continua suportando equipamento puramente genérico', async () => {
      await bootstrap();
      const rack = await createRack();
      const response = await app.inject({
        method: 'POST',
        url: `/api/physical/racks/${rack.id}/assets`,
        payload: {
          name: 'Genérico livre',
          kind: 'GENERIC',
          startU: 3,
          heightU: 2,
          genericPorts: { count: 4, prefix: 'LAN', type: 'RJ45' },
        },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().ports).toHaveLength(4);
      expect(response.json().template).toBeNull();
    });

    it('recusa um catalogKey inexistente', async () => {
      await bootstrap();
      const rack = await createRack();
      const response = await app.inject({
        method: 'POST',
        url: `/api/physical/racks/${rack.id}/assets`,
        payload: { name: 'Fantasma', catalogKey: 'nao-existe-no-catalogo', startU: 1, heightU: 1 },
      });
      expect(response.statusCode).toBe(404);
    });

    it('não permite que dois equipamentos usem o mesmo Device', async () => {
      await bootstrap();
      const rack = await createRack();
      const host = (await hosts.listHosts()).find((candidate) => candidate.interfaces.length > 0)!;
      const first = await app.inject({
        method: 'POST',
        url: `/api/physical/racks/${rack.id}/assets`,
        payload: { name: 'SW-01', kind: 'NETWORK', startU: 1, heightU: 1, deviceId: host.id },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: 'POST',
        url: `/api/physical/racks/${rack.id}/assets`,
        payload: { name: 'SW-02', kind: 'NETWORK', startU: 3, heightU: 1, deviceId: host.id },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().message).toContain('já está vinculado ao equipamento físico SW-01');

      // trocar o Device de um equipamento existente para um já ocupado também é recusado
      const other = await app.inject({
        method: 'POST',
        url: `/api/physical/racks/${rack.id}/assets`,
        payload: { name: 'SW-03', kind: 'NETWORK', startU: 5, heightU: 1 },
      });
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/physical/assets/${other.json().id}`,
        payload: { deviceId: host.id },
      });
      expect(patch.statusCode).toBe(409);
    });
  });

  describe('ciclo de vida de placas', () => {
    interface ModularAsset {
      id: string;
      slots: Array<{ id: string; index: number; module: unknown }>;
      template: {
        slots: Array<{ id: string; index: number; moduleKeys: string[] }>;
        modules: Array<{ id: string; catalogKey: string | null; name: string; model: string }>;
      };
    }

    async function modularAsset(withDevice = true): Promise<ModularAsset> {
      await bootstrap();
      const rack = await createRack();
      const host = (await hosts.listHosts()).find((candidate) => candidate.interfaces.length > 0)!;
      const response = await app.inject({
        method: 'POST',
        url: `/api/physical/racks/${rack.id}/assets`,
        payload: {
          name: 'MX80',
          catalogKey: JUNIPER_KEY,
          startU: 1,
          heightU: 2,
          ...(withDevice ? { deviceId: host.id } : {}),
        },
      });
      expect(response.statusCode).toBe(201);
      return response.json() as ModularAsset;
    }

    function boardOf(asset: ModularAsset, key = JUNIPER_MODULE) {
      return asset.template.modules.find((module) => module.catalogKey === key)!;
    }

    it('instala a placa declarada pelo slot, com as portas dela', async () => {
      const asset = await modularAsset();
      const board = boardOf(asset);
      expect(asset.template.slots[0]!.moduleKeys).toContain(JUNIPER_MODULE);
      const response = await app.inject({
        method: 'POST',
        url: `/api/physical/assets/${asset.id}/modules`,
        payload: { slotId: asset.slots[0]!.id, moduleTemplateId: board.id, name: board.name },
      });
      expect(response.statusCode).toBe(201);
      const module = response.json();
      expect(module.ports).toHaveLength(20);
      expect(
        module.ports.every(
          (port: { role: string; moduleId: string }) =>
            port.role === 'TEMPLATE' && port.moduleId === module.id,
        ),
      ).toBe(true);
      const inventory = await app.inject({ method: 'GET', url: '/api/physical' });
      expect(inventory.json().sites[0].racks[0].assets[0].slots[0].module.id).toBe(module.id);
    });

    it('recusa uma placa que o slot não aceita', async () => {
      const asset = await modularAsset();
      const foreign = await app.inject({
        method: 'POST',
        url: '/api/physical/templates',
        payload: {
          name: 'Placa de outro fabricante',
          kind: 'OLT',
          ports: [{ name: 'PON1', order: 1, type: 'SFP' }],
        },
      });
      expect(foreign.statusCode).toBe(201);
      const response = await app.inject({
        method: 'POST',
        url: `/api/physical/assets/${asset.id}/modules`,
        payload: {
          slotId: asset.slots[0]!.id,
          moduleTemplateId: foreign.json().id,
          name: 'Placa de outro fabricante',
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().message).toContain('não aceita o módulo');
    });

    it('aceita placa informada manualmente quando não há template', async () => {
      const asset = await modularAsset();
      const response = await app.inject({
        method: 'POST',
        url: `/api/physical/assets/${asset.id}/modules`,
        payload: { slotId: asset.slots[0]!.id, name: 'Placa informada manualmente' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ name: 'Placa informada manualmente', ports: [] });
    });

    it('recusa uma segunda placa no mesmo slot', async () => {
      const asset = await modularAsset();
      const board = boardOf(asset);
      const payload = { slotId: asset.slots[0]!.id, moduleTemplateId: board.id, name: board.name };
      expect(
        (await app.inject({ method: 'POST', url: `/api/physical/assets/${asset.id}/modules`, payload }))
          .statusCode,
      ).toBe(201);
      const again = await app.inject({
        method: 'POST',
        url: `/api/physical/assets/${asset.id}/modules`,
        payload,
      });
      expect(again.statusCode).toBe(409);
      expect(again.json().message).toContain('já possui um módulo');
    });

    it('só mapeia Interface quando o equipamento tem Device', async () => {
      const asset = await modularAsset(false);
      const board = boardOf(asset);
      const created = await app.inject({
        method: 'POST',
        url: `/api/physical/assets/${asset.id}/modules`,
        payload: { slotId: asset.slots[0]!.id, moduleTemplateId: board.id, name: board.name },
      });
      const module = created.json() as { ports: Array<{ id: string }> };
      const host = (await hosts.listHosts()).find((candidate) => candidate.interfaces.length > 0)!;
      const mapped = await app.inject({
        method: 'PATCH',
        url: `/api/physical/ports/${module.ports[0]!.id}`,
        payload: { mappedInterfaceId: host.interfaces[0]!.id },
      });
      expect(mapped.statusCode).toBe(404);
      const notes = await app.inject({
        method: 'PATCH',
        url: `/api/physical/ports/${module.ports[0]!.id}`,
        payload: { notes: 'placa sem device vinculado' },
      });
      expect(notes.statusCode).toBe(200);
      expect(notes.json()).toMatchObject({ notes: 'placa sem device vinculado' });
    });

    it('remove a placa apenas quando não há cabo nem vínculo com Interface', async () => {
      const asset = await modularAsset();
      const board = boardOf(asset);
      const created = await app.inject({
        method: 'POST',
        url: `/api/physical/assets/${asset.id}/modules`,
        payload: { slotId: asset.slots[0]!.id, moduleTemplateId: board.id, name: board.name },
      });
      const module = created.json() as { id: string; ports: Array<{ id: string }> };
      const host = (await hosts.listHosts()).find((candidate) => candidate.interfaces.length > 0)!;

      const mapped = await app.inject({
        method: 'PATCH',
        url: `/api/physical/ports/${module.ports[0]!.id}`,
        payload: { mappedInterfaceId: host.interfaces[0]!.id },
      });
      expect(mapped.statusCode).toBe(200);
      const refused = await app.inject({
        method: 'DELETE',
        url: `/api/physical/modules/${module.id}`,
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().message).toContain('Desconecte os cabos');

      const cleared = await app.inject({
        method: 'PATCH',
        url: `/api/physical/ports/${module.ports[0]!.id}`,
        payload: { mappedInterfaceId: null },
      });
      expect(cleared.statusCode).toBe(200);
      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/physical/modules/${module.id}`,
      });
      expect(removed.statusCode).toBe(204);
      const inventory = await app.inject({ method: 'GET', url: '/api/physical' });
      const stored = inventory.json().sites[0].racks[0].assets[0];
      expect(stored.modules).toHaveLength(0);
      expect(stored.slots[0].module).toBeNull();
    });
  });

  describe('integração com Device/Interface em equipamento sem template', () => {
    it('cria apenas conectores físicos e preserva portas manuais', async () => {
      await bootstrap();
      const host = (await hosts.listHosts()).find((candidate) => candidate.interfaces.length > 0)!;
      const rack = await createRack();
      const created = await app.inject({
        method: 'POST',
        url: `/api/physical/racks/${rack.id}/assets`,
        payload: { name: 'SW-SYNC', kind: 'NETWORK', startU: 1, heightU: 1, deviceId: host.id },
      });
      expect(created.statusCode).toBe(201);
      const assetId = created.json().id as string;
      await app.inject({
        method: 'POST',
        url: `/api/physical/assets/${assetId}/ports`,
        payload: { name: 'CONSOLE', order: 99, type: 'OTHER' },
      });

      const sync = await app.inject({
        method: 'POST',
        url: `/api/physical/assets/${assetId}/sync-interfaces`,
      });
      expect(sync.statusCode).toBe(200);
      const report = sync.json();
      const physical = host.interfaces.filter(
        (item) => classifyPhysicalInterface(item.name).classification === 'PHYSICAL',
      );
      expect(report.created + report.mapped).toBe(physical.length);
      expect(report.ports.filter((port: { role: string }) => port.role === 'MANUAL')).toHaveLength(1);
      expect(
        report.ports.every(
          (port: { name: string }) =>
            classifyPhysicalInterface(port.name).classification !== 'LOGICAL',
        ),
      ).toBe(true);

      const again = await app.inject({
        method: 'POST',
        url: `/api/physical/assets/${assetId}/sync-interfaces`,
      });
      expect(again.json().created).toBe(0);
      expect(again.json().ports).toHaveLength(report.ports.length);
    });
  });

  describe('reuso do LLDP', () => {
    async function twoSidedSetup() {
      await bootstrap();
      const rack = await createRack();
      const hostA = (await hosts.listHosts()).find((candidate) => candidate.interfaces.length > 0)!;
      const hostB = (await hosts.listHosts()).find(
        (candidate) => candidate.interfaces.length > 0 && candidate.id !== hostA.id,
      )!;
      const create = async (name: string, hostId: string, startU: number) => {
        const response = await app.inject({
          method: 'POST',
          url: `/api/physical/racks/${rack.id}/assets`,
          payload: { name, kind: 'NETWORK', startU, heightU: 1, deviceId: hostId },
        });
        expect(response.statusCode).toBe(201);
        await app.inject({
          method: 'POST',
          url: `/api/physical/assets/${response.json().id}/sync-interfaces`,
        });
        return response.json() as { id: string };
      };
      const assetA = await create('SW-A', hostA.id, 1);
      const assetB = await create('SW-B', hostB.id, 3);
      return { hostA, hostB, assetA, assetB };
    }

    it('transforma uma adjacência de dois lados em sugestão READY sem criar cabo', async () => {
      const { hostA, hostB } = await twoSidedSetup();
      const recorded = await service.recordLldpPreview(
        preview([
          adjacency(hostA.interfaces[0]!.name, hostB.interfaces[1]!.name, {
            sourceHostId: hostA.id,
            sourceInterfaceId: hostA.interfaces[0]!.id,
            targetHostId: hostB.id,
            targetInterfaceId: hostB.interfaces[1]!.id,
            targetHostname: hostB.hostname,
          }),
        ]),
      );
      expect(recorded).toBe(1);
      const list = await app.inject({ method: 'GET', url: '/api/physical/lldp' });
      const suggestion = list.json().suggestions[0];
      expect(suggestion.state).toBe('READY');
      expect(suggestion.local.portName).toBe(hostA.interfaces[0]!.name);
      expect(suggestion.remote.portName).toBe(hostB.interfaces[1]!.name);

      const before = await app.inject({ method: 'GET', url: '/api/physical' });
      expect(before.json().connections).toHaveLength(0);
      expect(before.json().lldpObservedAt).toBe('2026-09-21T12:00:00.000Z');

      const confirm = await app.inject({
        method: 'POST',
        url: `/api/physical/lldp/${suggestion.adjacencyId}/confirm`,
        payload: { medium: 'FIBER' },
      });
      expect(confirm.statusCode).toBe(201);
      const after = await app.inject({ method: 'GET', url: '/api/physical' });
      expect(after.json().connections).toHaveLength(1);
      const ports = after
        .json()
        .sites[0].racks[0].assets.flatMap((asset: { ports: Array<{ state: string }> }) => asset.ports);
      expect(ports.filter((port: { state: string }) => port.state === 'CONNECTED')).toHaveLength(2);
      const twice = await app.inject({
        method: 'POST',
        url: `/api/physical/lldp/${suggestion.adjacencyId}/confirm`,
      });
      expect(twice.statusCode).toBe(409);
    });

    it('mostra sugestão PARTIAL e recusa confirmar', async () => {
      const { hostA } = await twoSidedSetup();
      await service.recordLldpPreview(
        preview([
          adjacency(hostA.interfaces[0]!.name, 'GE99', {
            sourceHostId: hostA.id,
            sourceInterfaceId: hostA.interfaces[0]!.id,
            targetHostId: null,
            targetInterfaceId: null,
            targetHostname: 'DESCONHECIDO',
          }),
        ]),
      );
      const list = await app.inject({ method: 'GET', url: '/api/physical/lldp' });
      const suggestion = list.json().suggestions[0];
      expect(suggestion).toMatchObject({ state: 'PARTIAL', remote: null });
      const confirm = await app.inject({
        method: 'POST',
        url: `/api/physical/lldp/${suggestion.adjacencyId}/confirm`,
      });
      expect(confirm.statusCode).toBe(409);
    });

    it('nunca confirma adjacência ambígua', async () => {
      const { hostA, hostB } = await twoSidedSetup();
      await service.recordLldpPreview(
        preview([
          adjacency(hostA.interfaces[0]!.name, hostB.interfaces[0]!.name, {
            sourceHostId: hostA.id,
            sourceInterfaceId: hostA.interfaces[0]!.id,
            targetHostId: hostB.id,
            targetInterfaceId: hostB.interfaces[0]!.id,
            confidence: 'AMBIGUOUS',
          }),
        ]),
      );
      const list = await app.inject({ method: 'GET', url: '/api/physical/lldp' });
      const suggestion = list.json().suggestions[0];
      expect(suggestion.state).toBe('UNRESOLVED');
      const confirm = await app.inject({
        method: 'POST',
        url: `/api/physical/lldp/${suggestion.adjacencyId}/confirm`,
      });
      expect(confirm.statusCode).toBe(409);
      const inventory = await app.inject({ method: 'GET', url: '/api/physical' });
      expect(inventory.json().connections).toHaveLength(0);
    });

    it('mantém a confirmação automática de LLDP desligada', async () => {
      expect(service.isAutoConfirmEnabled()).toBe(false);
      const { hostA, hostB } = await twoSidedSetup();
      await service.recordLldpPreview(
        preview([
          adjacency(hostA.interfaces[0]!.name, hostB.interfaces[0]!.name, {
            sourceHostId: hostA.id,
            sourceInterfaceId: hostA.interfaces[0]!.id,
            targetHostId: hostB.id,
            targetInterfaceId: hostB.interfaces[0]!.id,
          }),
        ]),
      );
      const list = await app.inject({ method: 'GET', url: '/api/physical/lldp' });
      const suggestion = list.json().suggestions[0];
      await expect(
        service.confirmLldpSuggestion(suggestion.adjacencyId, { origin: 'AUTO' }),
      ).rejects.toThrow(/Auto-confirmação LLDP/);
      const inventory = await app.inject({ method: 'GET', url: '/api/physical' });
      expect(inventory.json().connections).toHaveLength(0);
    });

    it('não registra nada quando o preview não tem adjacência', async () => {
      const recorded = await service.recordLldpPreview(preview([]));
      expect(recorded).toBe(0);
      const inventory = await app.inject({ method: 'GET', url: '/api/physical' });
      expect(inventory.json().lldpSuggestions).toEqual([]);
      expect(inventory.json().lldpObservedAt).toBeNull();
    });
  });
});
