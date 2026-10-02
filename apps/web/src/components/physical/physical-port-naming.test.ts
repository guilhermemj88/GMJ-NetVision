import { describe, expect, it } from 'vitest';
import type { PhysicalAsset, PhysicalCatalogEntry, PhysicalInventory, PhysicalPort } from '@gmj/shared';
import { createPhysicalPortNamingResolver } from './physical-port-naming';
import { physicalAsset, physicalPort, physicalTemplate } from './physical-fixtures';

/**
 * Regra global de apresentação da aba Físico:
 *
 * 1. `mappedInterface.name` (nome lógico/CLI);
 * 2. nome lógico declarado no catálogo;
 * 3. `PhysicalPort.name` (último fallback, nunca apagado).
 *
 * O nome físico continua existindo como detalhe (`Porta física: 100GE-2`).
 */

function mappedInterface(name: string, ifIndex: number): PhysicalPort['mappedInterface'] {
  return {
    id: `if-${name}`,
    deviceId: 'device-1',
    name,
    ifIndex,
    alias: null,
    operStatus: 'UP',
  };
}

function assetWithPorts(id: string, name: string, ports: PhysicalPort[]): PhysicalAsset {
  return physicalAsset({ id, name, ports });
}

function inventoryWith(assets: PhysicalAsset[]): PhysicalInventory {
  return {
    sites: [
      {
        id: 'site-vta',
        name: 'Vista Alegre',
        code: 'VTA',
        description: '',
        racks: [
          {
            id: 'rack-1',
            siteId: 'site-vta',
            name: 'RACK 01',
            units: 42,
            description: '',
            assets,
            createdAt: '2026-10-02T12:00:00.000Z',
            updatedAt: '2026-10-02T12:00:00.000Z',
          },
        ],
        createdAt: '2026-10-02T12:00:00.000Z',
        updatedAt: '2026-10-02T12:00:00.000Z',
      },
    ],
    templates: [],
    connections: [],
    lldpSuggestions: [],
    lldpObservedAt: null,
  };
}

const F1A_PORT = physicalPort({
  id: 'port-f1a-49',
  assetId: 'asset-f1a',
  name: '100GE-2',
  label: '',
  type: 'QSFP',
  mappedInterfaceId: 'if-100GE0/1/49',
  mappedInterface: mappedInterface('100GE0/1/49', 49),
});

const S6750_PORT = physicalPort({
  id: 'port-s6750-1',
  assetId: 'asset-s6750',
  name: 'QSFP28-1',
  label: 'QSFP28-1',
  type: 'QSFP',
  mappedInterfaceId: 'if-100GE1/0/1',
  mappedInterface: mappedInterface('100GE1/0/1', 1),
});

const F1A = assetWithPorts('asset-f1a', 'BHE-VTA-F1A-BGP', [F1A_PORT]);
const S6750 = assetWithPorts('asset-s6750', 'BHE-VTA-S6750-MPLS-01', [S6750_PORT]);

describe('resolvedor único de identidade da porta física', () => {
  it('F1A: 100GE0/1/49 é o nome principal e 100GE-2 fica como detalhe', () => {
    const naming = createPhysicalPortNamingResolver(inventoryWith([F1A, S6750]));
    const view = naming.byPortId('port-f1a-49');
    expect(view?.displayName).toBe('100GE0/1/49');
    expect(view?.interfaceName).toBe('100GE0/1/49');
    expect(view?.panelLabel).toBe('100GE-2');
  });

  it('S6750: 100GE1/0/1 é o nome principal e QSFP28-1 fica como detalhe', () => {
    const naming = createPhysicalPortNamingResolver(inventoryWith([F1A, S6750]));
    const view = naming.byPortId('port-s6750-1');
    expect(view?.displayName).toBe('100GE1/0/1');
    expect(view?.interfaceName).toBe('100GE1/0/1');
    expect(view?.panelLabel).toBe('QSFP28-1');
  });

  it('nunca apresenta o nome físico como identidade quando há interface mapeada', () => {
    const naming = createPhysicalPortNamingResolver(inventoryWith([F1A, S6750]));
    expect(naming.displayName('port-f1a-49', 'fallback')).toBe('100GE0/1/49');
    expect(naming.displayName('port-s6750-1', 'fallback')).toBe('100GE1/0/1');
  });

  it('usa o nome lógico do catálogo quando não há interface mapeada', () => {
    const port = physicalPort({
      id: 'port-cat-12',
      assetId: 'asset-cat',
      name: 'SFP28-12',
      label: 'SFP28-12',
      type: 'SFP',
    });
    const asset = physicalAsset({
      id: 'asset-cat',
      name: 'SW-CAT',
      templateId: 'template-cat',
      template: physicalTemplate({
        id: 'template-cat',
        catalogKey: 'catalog-cat',
        name: 'Catálogo',
        category: 'SWITCH',
        manufacturer: 'Genérico',
        kind: 'NETWORK',
      }),
      ports: [port],
    });
    const catalog: PhysicalCatalogEntry[] = [
      {
        catalogKey: 'catalog-cat',
        name: 'Catálogo',
        category: 'SWITCH',
        manufacturer: 'Genérico',
        family: '',
        model: '',
        kind: 'NETWORK',
        heightU: 1,
        vendorVerified: false,
        structureConfirmed: true,
        description: '',
        referenceUrl: null,
        portSummary: '',
        ports: [
          {
            name: 'SFP28-12',
            label: 'SFP28-12',
            order: 12,
            side: 'DEVICE',
            type: 'SFP',
            connector: 'SFP28',
            interfaceName: '25GE1/0/12',
            panelNumber: 12,
          },
        ],
        slots: [],
        modules: [],
      },
    ];

    const naming = createPhysicalPortNamingResolver(inventoryWith([asset]), catalog);
    const view = naming.byPortId('port-cat-12');
    expect(view?.displayName).toBe('25GE1/0/12');
    expect(view?.panelLabel).toBe('SFP28-12');
  });

  it('cai para PhysicalPort.name quando não há interface mapeada nem catálogo', () => {
    const port = physicalPort({
      id: 'port-generic-7',
      assetId: 'asset-generic',
      name: 'port7',
      label: 'port7',
    });
    const asset = assetWithPorts('asset-generic', 'GEN-01', [port]);
    const naming = createPhysicalPortNamingResolver(inventoryWith([asset]));
    const view = naming.byPortId('port-generic-7');
    expect(view?.displayName).toBe('port7');
    expect(view?.interfaceName).toBeNull();
    // sem interface, o rótulo físico é o próprio nome: nada é repetido como detalhe
    expect(view?.panelLabel).toBeNull();
  });

  it('displayName mantém o fallback textual quando a porta não existe no inventário', () => {
    const naming = createPhysicalPortNamingResolver(inventoryWith([F1A, S6750]));
    expect(naming.displayName('porta-inexistente', '100GE-2')).toBe('100GE-2');
    expect(naming.byPortId('porta-inexistente')).toBeNull();
  });
});
