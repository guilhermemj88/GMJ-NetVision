import { describe, expect, it } from 'vitest';
import {
  CATEGORY_LABELS,
  catalogCategories,
  catalogManufacturers,
  catalogModels,
  catalogSpec,
  findCatalogEntry,
  portTypeSummary,
  structureBadge,
  PORT_STATE_LABELS,
} from './physical-catalog';
import { catalogEntry } from './physical-fixtures';

const catalog = [
  catalogEntry({ catalogKey: 'mikrotik-crs328-24p-4s-rm', category: 'SWITCH', manufacturer: 'MikroTik' }),
  catalogEntry({
    catalogKey: 'generic-switch-1u',
    name: 'Switch genérico 1U',
    category: 'SWITCH',
    manufacturer: 'Genérico',
    vendorVerified: false,
    heightU: 1,
  }),
  catalogEntry({
    catalogKey: 'zte-c320',
    name: 'ZTE C320',
    category: 'OLT',
    manufacturer: 'ZTE',
    family: 'C320',
    vendorVerified: false,
    structureConfirmed: false,
  }),
];

describe('physical catalog helpers', () => {
  it('lists only the categories present in the catalog, in a stable order', () => {
    expect(catalogCategories(catalog)).toEqual(['SWITCH', 'OLT']);
    expect(CATEGORY_LABELS.SWITCH).toBe('Switch');
  });

  it('scopes manufacturers and models to the selected category', () => {
    expect(catalogManufacturers(catalog, 'SWITCH')).toEqual(['MikroTik', 'Genérico']);
    expect(catalogModels(catalog, 'OLT', 'ZTE').map((entry) => entry.catalogKey)).toEqual(['zte-c320']);
    expect(catalogModels(catalog, 'SWITCH', 'MikroTik').map((entry) => entry.catalogKey)).toEqual([
      'mikrotik-crs328-24p-4s-rm',
    ]);
  });

  it('resolves a catalog key and tolerates empty values', () => {
    expect(findCatalogEntry(catalog, 'zte-c320')?.name).toBe('ZTE C320');
    expect(findCatalogEntry(catalog, null)).toBeNull();
    expect(findCatalogEntry(catalog, 'unknown')).toBeNull();
  });

  it('describes the chassis structurally without inventing data', () => {
    expect(catalogSpec(catalog[0]!)).toBe('1U');
    expect(catalogSpec(catalog[2]!)).toBe('Estrutura não confirmada · complete manualmente');
  });

  it('labels verified, generic and unconfirmed entries differently', () => {
    expect(structureBadge(catalog[0]!)).toEqual({
      label: 'VERIFICADO NO FABRICANTE',
      tone: 'verified',
    });
    expect(structureBadge(catalog[1]!)).toEqual({ label: 'TEMPLATE GENÉRICO', tone: 'generic' });
    expect(structureBadge(catalog[2]!)).toEqual({
      label: 'ESTRUTURA NÃO CONFIRMADA',
      tone: 'open',
    });
  });

  it('summarizes port types and exposes the port state labels', () => {
    const entry = catalogEntry({
      ports: [
        { name: 'Ethernet 1', label: '', order: 1, side: 'DEVICE', type: 'RJ45' },
        { name: 'Ethernet 2', label: '', order: 2, side: 'DEVICE', type: 'RJ45' },
        { name: 'SFP+ 1', label: '', order: 3, side: 'DEVICE', type: 'SFP_PLUS' },
      ],
    });
    expect(portTypeSummary(entry)).toBe('2× RJ45 · 1× SFP+');
    expect(PORT_STATE_LABELS.LLDP_DETECTED).toBe('LLDP');
    expect(PORT_STATE_LABELS.CONNECTED).toBe('CONECTADA');
  });
});
