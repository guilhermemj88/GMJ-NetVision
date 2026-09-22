import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { z } from 'zod';
import type {
  PhysicalAssetKind,
  PhysicalCatalogCategory,
  PhysicalCatalogEntry,
  PhysicalCatalogModule,
  PhysicalCatalogPort,
  PhysicalCatalogSlot,
  PhysicalConnectorKind,
  PhysicalPanelLayout,
  PhysicalPortFunction,
  PhysicalPortSide,
  PhysicalPortType,
  PhysicalVisualPlacement,
} from '@gmj/shared';

/**
 * Loader for `apps/api/catalog/physical-catalog-v1.yaml`.
 *
 * The YAML is the **source of truth** of the SYSTEM catalog: when the file
 * exists and is valid it is used as-is (no merge with the built-in TypeScript
 * catalog, which exists only as an emergency fallback when the file is absent).
 *
 * Real YAML shape (v1.0):
 *
 * ```yaml
 * schemaVersion: '1.0'
 * sources: { <sourceId>: { vendor, title, url, kind } }
 * templates: [{ catalogKey, manufacturer, family, model, aliases, kind,
 *   layoutType, heightU, rackMount, vendorVerified, portGroups, slotGroups,
 *   compatibleModuleKeys, managementPorts, consolePorts, sourceRefs,
 *   verificationNote }]
 * moduleTemplates: [{ moduleKey, manufacturer, partNumber, name,
 *   compatibleCatalogKeys, vendorVerified, portGroups, sourceRefs }]
 * ```
 *
 * A present but invalid file is reported as an error (`source: 'invalid'`) and
 * never silently replaced by the fallback.
 */

const CONNECTOR_KINDS = [
  'RJ45',
  'SFP',
  'SFP_PLUS',
  'SFP28',
  'XFP',
  'QSFP_PLUS',
  'QSFP28',
  'QSFP56',
  'QSFP_DD',
  'COMBO',
  'USB_MINI_B',
  'OTHER',
] as const;

const PORT_ROLES = [
  'SERVICE',
  'UPLINK',
  'MGMT',
  'MGMT_OR_SERVICE',
  'PON',
  'CONSOLE',
  'POWER',
] as const;

/** Connector declared by the YAML → coarse type accepted by PhysicalPort. */
const CONNECTOR_TO_TYPE: Record<string, PhysicalPortType> = {
  RJ45: 'RJ45',
  SFP: 'SFP',
  SFP_PLUS: 'SFP_PLUS',
  SFP28: 'SFP_PLUS',
  XFP: 'SFP_PLUS',
  QSFP_PLUS: 'QSFP',
  QSFP28: 'QSFP',
  QSFP56: 'QSFP',
  QSFP_DD: 'QSFP',
  COMBO: 'OTHER',
  USB_MINI_B: 'OTHER',
  OTHER: 'OTHER',
};

const KIND_TO_CATEGORY: Record<PhysicalAssetKind, PhysicalCatalogCategory> = {
  NETWORK: 'GENERIC',
  SERVER: 'SERVER',
  OLT: 'OLT',
  DIO: 'PASSIVE',
  PATCH_PANEL: 'PASSIVE',
  POWER: 'POWER',
  GENERIC: 'GENERIC',
};

const YAML_KIND_TO_ASSET_KIND: Record<string, PhysicalAssetKind> = {
  ROUTER: 'NETWORK',
  SWITCH: 'NETWORK',
  OLT: 'OLT',
  SERVER: 'SERVER',
  DIO: 'DIO',
  PATCH_PANEL: 'PATCH_PANEL',
  POWER: 'POWER',
  GENERIC: 'GENERIC',
};

const visualSchema = z.looseObject({
  row: z.number().optional(),
  rows: z.number().optional(),
  columns: z.number().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  gapX: z.number().optional(),
  gapY: z.number().optional(),
});

const panelLayoutSchema = z.looseObject({
  type: z.string().optional(),
  width: z.number().positive().max(1000),
  height: z.number().positive().max(1000),
});

const portGroupSchema = z.looseObject({
  groupKey: z.string().min(1),
  count: z.number().int().min(0).max(4096),
  connector: z.string().min(1),
  role: z.string().min(1),
  speeds: z.array(z.string()).optional(),
  breakoutCapable: z.boolean().optional(),
  physicalLabelPattern: z.string().optional(),
  interfaceNamePattern: z.string().optional(),
  notes: z.string().optional(),
  visual: visualSchema.optional(),
});

const slotGroupSchema = z.looseObject({
  groupKey: z.string().min(1),
  slotIds: z.array(z.union([z.string(), z.number()])).min(1),
  role: z.string().optional(),
  capacityNote: z.string().optional(),
  visual: visualSchema.optional(),
});

const inlinePortSchema = z.looseObject({
  count: z.number().int().min(0).max(4096).optional(),
  connector: z.string().optional(),
  role: z.string().optional(),
  label: z.string().optional(),
  notes: z.string().optional(),
});

const templateSchema = z.looseObject({
  catalogKey: z.string().min(1),
  manufacturer: z.string().min(1),
  family: z.string().optional(),
  model: z.string().min(1),
  aliases: z.array(z.string()).optional(),
  kind: z.string().min(1),
  layoutType: z.string().optional(),
  // 3.5U chassis exist (Juniper MX104): the loader keeps the exact value and
  // rounds the occupied rack units up.
  heightU: z.number().positive().max(200),
  rackMount: z.boolean().optional(),
  vendorVerified: z.boolean(),
  portGroups: z.array(portGroupSchema).optional(),
  slotGroups: z.array(slotGroupSchema).optional(),
  compatibleModuleKeys: z.array(z.string()).optional(),
  managementPorts: z.array(inlinePortSchema).optional(),
  consolePorts: z.array(inlinePortSchema).optional(),
  sourceRefs: z.array(z.string()).optional(),
  verificationNote: z.string().optional(),
  panelLayout: panelLayoutSchema.optional(),
});

const moduleTemplateSchema = z.looseObject({
  moduleKey: z.string().min(1),
  manufacturer: z.string().min(1),
  partNumber: z.string().optional(),
  name: z.string().min(1),
  compatibleCatalogKeys: z.array(z.string()).optional(),
  vendorVerified: z.boolean(),
  portGroups: z.array(portGroupSchema).optional(),
  sourceRefs: z.array(z.string()).optional(),
  panelLayout: panelLayoutSchema.optional(),
});

const sourceSchema = z.looseObject({
  vendor: z.string().min(1),
  title: z.string().min(1),
  url: z.string().min(1),
  kind: z.string().optional(),
});

const documentSchema = z.looseObject({
  schemaVersion: z.union([z.string(), z.number()]).optional(),
  catalogKey: z.string().optional(),
  generatedFor: z.string().optional(),
  purpose: z.string().optional(),
  policies: z.record(z.string(), z.unknown()).optional(),
  interfaceClassification: z.record(z.string(), z.unknown()).optional(),
  sources: z.record(z.string(), sourceSchema).optional(),
  templates: z.array(templateSchema).min(1),
  moduleTemplates: z.array(moduleTemplateSchema).optional(),
  implementationNotes: z.array(z.string()).optional(),
});

export class PhysicalCatalogError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'PhysicalCatalogError';
  }
}

export interface CatalogLoadResult {
  entries: PhysicalCatalogEntry[];
  source: 'yaml' | 'builtin' | 'invalid';
  path: string | null;
  warnings: string[];
  errors: string[];
  schemaVersion: string | null;
  /** YAML fields the importer does not represent yet (never dropped silently). */
  unsupportedFields: string[];
  counts: {
    templates: number;
    moduleTemplates: number;
    vendorVerified: number;
    unverified: number;
    ports: number;
    slots: number;
  };
}

const EMPTY_COUNTS = {
  templates: 0,
  moduleTemplates: 0,
  vendorVerified: 0,
  unverified: 0,
  ports: 0,
  slots: 0,
};

/** Paths tried, in order. `PHYSICAL_CATALOG_YAML_PATH` always wins. */
export function catalogCandidates(cwd = process.cwd()): string[] {
  const override = process.env.PHYSICAL_CATALOG_YAML_PATH?.trim();
  return [
    ...(override ? [resolve(override)] : []),
    resolve(cwd, 'apps/api/catalog/physical-catalog-v1.yaml'),
    resolve(cwd, 'catalog/physical-catalog-v1.yaml'),
  ];
}

export function resolveCatalogPath(cwd = process.cwd()): string | null {
  return catalogCandidates(cwd).find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Expands a catalog pattern into individual ordinals.
 *
 * - `ether{n}` with count 3 → `ether1`, `ether2`, `ether3`;
 * - `ether{n+5}` with count 5 → `ether6`...`ether10` (offset pattern semantics
 *   documented in `implementationNotes`);
 * - `ether8` with count 1 → `ether8` (literal ordinal is preserved);
 * - `sfp1` with count 4 → `sfp1`...`sfp4`.
 */
export function expandPattern(pattern: string, count: number): string[] {
  if (count <= 0) return [];
  const offset = /\{n\+(\d+)\}/.exec(pattern);
  if (offset) {
    const start = Number(offset[1]) + 1;
    return Array.from({ length: count }, (_value, index) =>
      pattern.replace(/\{n\+\d+\}/, String(start + index)),
    );
  }
  if (pattern.includes('{n}')) {
    return Array.from({ length: count }, (_value, index) =>
      pattern.replace(/\{n\}/g, String(index + 1)),
    );
  }
  const literal = /(\d+)/.exec(pattern);
  if (literal && count > 1) {
    const start = Number(literal[1]);
    const head = pattern.slice(0, literal.index);
    const tail = pattern.slice(literal.index + literal[1]!.length);
    return Array.from({ length: count }, (_value, index) => `${head}${start + index}${tail}`);
  }
  if (literal) return [pattern];
  return Array.from({ length: count }, (_value, index) => `${pattern}${index + 1}`);
}

function portFunction(role: string | undefined): PhysicalPortFunction | null {
  if (!role) return null;
  return (PORT_ROLES as readonly string[]).includes(role) ? (role as PhysicalPortFunction) : null;
}

function connectorKind(connector: string | undefined): PhysicalConnectorKind | null {
  if (!connector) return null;
  return (CONNECTOR_KINDS as readonly string[]).includes(connector)
    ? (connector as PhysicalConnectorKind)
    : null;
}

/** Only the declared coordinates are copied (exactOptionalPropertyTypes). */
function visualPlacement(
  visual: z.infer<typeof visualSchema> | undefined,
): PhysicalVisualPlacement | null {
  if (!visual) return null;
  const placement: PhysicalVisualPlacement = {};
  if (visual.row !== undefined) placement.row = visual.row;
  if (visual.rows !== undefined) placement.rows = visual.rows;
  if (visual.columns !== undefined) placement.columns = visual.columns;
  if (visual.x !== undefined) placement.x = visual.x;
  if (visual.y !== undefined) placement.y = visual.y;
  if (visual.width !== undefined) placement.width = visual.width;
  if (visual.height !== undefined) placement.height = visual.height;
  if (visual.gapX !== undefined) placement.gapX = visual.gapX;
  if (visual.gapY !== undefined) placement.gapY = visual.gapY;
  return Object.keys(placement).length ? placement : null;
}

/** The catalog only ever claims `FRONT` when it explicitly declares it. */
function panelLayout(
  layout: z.infer<typeof panelLayoutSchema> | undefined,
): PhysicalPanelLayout | null {
  if (!layout) return null;
  return {
    type: layout.type?.toUpperCase() === 'FRONT' ? 'FRONT' : 'LOGICAL',
    width: layout.width,
    height: layout.height,
  };
}

interface PortExpansion {
  ports: PhysicalCatalogPort[];
  warnings: string[];
}

function portsFromGroups(
  groups: Array<z.infer<typeof portGroupSchema>>,
  context: string,
): PortExpansion {
  const ports: PhysicalCatalogPort[] = [];
  const warnings: string[] = [];
  const used = new Set<string>();
  for (const group of groups) {
    const pattern = group.interfaceNamePattern ?? group.physicalLabelPattern;
    if (!pattern) {
      warnings.push(`${context}: grupo ${group.groupKey} sem interfaceNamePattern/physicalLabelPattern`);
      continue;
    }
    const names = expandPattern(pattern, group.count);
    const labels = group.physicalLabelPattern
      ? expandPattern(group.physicalLabelPattern, group.count)
      : names;
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index]!;
      if (used.has(name)) {
        warnings.push(`${context}: nome de porta repetido no catálogo (${name})`);
        continue;
      }
      used.add(name);
      ports.push({
        name,
        label: labels[index] ?? name,
        order: ports.length + 1,
        side: 'DEVICE' as PhysicalPortSide,
        type: CONNECTOR_TO_TYPE[group.connector] ?? 'OTHER',
        connector: connectorKind(group.connector),
        portFunction: portFunction(group.role),
        speeds: group.speeds ?? [],
        breakoutCapable: group.breakoutCapable ?? false,
        groupKey: group.groupKey,
        interfaceName: group.interfaceNamePattern ? name : null,
        notes: group.notes ?? null,
        visual: visualPlacement(group.visual),
      });
    }
  }
  return { ports, warnings };
}

function portsFromInline(
  entries: Array<z.infer<typeof inlinePortSchema>>,
  context: string,
  kind: 'MGMT' | 'CONSOLE',
): PortExpansion {
  const ports: PhysicalCatalogPort[] = [];
  const warnings: string[] = [];
  for (const entry of entries) {
    const count = entry.count ?? 1;
    for (let index = 0; index < count; index += 1) {
      const name = entry.label
        ? `${entry.label}${count > 1 ? index + 1 : ''}`
        : `${kind.toLowerCase()}${ports.length + 1}`;
      ports.push({
        name,
        label: name,
        order: ports.length + 1,
        side: 'DEVICE' as PhysicalPortSide,
        type: CONNECTOR_TO_TYPE[entry.connector ?? 'OTHER'] ?? 'OTHER',
        connector: connectorKind(entry.connector),
        portFunction: portFunction(entry.role) ?? (kind === 'CONSOLE' ? 'CONSOLE' : 'MGMT'),
        speeds: [],
        breakoutCapable: false,
        groupKey: kind.toLowerCase(),
        interfaceName: null,
        notes: entry.notes ?? null,
      });
    }
    if (entry.label === undefined && entry.count === undefined) {
      warnings.push(`${context}: ${kind} sem label/count — usando numeração sequencial`);
    }
  }
  return { ports, warnings };
}

function summarizePorts(ports: readonly PhysicalCatalogPort[]): string | null {
  if (!ports.length) return null;
  const groups = new Map<string, number>();
  for (const port of ports) {
    const key = `${port.connector ?? port.type}${port.speeds?.length ? ` ${port.speeds.join('/')}` : ''}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.entries()].map(([key, count]) => `${count}× ${key}`).join(' + ');
}

const KNOWN_TEMPLATE_FIELDS = new Set(Object.keys(templateSchema.shape));
const KNOWN_GROUP_FIELDS = new Set(Object.keys(portGroupSchema.shape));
const KNOWN_SLOT_FIELDS = new Set(Object.keys(slotGroupSchema.shape));
const KNOWN_MODULE_FIELDS = new Set(Object.keys(moduleTemplateSchema.shape));
const KNOWN_INLINE_FIELDS = new Set(Object.keys(inlinePortSchema.shape));
const KNOWN_DOCUMENT_FIELDS = new Set(Object.keys(documentSchema.shape));
const KNOWN_SOURCE_FIELDS = new Set(Object.keys(sourceSchema.shape));

/** Reports YAML fields the importer does not represent (never dropped silently). */
function collectUnsupported(
  document: Record<string, unknown>,
  templates: Array<Record<string, unknown>>,
  modules: Array<Record<string, unknown>>,
  sources: Record<string, unknown>,
): string[] {
  const unsupported: string[] = [];
  const report = (path: string, keys: string[], known: Set<string>) => {
    for (const key of keys) if (!known.has(key)) unsupported.push(`${path}.${key}`);
  };
  report('document', Object.keys(document), KNOWN_DOCUMENT_FIELDS);
  for (const [id, source] of Object.entries(sources)) {
    report(`sources[${id}]`, Object.keys((source ?? {}) as Record<string, unknown>), KNOWN_SOURCE_FIELDS);
  }
  templates.forEach((template, index) => {
    const key = String(template.catalogKey ?? `#${index}`);
    report(`templates[${key}]`, Object.keys(template), KNOWN_TEMPLATE_FIELDS);
    for (const group of (template.portGroups ?? []) as Array<Record<string, unknown>>) {
      report(`templates[${key}].portGroups[${String(group.groupKey ?? '?')}]`, Object.keys(group), KNOWN_GROUP_FIELDS);
    }
    for (const slot of (template.slotGroups ?? []) as Array<Record<string, unknown>>) {
      report(`templates[${key}].slotGroups[${String(slot.groupKey ?? '?')}]`, Object.keys(slot), KNOWN_SLOT_FIELDS);
    }
    for (const field of ['managementPorts', 'consolePorts'] as const) {
      for (const port of (template[field] ?? []) as Array<Record<string, unknown>>) {
        report(`templates[${key}].${field}`, Object.keys(port), KNOWN_INLINE_FIELDS);
      }
    }
  });
  modules.forEach((module, index) => {
    const key = String(module.moduleKey ?? `#${index}`);
    report(`moduleTemplates[${key}]`, Object.keys(module), KNOWN_MODULE_FIELDS);
    for (const group of (module.portGroups ?? []) as Array<Record<string, unknown>>) {
      report(
        `moduleTemplates[${key}].portGroups[${String(group.groupKey ?? '?')}]`,
        Object.keys(group),
        KNOWN_GROUP_FIELDS,
      );
    }
  });
  return unsupported;
}

function toEntry(
  template: z.infer<typeof templateSchema>,
  modulesByKey: Map<string, z.infer<typeof moduleTemplateSchema>>,
  sourceUrls: Map<string, string>,
): { entry: PhysicalCatalogEntry; warnings: string[] } {
  const context = template.catalogKey;
  const service = portsFromGroups(template.portGroups ?? [], context);
  const management = portsFromInline(template.managementPorts ?? [], context, 'MGMT');
  const consolePorts = portsFromInline(template.consolePorts ?? [], context, 'CONSOLE');
  const warnings = [...service.warnings, ...management.warnings, ...consolePorts.warnings];

  const ports = [...service.ports, ...management.ports, ...consolePorts.ports].map((port, index) => ({
    ...port,
    order: index + 1,
  }));

  const kind = YAML_KIND_TO_ASSET_KIND[template.kind] ?? 'GENERIC';
  const slots: PhysicalCatalogSlot[] = [];
  let slotIndex = 0;
  for (const group of template.slotGroups ?? []) {
    for (const slotId of group.slotIds) {
      slotIndex += 1;
      const numeric = String(slotId).replace(/[^0-9]/g, '');
      slots.push({
        index: numeric ? Number(numeric) : slotIndex,
        label: `${group.groupKey} ${slotId}`.trim(),
        description: group.capacityNote ?? '',
        moduleKeys: [...(template.compatibleModuleKeys ?? [])],
        slotRole: group.role ?? null,
        groupKey: group.groupKey,
        capacityNote: group.capacityNote ?? null,
        visual: visualPlacement(group.visual),
      });
    }
  }

  const declaredModuleKeys = new Set(template.compatibleModuleKeys ?? []);
  const modules: PhysicalCatalogModule[] = [];
  for (const module of modulesByKey.values()) {
    if (!declaredModuleKeys.has(module.moduleKey)) continue;
    const expansion = portsFromGroups(module.portGroups ?? [], `${context}/${module.moduleKey}`);
    warnings.push(...expansion.warnings);
    modules.push({
      key: module.moduleKey,
      name: module.name,
      model: module.partNumber ?? module.name,
      description: `${module.manufacturer} ${module.partNumber ?? module.name}`.trim(),
      slotsRequired: 1,
      ports: expansion.ports,
      manufacturer: module.manufacturer,
      partNumber: module.partNumber ?? null,
      vendorVerified: module.vendorVerified,
      compatibleCatalogKeys: module.compatibleCatalogKeys ?? [],
      referenceUrls: (module.sourceRefs ?? [])
        .map((ref) => sourceUrls.get(ref))
        .filter((url): url is string => Boolean(url)),
      panelLayout: panelLayout(module.panelLayout),
    });
  }

  const referenceUrls = (template.sourceRefs ?? [])
    .map((ref) => sourceUrls.get(ref))
    .filter((url): url is string => Boolean(url));
  const isGeneric = template.manufacturer.trim().toLowerCase() === 'generic';
  const hasDeclaredStructure =
    ports.length > 0 || slots.length > 0 || (template.compatibleModuleKeys ?? []).length > 0;

  const entry: PhysicalCatalogEntry = {
    catalogKey: template.catalogKey,
    // the YAML declares manufacturer + model, never a display name
    name: `${template.manufacturer} ${template.model}`.trim(),
    category:
      kind === 'NETWORK'
        ? template.kind === 'ROUTER'
          ? 'ROUTER'
          : 'SWITCH'
        : KIND_TO_CATEGORY[kind],
    manufacturer: template.manufacturer,
    family: template.family ?? '',
    model: template.model,
    kind,
    heightU: Math.ceil(template.heightU),
    heightUExact: template.heightU,
    vendorVerified: template.vendorVerified,
    structureConfirmed: isGeneric || hasDeclaredStructure,
    description: template.verificationNote ?? '',
    referenceUrl: referenceUrls[0] ?? null,
    portSummary: summarizePorts(ports),
    ports,
    slots,
    modules,
    layoutType:
      template.layoutType === 'MODULAR' ? 'MODULAR' : template.layoutType === 'FIXED' ? 'FIXED' : null,
    rackMount: template.rackMount ?? true,
    aliases: template.aliases ?? [],
    compatibleModuleKeys: template.compatibleModuleKeys ?? [],
    sourceRefs: template.sourceRefs ?? [],
    referenceUrls,
    verificationNote: template.verificationNote ?? null,
    panelLayout: panelLayout(template.panelLayout),
  };
  return { entry, warnings };
}

/** Reads, validates and converts the catalog file. Never falls back by itself. */
export function loadPhysicalCatalogFile(path: string): CatalogLoadResult {
  const base: CatalogLoadResult = {
    entries: [],
    source: 'invalid',
    path,
    warnings: [],
    errors: [],
    schemaVersion: null,
    unsupportedFields: [],
    counts: { ...EMPTY_COUNTS },
  };
  let raw: unknown;
  try {
    raw = load(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      ...base,
      errors: [
        `Falha ao ler ${path}: ${error instanceof Error ? error.message : 'erro desconhecido'}`,
      ],
    };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ...base, errors: [`${path}: conteúdo vazio ou inválido`] };
  }
  const parsed = documentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ...base,
      errors: parsed.error.issues
        .slice(0, 10)
        .map((issue) => `${issue.path.join('.') || 'documento'}: ${issue.message}`),
    };
  }

  const document = raw as Record<string, unknown>;
  const sources = (document.sources ?? {}) as Record<string, Record<string, unknown>>;
  const sourceUrls = new Map<string, string>(
    Object.entries(sources).map(([id, source]) => [id, String(source.url ?? '')]),
  );

  /**
   * Identity must be unique: a duplicated key would silently drop one record,
   * so it is reported as a hard error instead of a warning.
   */
  const duplicates = (keys: readonly string[]): string[] => {
    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const key of keys) {
      if (seen.has(key)) repeated.add(key);
      seen.add(key);
    }
    return [...repeated];
  };
  const duplicateTemplates = duplicates(parsed.data.templates.map((template) => template.catalogKey));
  const duplicateModules = duplicates(
    (parsed.data.moduleTemplates ?? []).map((module) => module.moduleKey),
  );
  if (duplicateTemplates.length || duplicateModules.length) {
    return {
      ...base,
      path,
      errors: [
        ...duplicateTemplates.map((key) => `templates: catalogKey duplicado: ${key}`),
        ...duplicateModules.map((key) => `moduleTemplates: moduleKey duplicado: ${key}`),
      ],
    };
  }

  const modulesByKey = new Map<string, z.infer<typeof moduleTemplateSchema>>(
    (parsed.data.moduleTemplates ?? []).map((module) => [module.moduleKey, module]),
  );

  const warnings: string[] = [];
  const entries: PhysicalCatalogEntry[] = [];
  for (const template of parsed.data.templates) {
    const converted = toEntry(template, modulesByKey, sourceUrls);
    warnings.push(...converted.warnings);
    entries.push(converted.entry);
  }
  const seen = new Set(parsed.data.templates.map((template) => template.catalogKey));

  const unsupportedFields = collectUnsupported(
    document,
    parsed.data.templates as Array<Record<string, unknown>>,
    (parsed.data.moduleTemplates ?? []) as Array<Record<string, unknown>>,
    sources,
  );
  for (const moduleKey of new Set(
    parsed.data.templates.flatMap((template) => template.compatibleModuleKeys ?? []),
  )) {
    if (!modulesByKey.has(moduleKey)) {
      warnings.push(`compatibleModuleKeys aponta para módulo inexistente: ${moduleKey}`);
    }
  }
  for (const module of parsed.data.moduleTemplates ?? []) {
    for (const key of module.compatibleCatalogKeys ?? []) {
      if (!seen.has(key)) {
        warnings.push(`módulo ${module.moduleKey} aponta para template inexistente: ${key}`);
      }
    }
  }

  const vendorVerified = entries.filter((entry) => entry.vendorVerified).length;
  return {
    entries,
    source: 'yaml',
    path,
    warnings,
    errors: [],
    schemaVersion: parsed.data.schemaVersion === undefined ? null : String(parsed.data.schemaVersion),
    unsupportedFields,
    counts: {
      templates: entries.length,
      moduleTemplates: modulesByKey.size,
      vendorVerified,
      unverified: entries.length - vendorVerified,
      ports: entries.reduce((total, entry) => total + entry.ports.length, 0),
      slots: entries.reduce((total, entry) => total + entry.slots.length, 0),
    },
  };
}

/**
 * Runtime policy:
 * - file present + valid → YAML only (source of truth, no merge);
 * - file present + invalid → `source: 'invalid'` with errors (no silent fallback);
 * - file absent → built-in catalog as emergency fallback (explicitly allowed).
 */
export function loadPhysicalCatalog(
  builtin: readonly PhysicalCatalogEntry[],
  cwd = process.cwd(),
): CatalogLoadResult {
  const path = resolveCatalogPath(cwd);
  if (!path) {
    return {
      entries: [...builtin],
      source: 'builtin',
      path: null,
      warnings: [
        'physical-catalog-v1.yaml não encontrado: usando o catálogo embutido de emergência',
      ],
      errors: [],
      schemaVersion: null,
      unsupportedFields: [],
      counts: {
        templates: builtin.length,
        moduleTemplates: builtin.reduce((total, entry) => total + entry.modules.length, 0),
        vendorVerified: builtin.filter((entry) => entry.vendorVerified).length,
        unverified: builtin.filter((entry) => !entry.vendorVerified).length,
        ports: builtin.reduce((total, entry) => total + entry.ports.length, 0),
        slots: builtin.reduce((total, entry) => total + entry.slots.length, 0),
      },
    };
  }
  return loadPhysicalCatalogFile(path);
}
