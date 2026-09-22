import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyPhysicalInterface, physicalConnectorKey } from '@gmj/shared';
import { PHYSICAL_CATALOG } from './physical-catalog';
import {
  PhysicalCatalogError,
  catalogCandidates,
  expandPattern,
  loadPhysicalCatalog,
  loadPhysicalCatalogFile,
  resolveCatalogPath,
} from './physical-catalog-yaml';

/**
 * `physical-catalog-v1.yaml` is the source of truth: these tests read the real
 * file from the repository and check that nothing in it is silently ignored.
 */

const realPath = resolveCatalogPath();
const previousOverride = process.env.PHYSICAL_CATALOG_YAML_PATH;

let directory: string;
let file: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'netvision-catalog-'));
  file = join(directory, 'physical-catalog-v1.yaml');
});

afterEach(() => {
  if (previousOverride === undefined) delete process.env.PHYSICAL_CATALOG_YAML_PATH;
  else process.env.PHYSICAL_CATALOG_YAML_PATH = previousOverride;
  rmSync(directory, { recursive: true, force: true });
});

describe('physical catalog YAML (arquivo real)', () => {
  it('é encontrado no caminho de produção do repositório', () => {
    expect(realPath).not.toBeNull();
    expect(realPath!.endsWith(join('apps', 'api', 'catalog', 'physical-catalog-v1.yaml'))).toBe(true);
  });

  it('carrega com source=yaml e sem merge com o catálogo embutido', () => {
    const result = loadPhysicalCatalog(PHYSICAL_CATALOG);
    expect(result.source).toBe('yaml');
    expect(result.errors).toEqual([]);
    expect(result.path).toBe(realPath);
    expect(result.schemaVersion).toBe('1.0');
    // YAML é a fonte: nada do catálogo embutido é misturado
    const yamlKeys = new Set(result.entries.map((entry) => entry.catalogKey));
    expect(yamlKeys.has('mikrotik-crs328-24p-4s-plus-rm')).toBe(false);
    expect(yamlKeys.has('mikrotik-crs328-24p-4splus-rm')).toBe(true);
  });

  it('importa todas as entradas declaradas no arquivo', () => {
    const raw = load(readFileSync(realPath!, 'utf8')) as {
      templates: unknown[];
      moduleTemplates: unknown[];
    };
    const result = loadPhysicalCatalog(PHYSICAL_CATALOG);
    expect(result.counts.templates).toBe(raw.templates.length);
    expect(result.counts.moduleTemplates).toBe(raw.moduleTemplates.length);
    expect(result.counts.templates).toBe(119);
    expect(result.counts.moduleTemplates).toBe(5);
    expect(result.counts.vendorVerified + result.counts.unverified).toBe(result.counts.templates);
    expect(result.counts.vendorVerified).toBe(54);
    expect(result.counts.unverified).toBe(65);
  });

  it('não descarta nenhum campo do YAML silenciosamente', () => {
    const result = loadPhysicalCatalog(PHYSICAL_CATALOG);
    expect(result.unsupportedFields).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('traz todas as famílias e os modelos que faltavam no fallback', () => {
    const keys = new Set(loadPhysicalCatalog(PHYSICAL_CATALOG).entries.map((entry) => entry.catalogKey));
    for (const key of [
      'mikrotik-rb750',
      'mikrotik-rb750gr3',
      'mikrotik-rb760igs',
      'mikrotik-rb2011uias-rm',
      'mikrotik-rb3011uias-rm',
      'juniper-mx80',
      'juniper-mx104',
      'juniper-mx204',
      'huawei-s6750-h48x8c',
      'huawei-s6750-h48y8c',
      'huawei-s6730-h24x6c',
      'huawei-s6730-h48x6c-v2',
      'zte-zxa10-c320',
      'fiberhome-an5516-01',
      'vsol-v5600x7',
      'datacom-dm4370-4gt-4gx-4xs',
      'generic-switch-1u',
    ]) {
      expect(keys.has(key), `faltou ${key}`).toBe(true);
    }
    const manufacturers = new Set(
      loadPhysicalCatalog(PHYSICAL_CATALOG).entries.map((entry) => entry.manufacturer),
    );
    expect([...manufacturers].sort()).toEqual([
      'Datacom',
      'FiberHome',
      'Generic',
      'Huawei',
      'Juniper',
      'MikroTik',
      'VSOL',
      'ZTE',
    ]);
  });

  it('expande grupos de porta, gerencia/console e slots com módulos compatíveis', () => {
    const result = loadPhysicalCatalog(PHYSICAL_CATALOG);
    const mikrotik = result.entries.find((entry) => entry.catalogKey === 'mikrotik-crs328-24p-4splus-rm')!;
    expect(mikrotik.ports).toHaveLength(28);
    expect(mikrotik.ports[0]).toMatchObject({
      name: 'ether1',
      label: 'ether1',
      connector: 'RJ45',
      portFunction: 'SERVICE',
      speeds: ['1G'],
      groupKey: 'ether',
      interfaceName: 'ether1',
    });
    expect(mikrotik.ports.at(-1)).toMatchObject({ name: 'sfp-sfpplus4', connector: 'SFP_PLUS' });
    expect(mikrotik.vendorVerified).toBe(false);
    // estrutura declarada é materializável mesmo sem vendorVerified
    expect(mikrotik.structureConfirmed).toBe(true);
    expect(mikrotik.layoutType).toBe('FIXED');

    const juniper = result.entries.find((entry) => entry.catalogKey === 'juniper-mx80')!;
    expect(juniper.slots.length).toBeGreaterThan(0);
    expect(juniper.slots[0]!.moduleKeys).toContain('juniper-mic-3d-20ge-sfp');
    expect(juniper.modules.map((module) => module.key)).toContain('juniper-mic-3d-20ge-sfp');
    const mic = juniper.modules.find((module) => module.key === 'juniper-mic-3d-20ge-sfp')!;
    expect(mic.ports).toHaveLength(20);
    expect(mic.ports[0]).toMatchObject({ connector: 'SFP', portFunction: 'SERVICE' });
    expect(mic.partNumber).toBe('MIC-3D-20GE-SFP');

    const datacom = result.entries.find((entry) => entry.catalogKey === 'datacom-dm4370-4gt-4gx-4xs')!;
    expect(datacom.ports.some((port) => port.portFunction === 'MGMT')).toBe(true);
    expect(datacom.ports.some((port) => port.portFunction === 'CONSOLE')).toBe(true);

    const ma5800 = result.entries.find((entry) => entry.catalogKey === 'huawei-ma5800-x7')!;
    expect(ma5800.vendorVerified).toBe(true);
    expect(ma5800.slots.length).toBeGreaterThan(0);
    expect(ma5800.ports).toHaveLength(0);

    const generic = result.entries.find((entry) => entry.catalogKey === 'generic-switch-1u')!;
    expect(generic.ports).toHaveLength(0);
    expect(generic.structureConfirmed).toBe(true);
    expect(generic.modules).toHaveLength(0);
  });

  it('mantém referenceUrls resolvidas a partir de sources', () => {
    const result = loadPhysicalCatalog(PHYSICAL_CATALOG);
    const rb5009 = result.entries.find((entry) => entry.catalogKey === 'mikrotik-rb5009ug-s-in')!;
    expect(rb5009.referenceUrls?.length ?? 0).toBeGreaterThan(0);
    expect(rb5009.referenceUrl).toMatch(/^https?:\/\//);
    expect(rb5009.vendorVerified).toBe(true);
  });

  it('preserva altura fracionária sem perder o valor original (MX104 3.5U)', () => {
    const result = loadPhysicalCatalog(PHYSICAL_CATALOG);
    const mx104 = result.entries.find((entry) => entry.catalogKey === 'juniper-mx104')!;
    expect(mx104.heightUExact).toBe(3.5);
    expect(mx104.heightU).toBe(4);
  });

  it('preserva rackMount=false e o layout modular', () => {
    const result = loadPhysicalCatalog(PHYSICAL_CATALOG);
    const rb5009 = result.entries.find((entry) => entry.catalogKey === 'mikrotik-rb5009ug-s-in')!;
    expect(rb5009.rackMount).toBe(false);
    const chassis = result.entries.find((entry) => entry.catalogKey === 'huawei-ma5800-x7')!;
    expect(chassis.layoutType).toBe('MODULAR');
    expect(chassis.modules.length).toBe(0);
  });
});

describe('physical catalog YAML (política de falha)', () => {
  it('usa o embutido apenas quando o arquivo não existe', () => {
    process.env.PHYSICAL_CATALOG_YAML_PATH = join(directory, 'missing.yaml');
    const result = loadPhysicalCatalog(PHYSICAL_CATALOG, directory);
    expect(result.source).toBe('builtin');
    expect(result.entries).toHaveLength(PHYSICAL_CATALOG.length);
    expect(result.warnings.join(' ')).toContain('não encontrado');
  });

  it('não cai em fallback silencioso quando o YAML existe e é inválido', () => {
    writeFileSync(file, 'schemaVersion: 1\ntemplates:\n  - catalogKey: quebrado\n', 'utf8');
    process.env.PHYSICAL_CATALOG_YAML_PATH = file;
    const result = loadPhysicalCatalog(PHYSICAL_CATALOG, directory);
    expect(result.source).toBe('invalid');
    expect(result.entries).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join(' ')).toMatch(/templates\.0/);
  });

  it('reporta erro claro para campos obrigatórios ausentes', () => {
    writeFileSync(
      file,
      'schemaVersion: 1\ntemplates:\n  - catalogKey: x\n    manufacturer: A\n    model: B\n    kind: SWITCH\n    heightU: 1\n',
      'utf8',
    );
    const result = loadPhysicalCatalogFile(file);
    expect(result.source).toBe('invalid');
    expect(result.errors.join(' ')).toMatch(/templates\.0/);
  });

  it('expõe erro tipado para o bootstrap', () => {
    const error = new PhysicalCatalogError('inválido', ['templates.0: required']);
    expect(error.name).toBe('PhysicalCatalogError');
    expect(error.details).toEqual(['templates.0: required']);
  });

  it('lista os caminhos de busca com o override do ambiente na frente', () => {
    process.env.PHYSICAL_CATALOG_YAML_PATH = file;
    expect(catalogCandidates('/workspace')).toEqual([
      resolve(file),
      resolve('/workspace', 'apps/api/catalog/physical-catalog-v1.yaml'),
      resolve('/workspace', 'catalog/physical-catalog-v1.yaml'),
    ]);
  });
});

describe('expansão de padrões do catálogo', () => {
  it('expande {n}, {n+offset} e ordinais literais', () => {
    expect(expandPattern('ether{n}', 3)).toEqual(['ether1', 'ether2', 'ether3']);
    expect(expandPattern('ether{n+5}', 5)).toEqual([
      'ether6',
      'ether7',
      'ether8',
      'ether9',
      'ether10',
    ]);
    expect(expandPattern('ether8', 1)).toEqual(['ether8']);
    expect(expandPattern('sfp1', 4)).toEqual(['sfp1', 'sfp2', 'sfp3', 'sfp4']);
    expect(expandPattern('XE-2/0/{n}', 2)).toEqual(['XE-2/0/1', 'XE-2/0/2']);
    expect(expandPattern('SFP+-1', 1)).toEqual(['SFP+-1']);
  });
});

describe('breakout QSFP/QSFP28 no catálogo', () => {
  it('colapsa as lanes no mesmo cage físico', () => {
    // MikroTik RouterOS: qsfp28-1-1..4 são lanes do cage qsfp28-1
    const lanes = ['qsfp28-1-1', 'qsfp28-1-2', 'qsfp28-1-3', 'qsfp28-1-4'];
    const keys = new Set(lanes.map((name) => physicalConnectorKey(name)));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe(physicalConnectorKey('qsfp28-1'));
    for (const lane of lanes) {
      expect(classifyPhysicalInterface(lane).classification).toBe('LOGICAL');
    }
    // modo 1x100G: apenas qsfp28-1-1 aparece, ainda aponta para o cage
    expect(physicalConnectorKey('qsfp28-1-1')).toBe('qsfp28:1');
  });

  it('colapsa as lanes Juniper no cage et-0/0/0 e mantém .100 como lógico', () => {
    for (const lane of ['et-0/0/0:0', 'et-0/0/0:1', 'et-0/0/0:2', 'et-0/0/0:3']) {
      expect(physicalConnectorKey(lane)).toBe('et:0/0/0');
      expect(classifyPhysicalInterface(lane).classification).toBe('LOGICAL');
    }
    expect(physicalConnectorKey('et-0/0/0')).toBe('et:0/0/0');
    // subinterface continua lógica pura, sem cage
    expect(classifyPhysicalInterface('et-0/0/0.100').classification).toBe('LOGICAL');
    expect(physicalConnectorKey('et-0/0/0.100')).toBeNull();
    // Huawei
    expect(physicalConnectorKey('100GE1/0/1:1')).toBe('100ge:1/0/1');
    expect(physicalConnectorKey('100GE1/0/1')).toBe('100ge:1/0/1');
  });
});
