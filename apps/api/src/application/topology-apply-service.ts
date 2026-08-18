import type {
  CreateLinkInput,
  HostRecord,
  LldpAdjacencyProposal,
  LldpApplyResult,
  LldpApplySelection,
  LldpTopologyPreview,
  MetricSource,
} from '@gmj/shared';
import type { TopologyLinkRepository } from '../domain/ports';

interface HostSource {
  listHosts(): Promise<HostRecord[]>;
}

function linkKey(interfaceA: string, interfaceB: string): string {
  return [interfaceA, interfaceB].sort().join('|');
}

const DEFAULT_CAPACITY_BPS = 1_000_000_000;

export class TopologyApplyService {
  constructor(
    private readonly links: TopologyLinkRepository,
    private readonly hostsSource: HostSource,
  ) {}

  async apply(
    mapId: string,
    preview: LldpTopologyPreview,
    selections: LldpApplySelection[],
  ): Promise<LldpApplyResult> {
    const map = await this.links.getMap(mapId);
    if (!map) throw new Error('Map not found');
    const hosts = await this.hostsSource.listHosts();
    const existing = new Set(
      map.links.map((link) => linkKey(link.sourceInterfaceId, link.targetInterfaceId)),
    );

    const createdLinks: string[] = [];
    const skipped: string[] = [];
    const byId = new Map(preview.adjacencies.map((adjacency) => [adjacency.id, adjacency]));

    for (const selection of selections) {
      const adjacency = byId.get(selection.adjacencyId);
      if (!adjacency) continue;
      if (selection.action === 'IGNORE') {
        skipped.push(adjacency.id);
        continue;
      }
      if (!this.canApply(adjacency, existing)) {
        skipped.push(adjacency.id);
        continue;
      }

      const source = hosts.find((host) => host.id === adjacency.sourceHostId);
      const target = hosts.find((host) => host.id === adjacency.targetHostId);
      const capacityBps = this.capacityBps(adjacency);
      const input: CreateLinkInput = {
        sourceDeviceId: adjacency.sourceHostId,
        sourceInterfaceId: adjacency.sourceInterfaceId!,
        targetDeviceId: adjacency.targetHostId!,
        targetInterfaceId: adjacency.targetInterfaceId!,
        capacityBps,
        autoCapacityBps: capacityBps,
        capacitySource: 'AUTO',
        label: '',
        metricSource: this.metricSource(source, target),
        visualStyle: null,
        metricDisplay: null,
      };

      const link = await this.links.createDiscoveredLink(mapId, input, adjacency.source);
      if (link) {
        createdLinks.push(link.id);
        existing.add(linkKey(input.sourceInterfaceId, input.targetInterfaceId));
      } else {
        skipped.push(adjacency.id);
      }
    }

    return { mapId, createdLinks, skipped };
  }

  private canApply(adjacency: LldpAdjacencyProposal, existing: Set<string>): boolean {
    if (adjacency.duplicate) return false;
    if (adjacency.confidence === 'AMBIGUOUS' || adjacency.confidence === 'UNKNOWN_NEIGHBOR') return false;
    if (!adjacency.targetHostId || !adjacency.sourceInterfaceId || !adjacency.targetInterfaceId) return false;
    return !existing.has(linkKey(adjacency.sourceInterfaceId, adjacency.targetInterfaceId));
  }

  private capacityBps(adjacency: LldpAdjacencyProposal): number {
    const speeds = [adjacency.sourceSpeedBps, adjacency.targetSpeedBps]
      .filter((value): value is number => typeof value === 'number' && value > 0);
    return speeds.length ? Math.min(...speeds) : DEFAULT_CAPACITY_BPS;
  }

  private metricSource(source?: HostRecord, target?: HostRecord): MetricSource {
    return source?.useZabbix || target?.useZabbix ? 'ZABBIX' : 'DEMO';
  }
}
