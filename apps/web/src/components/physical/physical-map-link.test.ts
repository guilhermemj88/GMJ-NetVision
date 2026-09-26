import { describe, expect, it } from 'vitest';
import type { PhysicalInventory, PhysicalLldpSuggestion } from '@gmj/shared';
import { buildPhysicalLldpGhosts, lldpPairKey } from './physical-lldp';
import { applyPhysicalLinkPrecedence } from './physical-link-layer';
import {
  buildPhysicalMapLinkGhosts,
  mapLinkGhostsForRack,
  type PhysicalMapLinkSource,
} from './physical-map-link';
import {
  PHYSICAL_TIMESTAMP,
  physicalAsset,
  physicalConnection,
  physicalInventory,
  physicalPort,
  physicalRack,
} from './physical-fixtures';

/**
 * Fallback topológico: o `NetworkLink` do mapa só vira desenho quando as DUAS
 * pontas (`sourceInterfaceId`/`targetInterfaceId`) apontam para conectores
 * físicos reais. Nada é correlacionado por nome.
 */

function mappedPort(
  id: string,
  assetId: string,
  name: string,
  interfaceName: string,
  ifIndex: number,
) {
  return physicalPort({
    id,
    assetId,
    name,
    label: name,
    type: 'QSFP',
    mappedInterfaceId: `iface-${id}`,
    mappedInterface: {
      id: `iface-${id}`,
      deviceId: `device-${assetId}`,
      name: interfaceName,
      ifIndex,
      alias: null,
      operStatus: 'UP',
    },
  });
}

function inventoryWithMappedPorts(options: {
  connection?: boolean;
} = {}): PhysicalInventory {
  const assets = [
    physicalAsset({
      id: 'asset-a',
      name: 'S6750-MPLS-01',
      deviceId: 'device-asset-a',
      ports: [mappedPort('port-a', 'asset-a', 'QSFP28-5', '100GE1/0/5', 5)],
    }),
    physicalAsset({
      id: 'asset-b',
      name: '6730-MPLS-01',
      deviceId: 'device-asset-b',
      ports: [mappedPort('port-b', 'asset-b', 'QSFP28-6', '100GE0/0/6', 6)],
    }),
  ];
  const connection =
    options.connection
      ? [
          physicalConnection({
            id: 'connection-1',
            portAId: 'port-a',
            portBId: 'port-b',
          }),
        ]
      : [];
  return physicalInventory({
    sites: [
      {
        id: 'site-1',
        name: 'POP Vista Alegre',
        code: 'VTA',
        description: '',
        racks: [
          physicalRack({
            id: 'rack-1',
            siteId: 'site-1',
            name: 'RACK-MPLS',
            assets,
          }),
        ],
        createdAt: PHYSICAL_TIMESTAMP,
        updatedAt: PHYSICAL_TIMESTAMP,
      },
    ],
    connections: connection,
    lldpSuggestions: [],
    lldpObservedAt: PHYSICAL_TIMESTAMP,
  });
}

function mapLink(partial: Partial<PhysicalMapLinkSource> = {}): PhysicalMapLinkSource {
  return {
    id: 'link-1',
    sourceDeviceId: 'device-asset-a',
    sourceInterfaceId: 'iface-port-a',
    targetDeviceId: 'device-asset-b',
    targetInterfaceId: 'iface-port-b',
    label: 'CIR-MPLS-01',
    status: 'UP',
    discoverySource: 'MANUAL',
    ...partial,
  };
}

function readySuggestion(partial: Partial<PhysicalLldpSuggestion> = {}): PhysicalLldpSuggestion {
  return {
    adjacencyId: 'lldp-1',
    confidence: 'CONFIRMED',
    state: 'READY',
    local: {
      assetId: 'asset-a',
      assetName: 'SW-A',
      portId: 'port-a',
      portName: 'QSFP28-5',
      rackName: 'RACK-MPLS',
      siteName: 'POP Vista Alegre',
    },
    remote: {
      assetId: 'asset-b',
      assetName: 'SW-B',
      portId: 'port-b',
      portName: 'QSFP28-6',
      rackName: 'RACK-MPLS',
      siteName: 'POP Vista Alegre',
    },
    localPortName: 'QSFP28-5',
    remoteHostname: 'SW-B',
    remotePortName: 'QSFP28-6',
    observedAt: '2026-09-21T11:00:00.000Z',
    reason: 'Ambos os lados no inventário físico.',
    ...partial,
  };
}

describe('fallback do mapa: correlação por ID', () => {
  it('usa mappedInterfaceId dos dois lados e apresenta o nome CLI', () => {
    const ghosts = buildPhysicalMapLinkGhosts(inventoryWithMappedPorts(), [mapLink()]);

    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]!.key).toBe(lldpPairKey('port-a', 'port-b'));
    expect(ghosts[0]!.linkId).toBe('link-1');
    expect(ghosts[0]!.from.portName).toBe('100GE1/0/5');
    expect(ghosts[0]!.to.portName).toBe('100GE0/0/6');
    expect(ghosts[0]!.external).toBe(false);
  });

  it('ponta sem PhysicalPort correspondente não inventa endpoint nem cabo', () => {
    const ghosts = buildPhysicalMapLinkGhosts(inventoryWithMappedPorts(), [
      mapLink({ targetInterfaceId: 'iface-inexistente' }),
    ]);

    expect(ghosts).toEqual([]);
  });

  it('enlace sem interface não gera desenho físico', () => {
    expect(
      buildPhysicalMapLinkGhosts(inventoryWithMappedPorts(), [
        mapLink({ sourceInterfaceId: null }),
      ]),
    ).toEqual([]);
  });

  it('não correlaciona a interface de outro Device', () => {
    expect(
      buildPhysicalMapLinkGhosts(inventoryWithMappedPorts(), [
        mapLink({ sourceDeviceId: 'device-outro' }),
      ]),
    ).toEqual([]);
  });

  it('direção invertida (A↔B e B↔A) deduplica em um único fallback', () => {
    const ghosts = buildPhysicalMapLinkGhosts(inventoryWithMappedPorts(), [
      mapLink({ id: 'link-b', sourceInterfaceId: 'iface-port-b', targetInterfaceId: 'iface-port-a' }),
      mapLink({ id: 'link-a' }),
    ]);

    expect(ghosts).toHaveLength(1);
    // escolha determinística pelo id do enlace
    expect(ghosts[0]!.linkId).toBe('link-a');
  });

  it('ghost de fallback só aparece no rack de uma das pontas', () => {
    const ghosts = buildPhysicalMapLinkGhosts(inventoryWithMappedPorts(), [mapLink()]);

    expect(mapLinkGhostsForRack(ghosts, 'rack-1')).toHaveLength(1);
    expect(mapLinkGhostsForRack(ghosts, 'rack-9')).toHaveLength(0);
  });
});

describe('precedência cabo > LLDP > mapa', () => {
  it('PhysicalConnection + LLDP + MAPA no mesmo par: só o cabo', () => {
    const inventory = inventoryWithMappedPorts({ connection: true });
    const lldp = buildPhysicalLldpGhosts({ ...inventory, lldpSuggestions: [readySuggestion()] });
    const map = buildPhysicalMapLinkGhosts(inventory, [mapLink()]);
    // o ghost LLDP também é forçado no par do cabo (sem conflito calculado):
    const forced = [{ ...lldp[0]!, key: lldpPairKey('port-a', 'port-b') }];

    const layer = applyPhysicalLinkPrecedence(inventory.connections, forced, map);

    expect(layer.lldp).toEqual([]);
    expect(layer.map).toEqual([]);
  });

  it('LLDP + MAPA no mesmo par sem cabo: só o LLDP', () => {
    const inventory = inventoryWithMappedPorts();
    const lldp = buildPhysicalLldpGhosts({ ...inventory, lldpSuggestions: [readySuggestion()] });
    const map = buildPhysicalMapLinkGhosts(inventory, [mapLink()]);

    const layer = applyPhysicalLinkPrecedence([], lldp, map);

    expect(layer.lldp).toHaveLength(1);
    expect(layer.map).toEqual([]);
  });

  it('somente MAPA: o fallback aparece', () => {
    const inventory = inventoryWithMappedPorts();
    const map = buildPhysicalMapLinkGhosts(inventory, [mapLink()]);

    const layer = applyPhysicalLinkPrecedence([], [], map);

    expect(layer.lldp).toEqual([]);
    expect(layer.map).toHaveLength(1);
  });

  it('direção invertida (LLDP A→B, mapa B→A) continua sendo o mesmo par físico', () => {
    const inventory = inventoryWithMappedPorts();
    const lldp = buildPhysicalLldpGhosts({ ...inventory, lldpSuggestions: [readySuggestion()] });
    const map = buildPhysicalMapLinkGhosts(inventory, [
      mapLink({ id: 'link-2', sourceInterfaceId: 'iface-port-b', targetInterfaceId: 'iface-port-a' }),
    ]);

    const layer = applyPhysicalLinkPrecedence([], lldp, map);

    // a chave canônica ordena as duas pontas: A↔B e B↔A são o mesmo par
    expect(layer.lldp).toHaveLength(1);
    expect(layer.map).toEqual([]);
  });
});
