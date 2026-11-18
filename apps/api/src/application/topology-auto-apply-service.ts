import type {
  CreateLinkInput,
  DiscoverySource,
  HostRecord,
  LldpAdjacencyProposal,
  LldpApplyResult,
  LldpTopologyPreview,
  MetricSource,
  NetworkLink,
  NetworkMap,
  Position,
} from '@gmj/shared';

interface HostSource {
  listHosts(): Promise<HostRecord[]>;
}

/**
 * Repository surface used by the automatic apply. Kept narrower than
 * `TopologyLinkRepository` on purpose: the review flow must stay untouched, and
 * the demo/test double only needs to implement what is listed here.
 */
export interface AutoApplyRepository {
  getMap(mapId: string): NetworkMap | null | Promise<NetworkMap | null>;
  ensureMapNode(
    mapId: string,
    deviceId: string,
    position: Position,
  ): Promise<string | null> | string | null;
  createDiscoveredLink(
    mapId: string,
    input: CreateLinkInput,
    discoverySource: DiscoverySource,
  ): NetworkLink | null | Promise<NetworkLink | null>;
  /** Reconfirmacao de enlace ja existente: renova o timestamp de descoberta. */
  touchDiscoveredLink(mapId: string, linkId: string): Promise<boolean> | boolean;
}

export interface AutoApplyPolicy {
  /** Cria enlaces confirmados pelos dois lados. Default: true. */
  confirmed: boolean;
  /** Cria enlaces vistos por apenas um lado. Default: false. */
  probable: boolean;
  /** Teto de enlaces criados por execucao (protecao de carga). Default: 500. */
  maxLinks: number;
}

export const DEFAULT_AUTO_APPLY_POLICY: AutoApplyPolicy = {
  confirmed: true,
  probable: false,
  maxLinks: 500,
};

export interface AutoApplySkip {
  adjacencyId: string;
  confidence: LldpAdjacencyProposal['confidence'];
  reason: string;
}

export interface AutoApplyReport extends LldpApplyResult {
  nodesCreated: string[];
  nodesReused: string[];
  confirmedLinks: string[];
  reusedLinks: string[];
  skippedDetails: AutoApplySkip[];
  policy: AutoApplyPolicy;
}

const DEFAULT_CAPACITY_BPS = 1_000_000_000;
const GRID_ORIGIN_X = 120;
const GRID_ORIGIN_Y = 120;
const GRID_COLUMNS = 4;
const GRID_STEP_X = 260;
const GRID_STEP_Y = 180;

function linkKey(
  interfaceA: string | null | undefined,
  interfaceB: string | null | undefined,
): string {
  return [interfaceA, interfaceB].sort().join('|');
}

/**
 * Cria enlaces descobertos sem revisao humana. A decisao por adjacencia usa a
 * mesma evidencia que a revisao assistida ja calculou (CONFIRMED/PROBABLE),
 * portanto nao existe heuristica nova aqui: o que muda e apenas quem confirma.
 */
export class TopologyAutoApplyService {
  constructor(
    private readonly repository: AutoApplyRepository,
    private readonly hostsSource: HostSource,
  ) {}

  async apply(
    mapId: string,
    preview: LldpTopologyPreview,
    policy: Partial<AutoApplyPolicy> = {},
  ): Promise<AutoApplyReport> {
    const effective: AutoApplyPolicy = { ...DEFAULT_AUTO_APPLY_POLICY, ...policy };
    const map = await this.repository.getMap(mapId);
    if (!map) throw new Error('Map not found');
    const hosts = await this.hostsSource.listHosts();

    const existing = new Set(
      map.links.map((link) => linkKey(link.sourceInterfaceId, link.targetInterfaceId)),
    );
    const existingByKey = new Map(
      map.links.map((link) => [linkKey(link.sourceInterfaceId, link.targetInterfaceId), link.id]),
    );
    const nodeByDevice = new Map(
      map.nodes
        .filter((node) => node.deviceId)
        .map((node) => [node.deviceId as string, node.id]),
    );

    const createdLinks: string[] = [];
    const confirmedLinks: string[] = [];
    const reusedLinks: string[] = [];
    const skipped: string[] = [];
    const skippedDetails: AutoApplySkip[] = [];
    const nodesCreated: string[] = [];
    const nodesReused: string[] = [];
    let gridIndex = map.nodes.length;

    const skip = (adjacency: LldpAdjacencyProposal, reason: string): void => {
      skipped.push(adjacency.id);
      skippedDetails.push({ adjacencyId: adjacency.id, confidence: adjacency.confidence, reason });
    };

    for (const adjacency of preview.adjacencies) {
      if (createdLinks.length >= effective.maxLinks) {
        skip(adjacency, 'limite de enlaces por execucao atingido');
        continue;
      }
      if (adjacency.duplicate) {
        // O enlace ja existe: reconfirma-lo renova o "visto por ultimo".
        const key = adjacency.sourceInterfaceId && adjacency.targetInterfaceId
          ? linkKey(adjacency.sourceInterfaceId, adjacency.targetInterfaceId)
          : null;
        const existingId = key ? existingByKey.get(key) : undefined;
        if (existingId && (await this.repository.touchDiscoveredLink(mapId, existingId))) {
          reusedLinks.push(existingId);
        } else {
          skip(adjacency, 'enlace ja existente no mapa');
        }
        continue;
      }
      if (!this.isAutomatic(adjacency, effective)) {
        skip(adjacency, `confianca ${adjacency.confidence} exige revisao`);
        continue;
      }
      if (!adjacency.targetHostId) {
        skip(adjacency, 'vizinho nao identificado no inventario');
        continue;
      }
      if (!adjacency.sourceInterfaceId || !adjacency.targetInterfaceId) {
        skip(adjacency, 'interface nao resolvida em um dos lados');
        continue;
      }

      const pair = [adjacency.sourceHostId, adjacency.targetHostId];
      for (const deviceId of pair) {
        if (nodeByDevice.has(deviceId)) {
          nodesReused.push(nodeByDevice.get(deviceId) as string);
          continue;
        }
        const position = {
          x: GRID_ORIGIN_X + (gridIndex % GRID_COLUMNS) * GRID_STEP_X,
          y: GRID_ORIGIN_Y + Math.floor(gridIndex / GRID_COLUMNS) * GRID_STEP_Y,
        };
        const nodeId = await this.repository.ensureMapNode(mapId, deviceId, position);
        if (nodeId) {
          nodeByDevice.set(deviceId, nodeId);
          nodesCreated.push(nodeId);
          gridIndex += 1;
        }
      }

      const sourceNodeId = nodeByDevice.get(adjacency.sourceHostId) ?? null;
      const targetNodeId = nodeByDevice.get(adjacency.targetHostId) ?? null;
      if (!sourceNodeId || !targetNodeId) {
        skip(adjacency, 'nao foi possivel posicionar os equipamentos no mapa');
        continue;
      }

      const source = hosts.find((host) => host.id === adjacency.sourceHostId);
      const target = hosts.find((host) => host.id === adjacency.targetHostId);
      const capacityBps = this.capacityBps(adjacency);
      const input: CreateLinkInput = {
        sourceDeviceId: adjacency.sourceHostId,
        sourceInterfaceId: adjacency.sourceInterfaceId,
        targetDeviceId: adjacency.targetHostId,
        targetInterfaceId: adjacency.targetInterfaceId,
        sourceNodeId,
        targetNodeId,
        capacityBps,
        autoCapacityBps: capacityBps,
        capacitySource: 'AUTO',
        trafficMode: 'BIDIRECTIONAL',
        customColor: null,
        animationEnabled: null,
        label: '',
        metricSource: this.metricSource(source, target),
        visualStyle: null,
        metricDisplay: null,
      };

      const link = await this.repository.createDiscoveredLink(mapId, input, adjacency.source);
      if (!link) {
        skip(adjacency, 'repositorio recusou a criacao do enlace');
        continue;
      }
      createdLinks.push(link.id);
      if (adjacency.confidence === 'CONFIRMED') confirmedLinks.push(link.id);
      existing.add(linkKey(input.sourceInterfaceId, input.targetInterfaceId));
      existingByKey.set(linkKey(input.sourceInterfaceId, input.targetInterfaceId), link.id);
    }

    return {
      mapId,
      createdLinks,
      skipped,
      nodesCreated: [...new Set(nodesCreated)],
      nodesReused: [...new Set(nodesReused)],
      confirmedLinks,
      reusedLinks: [...new Set(reusedLinks)],
      skippedDetails,
      policy: effective,
    };
  }

  private isAutomatic(adjacency: LldpAdjacencyProposal, policy: AutoApplyPolicy): boolean {
    if (adjacency.confidence === 'CONFIRMED') return policy.confirmed;
    if (adjacency.confidence === 'PROBABLE') return policy.probable;
    return false;
  }

  private capacityBps(adjacency: LldpAdjacencyProposal): number {
    const speeds = [adjacency.sourceSpeedBps, adjacency.targetSpeedBps].filter(
      (value): value is number => typeof value === 'number' && value > 0,
    );
    return speeds.length ? Math.min(...speeds) : DEFAULT_CAPACITY_BPS;
  }

  private metricSource(source?: HostRecord, target?: HostRecord): MetricSource {
    return source?.useZabbix || target?.useZabbix ? 'ZABBIX' : 'DEMO';
  }
}
