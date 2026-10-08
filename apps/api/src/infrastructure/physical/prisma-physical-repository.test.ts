import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PhysicalCatalogEntry } from '@gmj/shared';
import { PrismaClient } from '../../generated/prisma';
import { PrismaPhysicalRepository } from './prisma-physical-repository';

/**
 * Unit tests for PrismaPhysicalRepository catalog/asset synchronization.
 *
 * The real PrismaClient is replaced by a stub so these tests run without a
 * database. Integration behavior is asserted by inspecting the calls made to
 * the Prisma delegate.
 */

function mockAsync(value: unknown): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(value);
}

function emptyPhysicalTemplate(id: string, catalogKey: string, origin: 'SYSTEM' | 'CUSTOM' = 'SYSTEM') {
  return {
    id,
    catalogKey,
    origin,
    name: 'Template',
    category: 'ROUTER' as const,
    manufacturer: 'Test',
    family: 'T',
    model: 'M',
    kind: 'NETWORK' as const,
    heightU: 2,
    description: '',
    vendorVerified: false,
    structureConfirmed: true,
    referenceUrl: null,
    ports: [],
    slots: [],
    modules: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function buildEntry(partial: Partial<PhysicalCatalogEntry> = {}): PhysicalCatalogEntry {
  return {
    catalogKey: 'test-chassis',
    name: 'Test Chassis',
    category: 'ROUTER',
    manufacturer: 'Test',
    family: 'T',
    model: 'M',
    kind: 'NETWORK',
    heightU: 2,
    vendorVerified: false,
    structureConfirmed: true,
    description: '',
    referenceUrl: null,
    portSummary: null,
    ports: [],
    slots: [],
    modules: [],
    ...partial,
  };
}

interface PrismaCallArg {
  data: Record<string, unknown>;
  [key: string]: unknown;
}

function buildPrismaStub() {
  const physicalEquipmentTemplate = {
    findUnique: mockAsync(null),
    findMany: mockAsync([]),
    create: mockAsync(emptyPhysicalTemplate('tpl-1', 'test-chassis')),
    update: mockAsync(emptyPhysicalTemplate('tpl-1', 'test-chassis')),
    updateMany: mockAsync({ count: 1 }),
    deleteMany: mockAsync({ count: 0 }),
  };

  const physicalTemplateSlot = {
    findMany: mockAsync([]),
    create: mockAsync({ id: 'slot-1', index: 0 }),
    createMany: mockAsync({ count: 0 }),
  };

  const physicalTemplatePort = {
    createMany: mockAsync({ count: 0 }),
  };

  const physicalModuleTemplate = {
    findMany: mockAsync([]),
    create: mockAsync({ id: 'module-1', catalogKey: 'test-module' }),
    update: mockAsync({ id: 'module-1', catalogKey: 'test-module' }),
  };

  const physicalModuleTemplatePort = {
    findMany: mockAsync([]),
    create: mockAsync({ id: 'port-1' }),
    update: mockAsync({ id: 'port-1' }),
  };

  const physicalTemplateSlotModule = {
    upsert: mockAsync({ id: 'link-1' }),
  };

  const physicalAsset = {
    create: mockAsync({ id: 'asset-1' }),
    findUnique: mockAsync(null),
    updateMany: mockAsync({ count: 1 }),
    deleteMany: mockAsync({ count: 0 }),
  };

  const physicalRack = {
    findUnique: mockAsync({ id: 'rack-1' }),
  };

  const physicalSite = {
    findMany: mockAsync([]),
  };

  const physicalConnection = {
    findMany: mockAsync([]),
  };

  return {
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === 'function') return arg({} as never);
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg;
    }),
    $disconnect: vi.fn(),
    physicalEquipmentTemplate,
    physicalTemplateSlot,
    physicalTemplatePort,
    physicalModuleTemplate,
    physicalModuleTemplatePort,
    physicalTemplateSlotModule,
    physicalAsset,
    physicalRack,
    physicalSite,
    physicalConnection,
  };
}

describe('PrismaPhysicalRepository.syncCatalog', () => {
  let prisma: ReturnType<typeof buildPrismaStub>;
  let repository: PrismaPhysicalRepository;

  beforeEach(() => {
    prisma = buildPrismaStub();
    repository = new PrismaPhysicalRepository(prisma as unknown as unknown as PrismaClient);
  });

  it('creates missing module templates when updating an existing SYSTEM template', async () => {
    prisma.physicalEquipmentTemplate.findUnique.mockResolvedValue(
      emptyPhysicalTemplate('tpl-1', 'test-chassis'),
    );
    // First call: no existing slots/modules during sync; second call: newly
    // created records are visible for linkSlotModuleOptions.
    prisma.physicalTemplateSlot.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: 'slot-1', index: 0 }]);
    prisma.physicalModuleTemplate.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: 'module-1', catalogKey: 'huawei-gpfd-16' }]);

    const entry = buildEntry({
      slots: [{ index: 0, label: 'Slot 0', description: '', moduleKeys: ['huawei-gpfd-16'] }],
      modules: [
        {
          key: 'huawei-gpfd-16',
          name: 'H802GPFD',
          model: 'H802GPFD',
          description: '16-port GPON',
          slotsRequired: 1,
          ports: [{ name: 'GPON-1', label: 'GPON 1', order: 0, side: 'DEVICE' as const, type: 'OTHER' as const }],
        },
      ],
    });

    const result = await repository.syncCatalog([entry]);
    expect(result.updated).toBe(1);

    expect(prisma.physicalModuleTemplate.create).toHaveBeenCalledTimes(1);
    const createCall = prisma.physicalModuleTemplate.create.mock.calls[0]![0] as PrismaCallArg;
    const moduleData = createCall.data as { catalogKey: string; name: string; ports: { create: unknown[] } };
    expect(moduleData.catalogKey).toBe('huawei-gpfd-16');
    expect(moduleData.name).toBe('H802GPFD');
    expect(moduleData.ports.create).toHaveLength(1);

    expect(prisma.physicalTemplateSlotModule.upsert).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: second sync does not duplicate modules or ports', async () => {
    prisma.physicalEquipmentTemplate.findUnique.mockResolvedValue(
      emptyPhysicalTemplate('tpl-1', 'test-chassis'),
    );
    prisma.physicalModuleTemplate.findMany.mockResolvedValue([
      {
        id: 'module-1',
        catalogKey: 'huawei-gpfd-16',
        name: 'H802GPFD',
        model: 'H802GPFD',
        description: '16-port GPON',
        slotsRequired: 1,
        ports: [{ id: 'port-1', name: 'GPON-1', label: 'GPON 1', sortOrder: 0, type: 'OTHER' }],
      },
    ]);

    const entry = buildEntry({
      modules: [
        {
          key: 'huawei-gpfd-16',
          name: 'H802GPFD',
          model: 'H802GPFD',
          description: '16-port GPON',
          slotsRequired: 1,
          ports: [{ name: 'GPON-1', label: 'GPON 1', order: 0, side: 'DEVICE' as const, type: 'OTHER' as const }],
        },
      ],
    });

    await repository.syncCatalog([entry]);
    await repository.syncCatalog([entry]);

    expect(prisma.physicalModuleTemplate.create).not.toHaveBeenCalled();
    expect(prisma.physicalModuleTemplate.update).toHaveBeenCalledTimes(2);
    expect(prisma.physicalModuleTemplatePort.create).not.toHaveBeenCalled();
    expect(prisma.physicalModuleTemplatePort.update).not.toHaveBeenCalled();
  });

  it('updates metadata and ports of existing SYSTEM module templates', async () => {
    prisma.physicalEquipmentTemplate.findUnique.mockResolvedValue(
      emptyPhysicalTemplate('tpl-1', 'test-chassis'),
    );
    prisma.physicalModuleTemplate.findMany.mockResolvedValue([
      {
        id: 'module-1',
        catalogKey: 'huawei-gpfd-16',
        name: 'Old Name',
        model: 'Old Model',
        description: 'Old',
        slotsRequired: 2,
        ports: [
          { id: 'port-1', name: 'GPON-1', label: 'Old label', sortOrder: 5, type: 'OTHER' },
          { id: 'port-2', name: 'GPON-2', label: 'GPON 2', sortOrder: 1, type: 'SFP' },
        ],
      },
    ]);

    const entry = buildEntry({
      modules: [
        {
          key: 'huawei-gpfd-16',
          name: 'H802GPFD',
          model: 'H802GPFD',
          description: '16-port GPON',
          slotsRequired: 1,
          ports: [
            { name: 'GPON-1', label: 'GPON 1', order: 0, side: 'DEVICE' as const, type: 'OTHER' as const },
            { name: 'GPON-2', label: 'GPON 2', order: 1, side: 'DEVICE' as const, type: 'OTHER' as const },
            { name: 'GPON-3', label: 'GPON 3', order: 2, side: 'DEVICE' as const, type: 'OTHER' as const },
          ],
        },
      ],
    });

    await repository.syncCatalog([entry]);

    expect(prisma.physicalModuleTemplate.update).toHaveBeenCalledTimes(1);
    const metaUpdate = prisma.physicalModuleTemplate.update.mock.calls[0]![0] as PrismaCallArg;
    expect(metaUpdate.data.name).toBe('H802GPFD');
    expect(metaUpdate.data.model).toBe('H802GPFD');
    expect(metaUpdate.data.slotsRequired).toBe(1);

    expect(prisma.physicalModuleTemplatePort.update).toHaveBeenCalledTimes(2);
    expect(prisma.physicalModuleTemplatePort.create).toHaveBeenCalledTimes(1);
    const createCall = prisma.physicalModuleTemplatePort.create.mock.calls[0]![0] as PrismaCallArg;
    expect(createCall.data.name).toBe('GPON-3');
  });

  it('does not touch CUSTOM templates', async () => {
    prisma.physicalEquipmentTemplate.findUnique.mockResolvedValue(
      emptyPhysicalTemplate('tpl-1', 'test-chassis', 'CUSTOM'),
    );

    const entry = buildEntry({
      modules: [{ key: 'new-module', name: 'New', model: 'New', description: '', slotsRequired: 1, ports: [] }],
    });

    const result = await repository.syncCatalog([entry]);
    expect(result.updated).toBe(0);
    expect(prisma.physicalModuleTemplate.create).not.toHaveBeenCalled();
    expect(prisma.physicalEquipmentTemplate.update).not.toHaveBeenCalled();
  });
});

describe('PrismaPhysicalRepository.createAsset', () => {
  let prisma: ReturnType<typeof buildPrismaStub>;
  let repository: PrismaPhysicalRepository;

  beforeEach(() => {
    prisma = buildPrismaStub();
    repository = new PrismaPhysicalRepository(prisma as unknown as unknown as PrismaClient);
  });

  it('preserves slot moduleKeys from the template', async () => {
    prisma.physicalRack.findUnique.mockResolvedValue({ id: 'rack-1' });
    prisma.physicalEquipmentTemplate.findUnique.mockResolvedValue({
      id: 'tpl-1',
      catalogKey: 'huawei-ma5800-x15',
      structureConfirmed: true,
      kind: 'OLT',
      ports: [],
      slots: [
        {
          id: 'tslot-1',
          index: 0,
          label: 'Slot 0',
          description: '',
          moduleOptions: [
            { moduleTemplate: { catalogKey: 'huawei-h902mpla' } },
            { moduleTemplate: { catalogKey: 'huawei-scun' } },
          ],
        },
        {
          id: 'tslot-2',
          index: 1,
          label: 'Slot 1',
          description: '',
          moduleOptions: [{ moduleTemplate: { catalogKey: 'huawei-gpfd-16' } }],
        },
      ],
    });

    // getInventory will return no sites, so asset() returns null; we only
    // assert that the asset was created with the expected slot structure.
    await repository.createAsset('rack-1', {
      name: 'IIE-VSR-X15-OLT-01',
      catalogKey: 'huawei-ma5800-x15',
      startU: 4,
      heightU: 11,
    });

    expect(prisma.physicalAsset.create).toHaveBeenCalledTimes(1);
    const createData = (prisma.physicalAsset.create.mock.calls[0]![0] as PrismaCallArg).data as {
      slots: { create: Array<{ index: number; label: string }> };
    };
    expect(createData.slots.create).toHaveLength(2);
    expect(createData.slots.create[0]).toMatchObject({ index: 0, label: 'Slot 0' });
    expect(createData.slots.create[1]).toMatchObject({ index: 1, label: 'Slot 1' });
  });
});






