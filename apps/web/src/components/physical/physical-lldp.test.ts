import { describe, expect, it } from 'vitest';
import type { PhysicalConnection, PhysicalInventory, PhysicalLldpSuggestion } from '@gmj/shared';
import {
  buildPhysicalLldpGhosts,
  ghostsForRack,
  lldpPairKey,
  pickPrimaryLldpSuggestion,
} from './physical-lldp';
import {
  PHYSICAL_TIMESTAMP,
  physicalAsset,
  physicalConnection,
  physicalInventory,
  physicalPort,
  physicalRack,
} from './physical-fixtures';

function suggestion(partial: Partial<PhysicalLldpSuggestion> = {}): PhysicalLldpSuggestion {
  return {
    adjacencyId: 'lldp-1',
    confidence: 'CONFIRMED',
    state: 'READY',
    local: {
      assetId: 'asset-a',
      assetName: 'SW-A',
      portId: 'port-a',
      portName: 'GE1',
      rackName: 'Rack 01',
      siteName: 'POP Centro',
    },
    remote: {
      assetId: 'asset-b',
      assetName: 'SW-B',
      portId: 'port-b',
      portName: 'GE2',
      rackName: 'Rack 01',
      siteName: 'POP Centro',
    },
    localPortName: 'GE1',
    remoteHostname: 'SW-B',
    remotePortName: 'GE2',
    observedAt: '2026-09-21T11:00:00.000Z',
    reason: 'Ambos os lados estão no inventário físico.',
    ...partial,
  };
}

function makeInventory(options: {
  aConnectionId?: string | null;
  bConnectionId?: string | null;
  connections?: PhysicalConnection[];
  suggestions: PhysicalLldpSuggestion[];
}): PhysicalInventory {
  const assetA = physicalAsset({
    id: 'asset-a',
    name: 'SW-A',
    rackId: 'rack-1',
    ports: [
      physicalPort({
        id: 'port-a',
        assetId: 'asset-a',
        name: 'GE1',
        connectionId: options.aConnectionId ?? null,
        state: options.aConnectionId ? 'CONNECTED' : 'LLDP_DETECTED',
      }),
    ],
  });
  const assetB = physicalAsset({
    id: 'asset-b',
    name: 'SW-B',
    rackId: 'rack-1',
    ports: [
      physicalPort({
        id: 'port-b',
        assetId: 'asset-b',
        name: 'GE2',
        connectionId: options.bConnectionId ?? null,
        state: options.bConnectionId ? 'CONNECTED' : 'LLDP_DETECTED',
      }),
    ],
  });
  return physicalInventory({
    sites: [
      {
        id: 'site-1',
        name: 'POP Centro',
        code: 'CTO',
        description: '',
        racks: [
          physicalRack({ id: 'rack-1', siteId: 'site-1', name: 'Rack 01', assets: [assetA, assetB] }),
        ],
        createdAt: PHYSICAL_TIMESTAMP,
        updatedAt: PHYSICAL_TIMESTAMP,
      },
    ],
    connections: options.connections ?? [],
    lldpSuggestions: options.suggestions,
    lldpObservedAt: '2026-09-21T11:00:00.000Z',
  });
}

describe('ghost LLDP: agrupamento e conflito', () => {
  it('duas adjacencias espelhadas geram um unico ghost e preservam os ids originais', () => {
    const forward = suggestion({ adjacencyId: 'lldp-a' });
    const mirrored = suggestion({
      adjacencyId: 'lldp-b',
      local: forward.remote!,
      remote: forward.local!,
      localPortName: 'GE2',
      remotePortName: 'GE1',
    });

    const ghosts = buildPhysicalLldpGhosts(
      makeInventory({ suggestions: [forward, mirrored] }),
    );

    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]!.key).toBe(lldpPairKey('port-a', 'port-b'));
    expect(ghosts[0]!.adjacencyIds).toEqual(['lldp-a', 'lldp-b']);
    expect(ghosts[0]!.adjacencyId).toBe('lldp-a');
  });

  it('escolhe o melhor candidato: READY antes de PARTIAL, confianca e recencia', () => {
    const partial = suggestion({ adjacencyId: 'lldp-partial', state: 'PARTIAL' });
    const readyOld = suggestion({
      adjacencyId: 'lldp-old',
      observedAt: '2026-09-21T10:00:00.000Z',
    });
    const readyNew = suggestion({
      adjacencyId: 'lldp-new',
      observedAt: '2026-09-21T12:00:00.000Z',
    });
    const probableNew = suggestion({
      adjacencyId: 'lldp-probable',
      confidence: 'PROBABLE',
      observedAt: '2026-09-21T13:00:00.000Z',
    });

    expect(
      pickPrimaryLldpSuggestion([partial, readyOld, readyNew, probableNew]).adjacencyId,
    ).toBe('lldp-new');
    // Empate total cai no desempate estavel por adjacencyId.
    expect(
      pickPrimaryLldpSuggestion([suggestion({ adjacencyId: 'lldp-z' }), suggestion({ adjacencyId: 'lldp-a' })])
        .adjacencyId,
    ).toBe('lldp-a');
  });

  it('cabo confirmado entre as mesmas portas suprime o ghost', () => {
    const connection = physicalConnection({ id: 'connection-1', portAId: 'port-a', portBId: 'port-b' });
    const inventory = makeInventory({
      connections: [connection],
      aConnectionId: 'connection-1',
      bConnectionId: 'connection-1',
      suggestions: [suggestion()],
    });

    const ghosts = buildPhysicalLldpGhosts(inventory);

    expect(ghosts[0]!.conflict).toBe('ALREADY_CONNECTED');
    expect(ghosts[0]!.confirmable).toBe(false);
    expect(ghostsForRack(ghosts, 'rack-1')).toHaveLength(0);
  });

  it('porta conectada a um terceiro endpoint vira conflito e nao pode confirmar', () => {
    const inventory = makeInventory({
      connections: [],
      aConnectionId: 'connection-9',
      suggestions: [suggestion()],
    });

    const ghosts = buildPhysicalLldpGhosts(inventory);

    expect(ghosts[0]!.conflict).toBe('BUSY');
    expect(ghosts[0]!.conflictDetail).toContain('já possui uma conexão física');
    expect(ghosts[0]!.confirmable).toBe(false);
    expect(ghostsForRack(ghosts, 'rack-1')).toHaveLength(0);
  });

  it('PARTIAL nunca inventa endpoint remoto', () => {
    const inventory = makeInventory({
      suggestions: [
        suggestion({ state: 'PARTIAL', remote: null, remoteHostname: 'SW-DESCONHECIDO', remotePortName: 'GE9' }),
      ],
    });

    const ghosts = buildPhysicalLldpGhosts(inventory);

    expect(ghosts[0]!.to).toBeNull();
    expect(ghosts[0]!.confirmable).toBe(false);
    // A ponta local continua desenhável (conhecida).
    expect(ghostsForRack(ghosts, 'rack-1')).toHaveLength(1);
  });

  it('UNRESOLVED nao tem par: permanece visivel sem destino', () => {
    const inventory = makeInventory({
      suggestions: [suggestion({ state: 'UNRESOLVED', remote: null, confidence: 'AMBIGUOUS' })],
    });

    const ghosts = buildPhysicalLldpGhosts(inventory);

    expect(ghosts[0]!.state).toBe('UNRESOLVED');
    expect(ghosts[0]!.to).toBeNull();
    expect(ghosts[0]!.confirmable).toBe(false);
  });
});
