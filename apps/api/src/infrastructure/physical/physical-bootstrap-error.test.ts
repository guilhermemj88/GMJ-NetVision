import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PhysicalCatalogError } from './physical-catalog-yaml';
import { PhysicalService } from './physical-service';
import type { PhysicalRepository, PhysicalCatalogSyncResult } from './physical-repository';

/**
 * Startup/bootstrap policy: the YAML file is the source of truth. When it exists
 * but is invalid the bootstrap must fail loudly — the built-in fallback is only
 * for a missing file and is never used to hide a broken catalog.
 */

const previousOverride = process.env.PHYSICAL_CATALOG_YAML_PATH;
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'netvision-bootstrap-'));
});

afterEach(() => {
  if (previousOverride === undefined) delete process.env.PHYSICAL_CATALOG_YAML_PATH;
  else process.env.PHYSICAL_CATALOG_YAML_PATH = previousOverride;
  rmSync(directory, { recursive: true, force: true });
});

function stubRepository(): { repository: PhysicalRepository; syncCatalog: ReturnType<typeof vi.fn> } {
  const syncCatalog = vi.fn(
    async (entries: readonly unknown[]): Promise<PhysicalCatalogSyncResult> => ({
      created: entries.length,
      updated: 0,
      total: entries.length,
    }),
  );
  return { repository: { syncCatalog } as unknown as PhysicalRepository, syncCatalog };
}

describe('bootstrap do catálogo físico', () => {
  it('falha com erro tipado quando o YAML existe e é inválido (sem fallback silencioso)', async () => {
    const file = join(directory, 'physical-catalog-v1.yaml');
    writeFileSync(file, 'schemaVersion: 1\ntemplates:\n  - catalogKey: quebrado\n', 'utf8');
    process.env.PHYSICAL_CATALOG_YAML_PATH = file;

    const { repository, syncCatalog } = stubRepository();
    const service = new PhysicalService(repository);

    expect(service.getCatalogSource().source).toBe('invalid');
    await expect(service.bootstrapCatalog()).rejects.toBeInstanceOf(PhysicalCatalogError);
    await expect(service.bootstrapCatalog()).rejects.toMatchObject({
      details: expect.arrayContaining([expect.stringMatching(/templates\.0/)]),
    });
    // nothing was written to the database with a broken catalog
    expect(syncCatalog).not.toHaveBeenCalled();
  });

  it('usa o YAML válido e reporta a origem no resultado do bootstrap', async () => {
    delete process.env.PHYSICAL_CATALOG_YAML_PATH;

    const { repository, syncCatalog } = stubRepository();
    const service = new PhysicalService(repository);
    const source = service.getCatalogSource();
    expect(source.source).toBe('yaml');
    expect(source.path).toMatch(/physical-catalog-v1\.yaml$/);
    expect(source.errors).toEqual([]);
    expect(source.unsupportedFields).toEqual([]);

    const result = await service.bootstrapCatalog();
    expect(result.source).toBe('yaml');
    expect(result.counts.templates).toBe(119);
    expect(syncCatalog).toHaveBeenCalledTimes(1);
    expect(syncCatalog.mock.calls[0]?.[0]).toHaveLength(119);
  });

  it('trata catalogKey duplicado como erro explícito (nenhum registro é sobrescrito)', async () => {
    const file = join(directory, 'physical-catalog-v1.yaml');
    const template = (key: string, model: string) =>
      `  - catalogKey: ${key}\n    manufacturer: Teste\n    family: T\n    model: ${model}\n    kind: SWITCH\n    layoutType: FIXED\n    heightU: 1\n    rackMount: true\n    vendorVerified: false\n    portGroups: []\n    slotGroups: []\n`;
    writeFileSync(
      file,
      `schemaVersion: '1.0'\ntemplates:\n${template('dup-key', 'A')}${template('dup-key', 'B')}`,
      'utf8',
    );
    process.env.PHYSICAL_CATALOG_YAML_PATH = file;

    const { repository, syncCatalog } = stubRepository();
    const service = new PhysicalService(repository);
    const source = service.getCatalogSource();
    expect(source.source).toBe('invalid');
    expect(source.errors.join(' ')).toContain('catalogKey duplicado: dup-key');
    await expect(service.bootstrapCatalog()).rejects.toBeInstanceOf(PhysicalCatalogError);
    expect(syncCatalog).not.toHaveBeenCalled();
  });

  it('trata moduleKey duplicado como erro explícito', async () => {
    const file = join(directory, 'physical-catalog-v1.yaml');
    const module = (name: string) =>
      `  - moduleKey: dup-module\n    manufacturer: Teste\n    partNumber: ${name}\n    name: ${name}\n    compatibleCatalogKeys: [dup-chassis]\n    vendorVerified: false\n    portGroups: []\n`;
    writeFileSync(
      file,
      `schemaVersion: '1.0'\ntemplates:\n  - catalogKey: dup-chassis\n    manufacturer: Teste\n    family: T\n    model: C\n    kind: ROUTER\n    layoutType: MODULAR\n    heightU: 2\n    rackMount: true\n    vendorVerified: false\n    portGroups: []\n    slotGroups: []\n    compatibleModuleKeys: [dup-module]\nmoduleTemplates:\n${module('A')}${module('B')}`,
      'utf8',
    );
    process.env.PHYSICAL_CATALOG_YAML_PATH = file;

    const { repository, syncCatalog } = stubRepository();
    const service = new PhysicalService(repository);
    const source = service.getCatalogSource();
    expect(source.source).toBe('invalid');
    expect(source.errors.join(' ')).toContain('moduleKey duplicado: dup-module');
    await expect(service.bootstrapCatalog()).rejects.toBeInstanceOf(PhysicalCatalogError);
    expect(syncCatalog).not.toHaveBeenCalled();
  });
});
