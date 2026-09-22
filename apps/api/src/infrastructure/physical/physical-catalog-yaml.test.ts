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
    // V1.1: 121 templates de equipamento e 5 de placa (90 verificados / 31 pendentes)
    expect(result.counts.templates).toBe(121);
    expect(result.counts.moduleTemplates).toBe(5);
    expect(result.counts.vendorVerified + result.counts.unverified).toBe(result.counts.templates);
    expect(result.counts.vendorVerified).toBe(90);
    expect(result.counts.unverified).toBe(31);
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
    // V1.1: 24 ether + 4 SFP+ + 1 console serial declarado pelo fabricante
    expect(mikrotik.ports).toHaveLength(29);
    expect(mikrotik.ports[0]).toMatchObject({
      name: 'ether1',
      label: 'ether1',
      connector: 'RJ45',
      portFunction: 'SERVICE',
      speeds: ['1G'],
      groupKey: 'ether',
      interfaceName: 'ether1',
    });
    expect(mikrotik.ports.some((port) => port.name === 'sfp-sfpplus4')).toBe(true);
    expect(mikrotik.ports.some((port) => port.portFunction === 'CONSOLE')).toBe(true);
    expect(mikrotik.vendorVerified).toBe(true);
    // estrutura declarada é materializável mesmo quando o fabricante não foi verificado
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

  it('cobre os chassis e variantes novos do V1.1 (NE8000, NE40E e S6750)', () => {
    const result = loadPhysicalCatalog(PHYSICAL_CATALOG);
    const entry = (key: string) => result.entries.find((item) => item.catalogKey === key)!;

    // F1A-8H20Q: 8 x 100GE + 20 x 25GE + 28 x 10GE = 56 conectores físicos
    const f1a = entry('huawei-ne8000-f1a-8h20q');
    expect(f1a.vendorVerified).toBe(true);
    expect(f1a.ports).toHaveLength(56);
    expect(f1a.slots).toHaveLength(0);
    expect(f1a.ports.filter((port) => port.connector === 'QSFP28')).toHaveLength(8);

    // NE8000: apenas slots de placa, nenhuma porta inventada
    for (const [key, slots] of [
      ['huawei-ne8000-m4', 4],
      ['huawei-ne8000-m8-dc', 8],
      ['huawei-ne8000-m8-ac', 6],
    ] as const) {
      const chassis = entry(key);
      expect(chassis.vendorVerified).toBe(true);
      expect(chassis.slots).toHaveLength(slots);
      expect(chassis.ports).toHaveLength(0);
      expect(chassis.modules).toHaveLength(0);
    }

    // NE40E-X3: 4U (DC) e 5U (AC), 3 LPU cada; o placeholder genérico continua não verificado
    const x3Dc = entry('huawei-ne40e-x3-dc');
    expect(x3Dc.heightU).toBe(4);
    expect(x3Dc.slots).toHaveLength(3);
    expect(x3Dc.ports).toHaveLength(0);
    const x3Ac = entry('huawei-ne40e-x3-ac');
    expect(x3Ac.heightU).toBe(5);
    expect(x3Ac.slots).toHaveLength(3);
    expect(entry('huawei-ne40e-x3').vendorVerified).toBe(false);

    // S6750-H48Y8C-B (48 x SFP28 + 8 x QSFP28) e S6750-H36C (32 + 4)
    expect(entry('huawei-s6750-h48y8c-b').ports).toHaveLength(56);
    expect(entry('huawei-s6750-h36c').ports).toHaveLength(36);
    expect(entry('huawei-s6750-h36c').ports.some((port) => port.connector === 'QSFP28')).toBe(true);
  });

  it('declara geometria de painel nos templates prioritários (type LOGICAL)', () => {
    const result = loadPhysicalCatalog(PHYSICAL_CATALOG);
    const withPanel = result.entries.filter((entry) => entry.panelLayout);
    expect(withPanel.length).toBeGreaterThanOrEqual(40);
    expect(new Set(withPanel.map((entry) => entry.panelLayout!.type))).toEqual(new Set(['LOGICAL']));
    for (const key of [
      'huawei-ne8000-f1a-8h20q',
      'huawei-s6750-h48y8c-b',
      'huawei-s6730-h48x6c-v2',
      'mikrotik-crs328-24p-4splus-rm',
      'mikrotik-ccr2216-1g-12xs-2xq',
      'mikrotik-rb5009ug-s-in',
    ]) {
      const entry = result.entries.find((item) => item.catalogKey === key)!;
      expect(entry.panelLayout, key).toBeTruthy();
      expect(
        entry.ports.some((port) => port.visual && port.visual.row !== undefined),
        key,
      ).toBe(true);
    }
    // o layout não muda a estrutura física declarada no YAML
    expect(result.counts.ports).toBe(1480);
    expect(result.counts.slots).toBe(153);
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

describe('geometria visual declarada no catálogo', () => {
  it('aceita panelLayout/visual sem marcar campos como não representados', () => {
    writeFileSync(
      file,
      `schemaVersion: '1.0'
templates:
  - catalogKey: teste-visual
    manufacturer: Teste
    family: T
    model: M
    kind: SWITCH
    layoutType: FIXED
    heightU: 1
    rackMount: true
    vendorVerified: false
    panelLayout:
      type: LOGICAL
      width: 100
      height: 10
    portGroups:
      - groupKey: sfp
        count: 4
        connector: SFP
        role: SERVICE
        physicalLabelPattern: SFP-{n}
        visual:
          row: 1
          columns: 4
          x: 4
          y: 2
    slotGroups:
      - groupKey: lpu
        slotIds: [1, 2]
        role: SERVICE
        visual:
          x: 10
          y: 1
          width: 20
          height: 8
`,
      'utf8',
    );
    const result = loadPhysicalCatalogFile(file);
    expect(result.source).toBe('yaml');
    expect(result.errors).toEqual([]);
    expect(result.unsupportedFields).toEqual([]);
    const entry = result.entries[0]!;
    expect(entry.panelLayout).toEqual({ type: 'LOGICAL', width: 100, height: 10 });
    expect(entry.ports[0]!.visual).toMatchObject({ row: 1, columns: 4, x: 4, y: 2 });
    expect(entry.slots[0]!.visual).toMatchObject({ x: 10, width: 20, height: 8 });
  });

  it('preserva type: FRONT quando o catálogo declara posição oficial', () => {
    writeFileSync(
      file,
      `schemaVersion: '1.0'
templates:
  - catalogKey: teste-front
    manufacturer: Teste
    family: T
    model: M
    kind: SWITCH
    heightU: 1
    vendorVerified: true
    panelLayout: { type: FRONT, width: 120, height: 8 }
    portGroups: []
    slotGroups: []
`,
      'utf8',
    );
    const result = loadPhysicalCatalogFile(file);
    expect(result.entries[0]!.panelLayout).toEqual({ type: 'FRONT', width: 120, height: 8 });
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
