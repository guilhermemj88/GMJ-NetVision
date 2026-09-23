import type {
  PhysicalCatalogCategory,
  PhysicalCatalogEntry,
  PhysicalPortState,
} from '@gmj/shared';

/**
 * Presentation helpers for the physical catalog.
 *
 * They only reshape data returned by the API: nothing here decides height,
 * port counts or vendor names. When `structureConfirmed` is false the UI must
 * ask the operator for the values instead of filling them in.
 */

export const CATEGORY_ORDER: PhysicalCatalogCategory[] = [
  'ROUTER',
  'SWITCH',
  'OLT',
  'SERVER',
  'PASSIVE',
  'POWER',
  'GENERIC',
];

export const CATEGORY_LABELS: Record<PhysicalCatalogCategory, string> = {
  ROUTER: 'Roteador',
  SWITCH: 'Switch',
  OLT: 'OLT',
  SERVER: 'Servidor',
  PASSIVE: 'Passivo (DIO / patch panel)',
  POWER: 'Energia',
  GENERIC: 'Genérico',
};

export const PORT_STATE_LABELS: Record<PhysicalPortState, string> = {
  FREE: 'LIVRE',
  MAPPED: 'MAPEADA',
  LLDP_DETECTED: 'LLDP',
  CONNECTED: 'CONECTADA',
};

/** Papel do slot em português (rótulos do catálogo usam groupKeys técnicos). */
export function slotRoleLabel(role: string | null | undefined): string {
  switch (role) {
    case 'SERVICE':
    case 'SERVICE_OR_UPLINK':
      return 'Serviço/Uplink';
    case 'LPU':
      return 'Line Card';
    case 'CONTROL':
      return 'Controle';
    case 'UNIVERSAL':
      return 'Universal';
    case 'POWER':
      return 'Energia';
    case 'FAN':
      return 'Ventilação';
    default:
      return 'Slot';
  }
}

/** `Slot 1 · Serviço/Uplink` — legível, sem expor o groupKey interno. */
export function friendlySlotLabel(
  index: number,
  role: string | null | undefined,
  fallbackLabel?: string | null,
): string {
  const roleName = slotRoleLabel(role);
  if (role) return `Slot ${index} · ${roleName}`;
  return fallbackLabel?.trim() || `Slot ${index}`;
}

export function findCatalogEntry(
  entries: readonly PhysicalCatalogEntry[],
  catalogKey: string | null | undefined,
): PhysicalCatalogEntry | null {
  if (!catalogKey) return null;
  return entries.find((entry) => entry.catalogKey === catalogKey) ?? null;
}

export function catalogCategories(
  entries: readonly PhysicalCatalogEntry[],
): PhysicalCatalogCategory[] {
  const present = new Set(entries.map((entry) => entry.category));
  return CATEGORY_ORDER.filter((category) => present.has(category));
}

export function catalogManufacturers(
  entries: readonly PhysicalCatalogEntry[],
  category: PhysicalCatalogCategory | '',
): string[] {
  const scoped = category ? entries.filter((entry) => entry.category === category) : entries;
  return [...new Set(scoped.map((entry) => entry.manufacturer))].sort((a, b) => {
    // Real vendors first: the default selection should be a device, not "Genérico".
    if (a === 'Genérico') return 1;
    if (b === 'Genérico') return -1;
    return a.localeCompare(b, 'pt-BR');
  });
}

export function catalogModels(
  entries: readonly PhysicalCatalogEntry[],
  category: PhysicalCatalogCategory | '',
  manufacturer: string,
): PhysicalCatalogEntry[] {
  return entries.filter(
    (entry) =>
      (!category || entry.category === category) &&
      (!manufacturer || entry.manufacturer === manufacturer),
  );
}

/** Short, honest description of what the catalog knows about the chassis. */
export function catalogSpec(entry: PhysicalCatalogEntry): string {
  if (!entry.structureConfirmed) return 'Estrutura não confirmada · complete manualmente';
  const parts = [`${entry.heightU}U`];
  if (entry.ports.length) parts.push(`${entry.ports.length} portas`);
  if (entry.slots.length) parts.push(`${entry.slots.length} slots`);
  return parts.join(' · ');
}

export function structureBadge(entry: PhysicalCatalogEntry): {
  label: string;
  tone: 'verified' | 'open' | 'generic';
} {
  if (!entry.structureConfirmed) return { label: 'ESTRUTURA NÃO CONFIRMADA', tone: 'open' };
  if (entry.vendorVerified) return { label: 'VERIFICADO NO FABRICANTE', tone: 'verified' };
  return { label: 'TEMPLATE GENÉRICO', tone: 'generic' };
}

/** Existing asset count per interface is not needed; height/ports are. */
export function portTypeSummary(entry: PhysicalCatalogEntry): string {
  const totals = new Map<string, number>();
  for (const port of entry.ports) totals.set(port.type, (totals.get(port.type) ?? 0) + 1);
  if (!totals.size) return entry.portSummary ?? '';
  return [...totals.entries()]
    .map(([type, count]) => `${count}× ${type.replace('_PLUS', '+')}`)
    .join(' · ');
}
