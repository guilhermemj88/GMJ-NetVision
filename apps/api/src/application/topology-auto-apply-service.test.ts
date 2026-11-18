import { describe, expect, it } from 'vitest';
import type {
  CreateLinkInput,
  DiscoverySource,
  HostRecord,
  LldpAdjacencyProposal,
  LldpTopologyPreview,
  NetworkLink,
  NetworkMap,
  Position,
} from '@gmj/shared';
import { TopologyAutoApplyService, type AutoApplyRepository } from './topology-auto-apply-service';

function host(id: string, hostname: string): HostRecord {
  return {
    id,
    name: hostname,
    displayName: hostname,
    hostname,
    ip: `10.0.0.${id}`,
    managementIp: `10.0.0.${id}`,
    vendor: 'Huawei',
    model: 'S6730',
    status: 'UP',
    deviceType: 'switch',
    site: '',
    source: 'MANUAL',
    discoveryMethod: 'SNMP',
    useZabbix: false,
    sshEnabled: true,
    ssh: null,
    snmpEnabled: true,
    snmp: null,
    uptimeSeconds: 0,
    pppSupported: false,
    pppOnline: 0,
    pppUpdatedAt: null,
    pppSource: null,
    updatedAt: '',
    interfaces: [],
    origin: 'MANUAL',
    mapIds: [],
    mapCount: 0,
    createdAt: '',
  } as unknown as HostRecord;
}

function adjacency(overrides: Partial<LldpAdjacencyProposal>): LldpAdjacencyProposal {
  return {
    id: 'adj-1',
    sourceHostId: 'a',
    sourceHostname: 'SW-A',
    sourcePort: 'GigabitEthernet1/0/1',
    sourceIfIndex: 5,
    sourceInterfaceId: 'if-a1',
    sourceSpeedBps: 1_000_000_000,
    targetHostId: 'b',
    targetHostname: 'SW-B',
    targetManagementAddress: '10.0.0.b',
    targetChassisId: null,
    targetPort: 'GigabitEthernet1/0/2',
    targetPortDescription: null,
    targetInterfaceId: 'if-b2',
    targetSpeedBps: 10_000_000_000,
    confidence: 'CONFIRMED',
    signals: [],
    reasons: [],
    duplicate: false,
    existingLinkId: null,
    source: 'LLDP_SNMP',
    ...overrides,
  };
}

function preview(adjacencies: LldpAdjacencyProposal[]): LldpTopologyPreview {
  return {
    id: 'preview-1',
    mapId: 'map-1',
    createdAt: new Date().toISOString(),
    stats: {
      hostsQueried: 2,
      hostsFailed: 0,
      adjacencies: adjacencies.length,
      confirmed: adjacencies.filter((item) => item.confidence === 'CONFIRMED').length,
      probable: adjacencies.filter((item) => item.confidence === 'PROBABLE').length,
      ambiguous: 0,
      unknownNeighbor: 0,
    },
    adjacencies,
    warnings: [],
  };
}

class FakeRepository implements AutoApplyRepository {
  nodes: Array<{ id: string; deviceId: string; position: Position }> = [];
  links: Array<{ id: string; input: CreateLinkInput; source: DiscoverySource }> = [];
  touched: string[] = [];
  private sequence = 0;

  constructor(private readonly map: NetworkMap) {}

  async getMap(): Promise<NetworkMap> {
    return this.map;
  }

  async ensureMapNode(_mapId: string, deviceId: string, position: Position): Promise<string> {
    const existing = this.nodes.find((node) => node.deviceId === deviceId);
    if (existing) return existing.id;
    const node = { id: `node-${deviceId}`, deviceId, position };
    this.nodes.push(node);
    return node.id;
  }

  async createDiscoveredLink(
    _mapId: string,
    input: CreateLinkInput,
    source: DiscoverySource,
  ): Promise<NetworkLink> {
    this.sequence += 1;
    const id = `link-${this.sequence}`;
    this.links.push({ id, input, source });
    return { id } as unknown as NetworkLink;
  }

  async touchDiscoveredLink(_mapId: string, linkId: string): Promise<boolean> {
    this.touched.push(linkId);
    return this.map.links.some((link) => link.id === linkId);
  }
}

function emptyMap(links: NetworkMap['links'] = [], nodes: NetworkMap['nodes'] = []): NetworkMap {
  return { id: 'map-1', name: 'Principal', mode: 'HYBRID', nodes, links, devices: [] } as unknown as NetworkMap;
}

const hostsSource = { listHosts: async () => [host('a', 'SW-A'), host('b', 'SW-B')] };

describe('TopologyAutoApplyService', () => {
  it('cria o enlace confirmado e posiciona os dois equipamentos', async () => {
    const repository = new FakeRepository(emptyMap());
    const service = new TopologyAutoApplyService(repository, hostsSource);

    const report = await service.apply('map-1', preview([adjacency({})]));

    expect(report.createdLinks).toEqual(['link-1']);
    expect(report.confirmedLinks).toEqual(['link-1']);
    expect(report.nodesCreated).toHaveLength(2);
    expect(repository.links[0]!.input.sourceNodeId).toBe('node-a');
    expect(repository.links[0]!.input.targetNodeId).toBe('node-b');
    // Capacidade usa o menor lado e a evidencia original e preservada.
    expect(repository.links[0]!.input.capacityBps).toBe(1_000_000_000);
    expect(repository.links[0]!.source).toBe('LLDP_SNMP');
    // Enlace descoberto monitora uma ponta so.
    expect(repository.links[0]!.input.trafficMode).toBe('SINGLE_ENDED');
  });

  it('nao cria enlace PROBABLE por padrao e explica o motivo', async () => {
    const repository = new FakeRepository(emptyMap());
    const service = new TopologyAutoApplyService(repository, hostsSource);

    const report = await service.apply(
      'map-1',
      preview([adjacency({ id: 'adj-p', confidence: 'PROBABLE' })]),
    );

    expect(report.createdLinks).toEqual([]);
    expect(report.skippedDetails).toEqual([
      { adjacencyId: 'adj-p', confidence: 'PROBABLE', reason: 'confianca PROBABLE exige revisao' },
    ]);
  });

  it('cria enlace PROBABLE quando a politica autoriza', async () => {
    const repository = new FakeRepository(emptyMap());
    const service = new TopologyAutoApplyService(repository, hostsSource);

    const report = await service.apply(
      'map-1',
      preview([adjacency({ confidence: 'PROBABLE' })]),
      { probable: true },
    );

    expect(report.createdLinks).toEqual(['link-1']);
    expect(report.confirmedLinks).toEqual([]);
  });

  it('nunca cria enlace ambiguo ou de vizinho desconhecido', async () => {
    const repository = new FakeRepository(emptyMap());
    const service = new TopologyAutoApplyService(repository, hostsSource);

    const report = await service.apply(
      'map-1',
      preview([
        adjacency({ id: 'adj-amb', confidence: 'AMBIGUOUS' }),
        adjacency({ id: 'adj-unk', confidence: 'UNKNOWN_NEIGHBOR', targetHostId: null }),
      ]),
      { probable: true },
    );

    expect(report.createdLinks).toEqual([]);
    expect(report.skippedDetails.map((item) => item.adjacencyId)).toEqual(['adj-amb', 'adj-unk']);
  });

  it('reaproveita no existente sem sobrescrever a posicao manual', async () => {
    const repository = new FakeRepository(
      emptyMap([], [{ id: 'node-a', deviceId: 'a', position: { x: 999, y: 888 }, positionSource: 'MANUAL', locked: true }] as NetworkMap['nodes']),
    );
    const service = new TopologyAutoApplyService(repository, hostsSource);

    const report = await service.apply('map-1', preview([adjacency({})]));

    expect(report.nodesReused).toContain('node-a');
    expect(report.nodesCreated).toEqual(['node-b']);
    const kept = repository.nodes.find((node) => node.deviceId === 'a');
    expect(kept).toBeUndefined();
  });

  it('reconfirma enlace existente em vez de duplicar', async () => {
    const repository = new FakeRepository(
      emptyMap([{ id: 'link-old', sourceInterfaceId: 'if-a1', targetInterfaceId: 'if-b2' }] as NetworkMap['links']),
    );
    const service = new TopologyAutoApplyService(repository, hostsSource);

    const report = await service.apply('map-1', preview([adjacency({ duplicate: true })]));

    expect(report.createdLinks).toEqual([]);
    expect(report.reusedLinks).toEqual(['link-old']);
    expect(repository.touched).toEqual(['link-old']);
  });

  it('respeita o teto de enlaces por execucao', async () => {
    const repository = new FakeRepository(emptyMap());
    const service = new TopologyAutoApplyService(repository, hostsSource);

    const report = await service.apply(
      'map-1',
      preview([adjacency({ id: 'a1' }), adjacency({ id: 'a2' }), adjacency({ id: 'a3' })]),
      { maxLinks: 2 },
    );

    expect(report.createdLinks).toHaveLength(2);
    expect(report.skippedDetails[0]!.reason).toBe('limite de enlaces por execucao atingido');
  });

  it('nao posiciona equipamento novo sobre no existente', async () => {
    const repository = new FakeRepository(
      emptyMap([], [{ id: 'node-x', deviceId: 'x', position: { x: 120, y: 120 }, positionSource: 'AUTO', locked: false }] as NetworkMap['nodes']),
    );
    const service = new TopologyAutoApplyService(repository, hostsSource);

    await service.apply('map-1', preview([adjacency({})]));

    const created = repository.nodes.map((node) => node.position);
    expect(created).not.toContainEqual({ x: 120, y: 120 });
    const unique = new Set(created.map((position) => `${position.x}:${position.y}`));
    expect(unique.size).toBe(created.length);
  });

  it('coloca o equipamento novo ao lado do vizinho ja posicionado', async () => {
    const repository = new FakeRepository(
      emptyMap([], [{ id: 'node-a', deviceId: 'a', position: { x: 500, y: 400 }, positionSource: 'AUTO', locked: false }] as NetworkMap['nodes']),
    );
    const service = new TopologyAutoApplyService(repository, hostsSource);

    await service.apply('map-1', preview([adjacency({})]));

    const placedB = repository.nodes.find((node) => node.deviceId === 'b');
    // Primeiro offset livre a direita do vizinho ja posicionado.
    expect(placedB?.position).toEqual({ x: 760, y: 400 });
  });

  it('redescoberta e idempotente: nao duplica nos nem enlaces', async () => {
    const map = emptyMap();
    const repository = new FakeRepository(map);
    const service = new TopologyAutoApplyService(repository, hostsSource);

    const first = await service.apply('map-1', preview([adjacency({})]));
    expect(first.createdLinks).toHaveLength(1);
    expect(first.nodesCreated).toHaveLength(2);

    // Segunda execucao sobre o mesmo mapa ja refletido no repositorio.
    map.nodes = repository.nodes.map((node) => ({
      id: node.id,
      deviceId: node.deviceId,
      position: node.position,
    })) as unknown as NetworkMap['nodes'];
    map.links = [{ id: 'link-1', sourceInterfaceId: 'if-a1', targetInterfaceId: 'if-b2' }] as NetworkMap['links'];

    const second = await service.apply('map-1', preview([adjacency({ duplicate: true })]));

    expect(second.createdLinks).toEqual([]);
    expect(second.nodesCreated).toEqual([]);
    expect(second.reusedLinks).toEqual(['link-1']);
    expect(repository.nodes).toHaveLength(2);
  });

  it('falha parcial: sem interface em um dos lados nao cria enlace parcial', async () => {
    const repository = new FakeRepository(emptyMap());
    const service = new TopologyAutoApplyService(repository, hostsSource);

    const report = await service.apply(
      'map-1',
      preview([
        adjacency({ id: 'ok' }),
        adjacency({ id: 'meio', targetInterfaceId: null }),
      ]),
    );

    expect(report.createdLinks).toHaveLength(1);
    expect(report.skippedDetails).toEqual([
      {
        adjacencyId: 'meio',
        confidence: 'CONFIRMED',
        reason: 'interface nao resolvida em um dos lados',
      },
    ]);
    // Nenhum enlace foi criado para a adjacencia incompleta.
    expect(repository.links).toHaveLength(1);
  });

  it('marca enlace PROBABLE com estilo MINIMAL e CONFIRMED com o padrao', async () => {
    const repository = new FakeRepository(emptyMap());
    const service = new TopologyAutoApplyService(repository, hostsSource);

    await service.apply(
      'map-1',
      preview([
        adjacency({ id: 'c', confidence: 'CONFIRMED' }),
        adjacency({ id: 'p', confidence: 'PROBABLE', sourceInterfaceId: 'if-a9', targetInterfaceId: 'if-b9' }),
      ]),
      { probable: true },
    );

    expect(repository.links[0]!.input.visualStyle).toBeNull();
    expect(repository.links[1]!.input.visualStyle).toBe('MINIMAL');
  });
});
