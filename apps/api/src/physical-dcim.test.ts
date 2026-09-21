import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { LldpAdjacencyProposal, LldpTopologyPreview } from '@gmj/shared';
import { registerPhysicalRoutes } from './physical-routes';
import { DemoPhysicalRepository } from './infrastructure/physical/demo-physical-repository';
import { PHYSICAL_CATALOG } from './infrastructure/physical/physical-catalog';
import { PhysicalService } from './infrastructure/physical/physical-service';
import { PhysicalInventoryError } from './infrastructure/physical/physical-repository';
import { DemoHostRepositoryAdapter } from './infrastructure/persistence/demo-host-repository-adapter';
import { DemoMapRepository } from './infrastructure/persistence/demo-map-repository';

/**
 * DCIM evolution tests: predefined catalog, modular equipment, Device/Interface
 * integration and the LLDP reuse. Nothing here may auto-create a cable.
 */

const hosts = new DemoHostRepositoryAdapter(new DemoMapRepository());

async function buildDcimApp() {
  const app = Fastify();
  const repository = new DemoPhysicalRepository(hosts);
  // Same default as production wiring: LLDP auto-confirm stays disabled.
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

const SWITCH_KEY = 'mikrotik-crs328-24p-4s-plus-rm';
const SWITCH_PORTS = 28;

describe('physical DCIM catalog, modules and LLDP', () => {
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
    return response.json() as { created: number; updated: number; total: number };
  }

  describe('predefined catalog', () => {
    it('exposes the versioned catalog with identity for every entry', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/physical/catalog' });
      expect(response.statusCode).toBe(200);
      const entries = response.json().entries as Array<{ catalogKey: string; name: string }>;
      expect(entries.length).toBe(PHYSICAL_CATALOG.length);
      expect(new Set(entries.map((entry) => entry.catalogKey)).size).toBe(entries.length);
      for (const entry of entries) {
        expect(entry.name.trim().length).toBeGreaterThan(0);
      }
    });

    it('never claims a vendor structure that was not confirmed', () => {
      for (const entry of PHYSICAL_CATALOG) {
        if (entry.vendorVerified) {
          expect(entry.structureConfirmed).toBe(true);
          expect(entry.referenceUrl).toBeTruthy();
        }
        if (!entry.structureConfirmed) {
          // Nothing may be invented for a model with unconfirmed structure.
          expect(entry.ports).toHaveLength(0);
          expect(entry.slots).toHaveLength(0);
          expect(entry.vendorVerified).toBe(false);
        }
      }
    });

    it('keeps catalog port names and orders unique per template template port', () => {
      // The persisted template port is unique by (templateId, side, sortOrder),
      // so the catalog must not repeat an order within the same side.
      for (const entry of PHYSICAL_CATALOG) {
        const perSide = new Map<string, number[]>();
        for (const port of entry.ports) {
          const orders = perSide.get(port.side) ?? [];
          orders.push(port.order);
          perSide.set(port.side, orders);
        }
        for (const [side, orders] of perSide) {
          expect(new Set(orders).size, `${entry.catalogKey} ${side}`).toBe(orders.length);
        }
        for (const module of entry.modules) {
          const orders = module.ports.map((port) => port.order);
          expect(new Set(orders).size, `${entry.catalogKey}/${module.key}`).toBe(orders.length);
          const names = module.ports.map((port) => port.name);
          expect(new Set(names).size, `${entry.catalogKey}/${module.key}`).toBe(names.length);
        }
        const names = entry.ports.map((port) => `${port.side}:${port.name}`);
        expect(new Set(names).size, entry.catalogKey).toBe(names.length);
      }
    });

    it('bootstraps the SYSTEM templates idempotently and ignores duplicates', async () => {
      const first = await bootstrap();
      expect(first.created).toBe(PHYSICAL_CATALOG.length);
      const second = await bootstrap();
      expect(second.created).toBe(0);
      expect(second.total).toBe(PHYSICAL_CATALOG.length);
      const inventory = await app.inject({ method: 'GET', url: '/api/physical' });
      const templates = inventory.json().templates as Array<{ catalogKey: string | null }>;
      expect(templates).toHaveLength(PHYSICAL_CATALOG.length);
      expect(new Set(templates.map((template) => template.catalogKey)).size).toBe(
        PHYSICAL_CATALOG.length,
      );
    });

    it('preserves CUSTOM templates when the catalog is synchronized again', async () => {
      await bootstrap();
      const custom = await app.inject({
        method: 'POST',
        url: '/api/physical/templates',
        payload: { name: 'DIO do POP', kind: 'DIO', heightU: 2 },
      });
      expect(custom.statusCode).toBe(201);
      expect(custom.json()).toMatchObject({ origin: 'CUSTOM', vendorVerified: false });
      await bootstrap();
      const inventory = await app.inject({ method: 'GET', url: '/api/physical' });
      const templates = inventory.json().templates as Array<{ id: string; origin: string }>;
      expect(templates.filter((template) => template.origin === 'CUSTOM')).toHaveLength(1);
      expect(templates.some((template) => template.id === custom.json().id)).toBe(true);
    });
  });

  describe('equipment built from a template', () => {
    it('materializes the ports of a vendor verified template', async () => {
      await bootstrap();
      const rack = await createRack();
      const response = await app.inject({
        method: 'POST',
        url: `/api/physical/racks/${rack.id}/assets`,
        payload: { name: 'CRS328-01', catalogKey: SWITCH_KEY, startU: 1, heightU: 1 },
      });
      expect(response.statusCode).toBe(201);
      const asset = response.json();
      expect(asset.template).toMatchObject({
        catalogKey: SWITCH_KEY,
        vendorVerified: true,
        structureConfirmed: true,
      });
      expect(asset.ports).toHaveLength(SWITCH_PORTS);
      expect(asset.ports.every((port: { role: string }) => port.role === 'TEMPLATE')).toBe(true);
      expect(asset.ports.map((port: { name: string }) => port.name)).toContain('SFP+ 4');
      expect(asset.heightU).toBe(1);
    });

    it('keeps the template height as the source of truth for confirmed structures', async () => {
      await bootstrap();
      const rack = await createRack();
      const response = await app.inject({
        method: 'POST',
        url: `/api/physical/racks/${rack.id}/assets`,
        payload: { name: 'CRS328-02', catalogKey: SWITCH_KEY, startU: 1, heightU: 4 },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().heightU).toBe(1);
    });

    it('accepts the real height for a model whose structure was not confirmed', async () => {
      await bootstrap();
      const rack = await createRack();
      const response = await app.inject({
        method: 'POST',
        url: `/api/physical/racks/${rack.id}/assets`,
        payload: { name: 'C320-01', catalogKey: 'zte-c320', startU: 1, heightU: 10, kind: 'OLT' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ heightU: 10, kind: 'OLT' });
      expect(response.json().template).toMatchObject({ structureConfirmed: false });
      expect(response.json().ports).toHaveLength(0);
    });

    it('creates empty slots for a modular chassis without inventing boards', async () => {
      await bootstrap();
      const rack = await createRack();
      const response = await app.inject({
        method: 'POST',
        url: `/api/physical/racks/${rack.id}/assets`,
        payload: {
          name: 'OLT modular',
          catalogKey: 'generic-chassis-8-slot',
          startU: 1,
          heightU: 6,
          kind: 'OLT',
        },
      });
      expect(response.statusCode).toBe(201);
      const asset = response.json();
      expect(asset.slots).toHaveLength(8);
      expect(asset.slots.every((slot: { module: unknown }) => slot.module === null)).toBe(true);
      expect(asset.modules).toHaveLength(0);
    });

    it('still supports purely generic equipment', async () => {
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
  });

  describe('module lifecycle', () => {
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
          name: 'OLT-01',
          catalogKey: 'generic-chassis-8-slot',
          startU: 1,
          heightU: 6,
          kind: 'OLT',
          ...(withDevice ? { deviceId: host.id } : {}),
        },
      });
      expect(response.statusCode).toBe(201);
      return response.json() as ModularAsset;
    }

    it('installs the board template the slot declares, with its ports', async () => {
      const asset = await modularAsset();
      const board = asset.template.modules[0]!;
      expect(asset.template.slots[0]!.moduleKeys).toEqual([
        'generic-chassis-8-slot:generic-lpu-4x-sfp',
      ]);
      const response = await app.inject({
        method: 'POST',
        url: `/api/physical/assets/${asset.id}/modules`,
        payload: {
          slotId: asset.slots[0]!.id,
          moduleTemplateId: board.id,
          name: board.name,
          model: board.model,
        },
      });
      expect(response.statusCode).toBe(201);
      const module = response.json();
      expect(module).toMatchObject({ name: board.name, slotIndex: 1 });
      expect(module.ports.length).toBeGreaterThan(0);
      expect(
        module.ports.every(
          (port: { role: string; moduleId: string }) =>
            port.role === 'TEMPLATE' && port.moduleId === module.id,
        ),
      ).toBe(true);

      const inventory = await app.inject({ method: 'GET', url: '/api/physical' });
      const stored = inventory.json().sites[0].racks[0].assets[0];
      expect(stored.slots[0].module.id).toBe(module.id);
      expect(stored.modules).toHaveLength(1);
      expect(
        stored.ports.filter((port: { moduleId: string | null }) => port.moduleId === module.id),
      ).toHaveLength(module.ports.length);
    });

    it('rejects a board template that the slot does not accept', async () => {
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

    it('accepts an operator named board when the slot accepts any module', async () => {
      const asset = await modularAsset();
      const response = await app.inject({
        method: 'POST',
        url: `/api/physical/assets/${asset.id}/modules`,
        payload: { slotId: asset.slots[0]!.id, name: 'Placa informada manualmente' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ name: 'Placa informada manualmente', ports: [] });
    });

    it('refuses to install a second board in an occupied slot', async () => {
      const asset = await modularAsset();
      const board = asset.template.modules[0]!;
      const payload = {
        slotId: asset.slots[0]!.id,
        moduleTemplateId: board.id,
        name: board.name,
      };
      const created = await app.inject({
        method: 'POST',
        url: `/api/physical/assets/${asset.id}/modules`,
        payload,
      });
      expect(created.statusCode).toBe(201);
      const again = await app.inject({
        method: 'POST',
        url: `/api/physical/assets/${asset.id}/modules`,
        payload,
      });
      expect(again.statusCode).toBe(409);
      expect(again.json().message).toContain('já possui um módulo');
    });

    it('only maps an interface when the asset is linked to a real Device', async () => {
      const asset = await modularAsset(false);
      const board = asset.template.modules[0]!;
      const created = await app.inject({
        method: 'POST',
        url: `/api/physical/assets/${asset.id}/modules`,
        payload: {
          slotId: asset.slots[0]!.id,
          moduleTemplateId: board.id,
          name: board.name,
        },
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

    it('removes a board only when it breaks neither a cable nor an interface mapping', async () => {
      const asset = await modularAsset();
      const board = asset.template.modules[0]!;
      const created = await app.inject({
        method: 'POST',
        url: `/api/physical/assets/${asset.id}/modules`,
        payload: {
          slotId: asset.slots[0]!.id,
          moduleTemplateId: board.id,
          name: board.name,
        },
      });
      const module = created.json() as { id: string; ports: Array<{ id: string }> };

      const host = (await hosts.listHosts()).find((candidate) => candidate.interfaces.length > 0)!;
      const mapped = await app.inject({
        method: 'PATCH',
        url: `/api/physical/ports/${module.ports[0]!.id}`,
        payload: { mappedInterfaceId: host.interfaces[0]!.id },
      });
      expect(mapped.statusCode).toBe(200);
      expect(mapped.json()).toMatchObject({
        state: 'MAPPED',
        mappedInterfaceId: host.interfaces[0]!.id,
      });

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
      expect(cleared.json()).toMatchObject({ state: 'FREE' });

      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/physical/modules/${module.id}`,
      });
      expect(removed.statusCode).toBe(204);
      const inventory = await app.inject({ method: 'GET', url: '/api/physical' });
      const stored = inventory.json().sites[0].racks[0].assets[0];
      expect(stored.modules).toHaveLength(0);
      expect(stored.slots[0].module).toBeNull();
      expect(stored.ports).toHaveLength(0);
    });
  });

  describe('Device and Interface integration', () => {
    it('maps real interfaces over template placeholders and keeps manual ports', async () => {
      await bootstrap();
      const host = (await hosts.listHosts()).find((candidate) => candidate.interfaces.length > 0)!;
      const rack = await createRack();
      const created = await app.inject({
        method: 'POST',
        url: `/api/physical/racks/${rack.id}/assets`,
        payload: {
          name: 'CRS328-03',
          catalogKey: SWITCH_KEY,
          startU: 1,
          heightU: 1,
          deviceId: host.id,
        },
      });
      expect(created.statusCode).toBe(201);
      const assetId = created.json().id as string;
      const manual = await app.inject({
        method: 'POST',
        url: `/api/physical/assets/${assetId}/ports`,
        payload: { name: 'CONSOLE', order: 99, type: 'OTHER' },
      });
      expect(manual.statusCode).toBe(201);

      const sync = await app.inject({
        method: 'POST',
        url: `/api/physical/assets/${assetId}/sync-interfaces`,
      });
      expect(sync.statusCode).toBe(200);
      const ports = sync.json() as Array<{
        name: string;
        mappedInterfaceId: string | null;
        role: string;
      }>;
      expect(ports.filter((port) => port.mappedInterfaceId)).toHaveLength(host.interfaces.length);
      expect(ports.filter((port) => port.role === 'TEMPLATE')).toHaveLength(SWITCH_PORTS);
      const manualPort = ports.find((port) => port.name === 'CONSOLE')!;
      expect(manualPort).toMatchObject({ mappedInterfaceId: null, role: 'MANUAL' });

      const again = await app.inject({
        method: 'POST',
        url: `/api/physical/assets/${assetId}/sync-interfaces`,
      });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toHaveLength(ports.length);

      const inventory = await app.inject({ method: 'GET', url: '/api/physical' });
      const asset = inventory.json().sites[0].racks[0].assets[0];
      const mapped = asset.ports.find(
        (port: { mappedInterfaceId: string | null }) => port.mappedInterfaceId,
      );
      expect(mapped.state).toBe('MAPPED');
      expect(mapped.mappedInterface.id).toBe(mapped.mappedInterfaceId);
      expect(asset.device).toMatchObject({ id: host.id });
    });

    it('does not duplicate ports when the interfaces are synchronized twice', async () => {
      await bootstrap();
      const host = (await hosts.listHosts()).find((candidate) => candidate.interfaces.length > 0)!;
      const rack = await createRack();
      const created = await app.inject({
        method: 'POST',
        url: `/api/physical/racks/${rack.id}/assets`,
        payload: {
          name: 'SW-SYNC',
          catalogKey: SWITCH_KEY,
          startU: 1,
          heightU: 1,
          deviceId: host.id,
        },
      });
      const assetId = created.json().id as string;
      const first = (
        await app.inject({ method: 'POST', url: `/api/physical/assets/${assetId}/sync-interfaces` })
      ).json() as Array<{ id: string; mappedInterfaceId: string | null }>;
      const second = (
        await app.inject({ method: 'POST', url: `/api/physical/assets/${assetId}/sync-interfaces` })
      ).json() as Array<{ id: string }>;
      expect(second.map((port) => port.id).sort()).toEqual(first.map((port) => port.id).sort());
      expect(first.filter((port) => port.mappedInterfaceId)).toHaveLength(host.interfaces.length);
    });
  });

  describe('LLDP reuse', () => {
    async function twoSidedSetup() {
      await bootstrap();
      const rack = await createRack();
      const hostA = (await hosts.listHosts()).find((candidate) => candidate.interfaces.length > 0)!;
      const hostB = (await hosts.listHosts()).find(
        (candidate) => candidate.interfaces.length > 0 && candidate.id !== hostA.id,
      )!;
      const assetA = (
        await app.inject({
          method: 'POST',
          url: `/api/physical/racks/${rack.id}/assets`,
          payload: {
            name: 'SW-A',
            catalogKey: SWITCH_KEY,
            startU: 1,
            heightU: 1,
            deviceId: hostA.id,
          },
        })
      ).json();
      const assetB = (
        await app.inject({
          method: 'POST',
          url: `/api/physical/racks/${rack.id}/assets`,
          payload: {
            name: 'SW-B',
            catalogKey: SWITCH_KEY,
            startU: 3,
            heightU: 1,
            deviceId: hostB.id,
          },
        })
      ).json();
      await app.inject({ method: 'POST', url: `/api/physical/assets/${assetA.id}/sync-interfaces` });
      await app.inject({ method: 'POST', url: `/api/physical/assets/${assetB.id}/sync-interfaces` });
      return { hostA, hostB, assetA, assetB };
    }

    it('turns a two sided adjacency into a READY suggestion without creating the cable', async () => {
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
      const suggestions = list.json().suggestions as Array<{
        adjacencyId: string;
        state: string;
        local: { portName: string } | null;
        remote: { portName: string } | null;
      }>;
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]).toMatchObject({
        state: 'READY',
        local: { portName: hostA.interfaces[0]!.name },
        remote: { portName: hostB.interfaces[1]!.name },
      });

      const inventoryBefore = await app.inject({ method: 'GET', url: '/api/physical' });
      expect(inventoryBefore.json().connections).toHaveLength(0);
      expect(inventoryBefore.json().lldpObservedAt).toBe('2026-09-21T12:00:00.000Z');

      const confirm = await app.inject({
        method: 'POST',
        url: `/api/physical/lldp/${suggestions[0]!.adjacencyId}/confirm`,
        payload: { medium: 'FIBER' },
      });
      expect(confirm.statusCode).toBe(201);
      expect(confirm.json()).toMatchObject({ medium: 'FIBER' });

      const inventoryAfter = await app.inject({ method: 'GET', url: '/api/physical' });
      expect(inventoryAfter.json().connections).toHaveLength(1);
      const ports = inventoryAfter
        .json()
        .sites[0].racks[0].assets.flatMap(
          (asset: { ports: Array<{ id: string; state: string }> }) => asset.ports,
        );
      expect(ports.filter((port: { state: string }) => port.state === 'CONNECTED')).toHaveLength(2);
      expect(ports.filter((port: { state: string }) => port.state === 'LLDP_DETECTED')).toHaveLength(0);

      const twice = await app.inject({
        method: 'POST',
        url: `/api/physical/lldp/${suggestions[0]!.adjacencyId}/confirm`,
      });
      expect(twice.statusCode).toBe(409);
    });

    it('shows a PARTIAL suggestion for a single sided adjacency and refuses to confirm it', async () => {
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
      expect(suggestion.reason).toContain('Apenas um dos lados');
      const confirm = await app.inject({
        method: 'POST',
        url: `/api/physical/lldp/${suggestion.adjacencyId}/confirm`,
      });
      expect(confirm.statusCode).toBe(409);
      const inventory = await app.inject({ method: 'GET', url: '/api/physical' });
      expect(inventory.json().connections).toHaveLength(0);
    });

    it('never confirms an ambiguous adjacency', async () => {
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

    it('keeps the automatic LLDP confirmation disabled', async () => {
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

    it('records nothing when the preview has no adjacency', async () => {
      const recorded = await service.recordLldpPreview(preview([]));
      expect(recorded).toBe(0);
      const inventory = await app.inject({ method: 'GET', url: '/api/physical' });
      expect(inventory.json().lldpSuggestions).toEqual([]);
      expect(inventory.json().lldpObservedAt).toBeNull();
    });
  });
});
