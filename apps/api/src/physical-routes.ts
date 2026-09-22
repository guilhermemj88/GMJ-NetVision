import type { AuthUser } from '@gmj/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PhysicalService } from './infrastructure/physical/physical-service';
import type { PhysicalRepository } from './infrastructure/physical/physical-repository';

const idParams = z.object({ id: z.string().min(1) });
const assetKind = z.enum(['NETWORK', 'SERVER', 'OLT', 'DIO', 'PATCH_PANEL', 'POWER', 'GENERIC']);
const portSide = z.enum(['DEVICE', 'FRONT', 'REAR']);
const portType = z.enum(['RJ45', 'SFP', 'SFP_PLUS', 'QSFP', 'FIBER', 'POWER', 'OTHER']);
const medium = z.enum(['FIBER', 'COPPER', 'DAC', 'AOC', 'UNKNOWN']);

const siteCreate = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().max(40).optional(),
  description: z.string().trim().max(2000).optional(),
});
const siteUpdate = siteCreate.partial();
const rackCreate = z.object({
  name: z.string().trim().min(1).max(120),
  units: z.number().int().min(1).max(100).default(42),
  description: z.string().trim().max(2000).optional(),
});
const rackUpdate = rackCreate.partial();
const genericPorts = z.object({
  count: z.number().int().min(0).max(512),
  prefix: z.string().trim().max(40).optional(),
  side: portSide.optional(),
  type: portType.optional(),
});
const assetCreate = z.object({
  name: z.string().trim().min(1).max(160),
  kind: assetKind.optional(),
  startU: z.number().int().min(1),
  heightU: z.number().int().min(1).max(100),
  description: z.string().trim().max(2000).optional(),
  deviceId: z.string().min(1).nullable().optional(),
  templateId: z.string().min(1).nullable().optional(),
  catalogKey: z.string().min(1).max(120).nullable().optional(),
  applyTemplate: z.boolean().optional(),
  genericPorts: genericPorts.optional(),
});
const assetUpdate = assetCreate.omit({ genericPorts: true, catalogKey: true, applyTemplate: true }).partial();
const portCreate = z.object({
  name: z.string().trim().min(1).max(160),
  label: z.string().trim().max(240).optional(),
  order: z.number().int().min(0),
  side: portSide.optional(),
  type: portType.optional(),
  notes: z.string().trim().max(2000).optional(),
  mappedInterfaceId: z.string().min(1).nullable().optional(),
  pairedPortId: z.string().min(1).nullable().optional(),
});
const portUpdate = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    label: z.string().trim().max(240).optional(),
    type: portType.optional(),
    notes: z.string().trim().max(2000).optional(),
    mappedInterfaceId: z.string().min(1).nullable().optional(),
  })
  .strict();
const moduleInstall = z
  .object({
    slotId: z.string().min(1),
    moduleTemplateId: z.string().min(1).nullable().optional(),
    name: z.string().trim().min(1).max(160),
    model: z.string().trim().max(120).optional(),
    serial: z.string().trim().max(120).optional(),
  })
  .strict();
const templateCreate = z.object({
  name: z.string().trim().min(1).max(160),
  manufacturer: z.string().trim().max(120).optional(),
  model: z.string().trim().max(120).optional(),
  kind: assetKind.optional(),
  heightU: z.number().int().min(1).max(100).optional(),
  description: z.string().trim().max(2000).optional(),
  ports: z.array(portCreate.omit({ mappedInterfaceId: true, pairedPortId: true, notes: true })).max(512).optional(),
});
const connectionCreate = z.object({
  portAId: z.string().min(1),
  portBId: z.string().min(1),
  medium: medium.optional(),
  label: z.string().trim().max(240).optional(),
  notes: z.string().trim().max(2000).optional(),
  lengthMeters: z.number().min(0).max(1_000_000).nullable().optional(),
});

export interface PhysicalRouteOptions {
  repository: PhysicalRepository;
  /** Shared service instance so other routes can feed the LLDP snapshot. */
  service?: PhysicalService;
  enforcePermissions?: boolean;
  currentUser?: (request: FastifyRequest) => Promise<AuthUser | null>;
}

export function registerPhysicalRoutes(app: FastifyInstance, options: PhysicalRouteOptions): void {
  const service = options.service ?? new PhysicalService(options.repository);
  const requireEditor = async (request: FastifyRequest, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) => {
    if (!options.enforcePermissions) return true;
    const user = await options.currentUser?.(request);
    if (user?.role === 'ADMIN' || user?.role === 'OPERATOR') return true;
    reply.code(403).send({ message: 'A edição física exige perfil ADMIN ou OPERATOR' });
    return false;
  };

  app.get('/api/physical', async () => service.getInventory());

  app.get('/api/physical/catalog', async () => ({
    entries: service.getCatalog(),
    ...service.getCatalogSource(),
  }));

  /** Idempotent SYSTEM catalog bootstrap (safe to call repeatedly). */
  app.post('/api/physical/catalog/bootstrap', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    return service.bootstrapCatalog();
  });

  app.get('/api/physical/lldp', async () => ({
    suggestions: await service.listLldpSuggestions(),
  }));

  app.post('/api/physical/lldp/:id/confirm', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    const { id } = idParams.parse(request.params);
    const body = z
      .object({ medium: medium.optional() })
      .strict()
      .parse(request.body ?? {});
    const result = await service.confirmLldpSuggestion(id, {
      origin: 'MANUAL',
      ...(body.medium ? { medium: body.medium } : {}),
    });
    return reply.code(201).send(result.connection);
  });

  app.get('/api/physical/ports/:id/path', async (request) => {
    const { id } = idParams.parse(request.params);
    return service.trace(id);
  });

  app.post('/api/physical/sites', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    return reply.code(201).send(await service.createSite(siteCreate.parse(request.body)));
  });

  app.patch('/api/physical/sites/:id', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    const { id } = idParams.parse(request.params);
    return service.updateSite(id, siteUpdate.parse(request.body));
  });

  app.delete('/api/physical/sites/:id', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    const { id } = idParams.parse(request.params);
    await service.deleteSite(id);
    return reply.code(204).send();
  });

  app.post('/api/physical/sites/:id/racks', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    const { id } = idParams.parse(request.params);
    return reply.code(201).send(await service.createRack(id, rackCreate.parse(request.body)));
  });

  app.patch('/api/physical/racks/:id', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    const { id } = idParams.parse(request.params);
    return service.updateRack(id, rackUpdate.parse(request.body));
  });

  app.delete('/api/physical/racks/:id', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    const { id } = idParams.parse(request.params);
    await service.deleteRack(id);
    return reply.code(204).send();
  });

  app.post('/api/physical/templates', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    return reply.code(201).send(await service.createTemplate(templateCreate.parse(request.body)));
  });

  app.post('/api/physical/racks/:id/assets', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    const { id } = idParams.parse(request.params);
    return reply.code(201).send(await service.createAsset(id, assetCreate.parse(request.body)));
  });

  app.patch('/api/physical/assets/:id', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    const { id } = idParams.parse(request.params);
    return service.updateAsset(id, assetUpdate.parse(request.body));
  });

  app.delete('/api/physical/assets/:id', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    const { id } = idParams.parse(request.params);
    await service.deleteAsset(id);
    return reply.code(204).send();
  });

  app.post('/api/physical/assets/:id/ports', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    const { id } = idParams.parse(request.params);
    return reply.code(201).send(await service.createPort(id, portCreate.parse(request.body)));
  });

  app.post('/api/physical/assets/:id/sync-interfaces', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    const { id } = idParams.parse(request.params);
    return service.syncInterfacePorts(id);
  });

  /** Removes connectors the old sync created for logical interfaces. */
  app.post('/api/physical/assets/:id/reconcile-ports', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    const { id } = idParams.parse(request.params);
    return service.reconcilePorts(id);
  });

  app.post('/api/physical/ports/:id/pair', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    const { id } = idParams.parse(request.params);
    const { pairedPortId } = z.object({ pairedPortId: z.string().min(1) }).parse(request.body);
    return service.pairPorts(id, pairedPortId);
  });

  app.patch('/api/physical/ports/:id', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    const { id } = idParams.parse(request.params);
    return service.updatePort(id, portUpdate.parse(request.body));
  });

  app.post('/api/physical/assets/:id/modules', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    const { id } = idParams.parse(request.params);
    return reply.code(201).send(await service.installModule(id, moduleInstall.parse(request.body)));
  });

  app.delete('/api/physical/modules/:id', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    const { id } = idParams.parse(request.params);
    await service.removeModule(id);
    return reply.code(204).send();
  });

  app.post('/api/physical/connections', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    return reply.code(201).send(await service.createConnection(connectionCreate.parse(request.body)));
  });

  app.delete('/api/physical/connections/:id', async (request, reply) => {
    if (!(await requireEditor(request, reply))) return;
    const { id } = idParams.parse(request.params);
    await service.deleteConnection(id);
    return reply.code(204).send();
  });
}
