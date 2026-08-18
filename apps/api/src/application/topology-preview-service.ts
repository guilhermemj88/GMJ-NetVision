import {
  createLocalId,
  type DiscoveredNeighbor,
  type HostRecord,
  type LldpAdjacencyProposal,
  type LldpTopologyPreview,
  type NetworkLink,
} from '@gmj/shared';
import type { TopologyDiscoveryAdapter, TopologyLinkRepository, TopologyPreviewStore, TopologyRawDiscoveryResult } from '../domain/ports';
import { interfaceNameKeys } from '../infrastructure/topology/interface-correlation';
import { LldpCorrelationService, type LldpObservation, type LldpSignalKind } from './lldp-correlation-service';

interface HostSource {
  listHosts(): Promise<HostRecord[]>;
}

const STRONG_SIGNALS: ReadonlySet<LldpSignalKind> = new Set(['MANAGEMENT_IP', 'CHASSIS_ID']);

function hostLabel(host: HostRecord | null | undefined): string {
  if (!host) return '';
  return host.displayName || host.hostname || host.name;
}

function portKey(port: string): string {
  const keys = interfaceNameKeys(port);
  return keys[0] ?? port.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function portsCompatible(a: DiscoveredNeighbor, b: DiscoveredNeighbor): boolean {
  return portKey(a.localPort) === portKey(b.remotePort)
    && portKey(a.remotePort) === portKey(b.localPort);
}

function linkKey(link: Pick<NetworkLink, 'sourceInterfaceId' | 'targetInterfaceId'>): string {
  return [link.sourceInterfaceId, link.targetInterfaceId].sort().join('|');
}

function isUsefulValue(value: string | undefined | null): boolean {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 && !/^unknown\b/i.test(trimmed);
}

/** Merges missing LLDP fields from a secondary source into the primary one. */
function mergeNeighborInfo(base: DiscoveredNeighbor, extra: DiscoveredNeighbor): DiscoveredNeighbor {
  const remoteChassisId = base.remoteChassisId ?? extra.remoteChassisId;
  const remoteManagementAddress = base.remoteManagementAddress ?? extra.remoteManagementAddress;
  const remotePortDescription = base.remotePortDescription ?? extra.remotePortDescription;
  const systemDescription = base.systemDescription ?? extra.systemDescription;
  const localIfIndex = base.localIfIndex ?? extra.localIfIndex;
  const localPortSubtype = base.localPortSubtype ?? extra.localPortSubtype;
  const localMac = base.localMac ?? extra.localMac;
  return {
    ...base,
    remoteSystemName: isUsefulValue(base.remoteSystemName) ? base.remoteSystemName : extra.remoteSystemName,
    ...(remoteChassisId !== undefined ? { remoteChassisId } : {}),
    ...(remoteManagementAddress !== undefined ? { remoteManagementAddress } : {}),
    remotePort: isUsefulValue(base.remotePort) ? base.remotePort : extra.remotePort,
    ...(remotePortDescription !== undefined ? { remotePortDescription } : {}),
    ...(systemDescription !== undefined ? { systemDescription } : {}),
    localPort: isUsefulValue(base.localPort) ? base.localPort : extra.localPort,
    ...(localIfIndex !== undefined ? { localIfIndex } : {}),
    ...(localPortSubtype !== undefined ? { localPortSubtype } : {}),
    ...(localMac !== undefined ? { localMac } : {}),
  };
}

export class TopologyPreviewService {
  constructor(
    private readonly adapters: TopologyDiscoveryAdapter[],
    private readonly hostsSource: HostSource,
    private readonly links: TopologyLinkRepository,
    private readonly store: TopologyPreviewStore,
    private readonly correlation: LldpCorrelationService = new LldpCorrelationService(),
  ) {}

  async discover(
    mapId: string,
    options: { deepValidation?: boolean } = {},
  ): Promise<LldpTopologyPreview> {
    const map = await this.links.getMap(mapId);
    if (!map) throw new Error('Map not found');
    const hosts = await this.hostsSource.listHosts();
    const existingLinkKeys = new Set(map.links.map(linkKey));
    const existingLinkIds = new Map(map.links.map((link) => [linkKey(link), link.id]));
    const deepValidation = options.deepValidation ?? false;

    const observations: LldpObservation[] = [];
    const warnings: string[] = [];
    let hostsFailed = 0;
    const queried = hosts.filter((host) => host.snmpEnabled || host.sshEnabled);

    for (const host of queried) {
      const snmpAdapters = host.snmpEnabled
        ? this.adapters.filter((adapter) => adapter.kind === 'LLDP_SNMP')
        : [];
      const sshAdapters = host.sshEnabled
        ? this.adapters.filter((adapter) => adapter.kind === 'LLDP_SSH')
        : [];

      const snmpNeighbors: DiscoveredNeighbor[] = [];
      let hostProduced = false;

      // SNMP LLDP is the primary source.
      for (const adapter of snmpAdapters) {
        try {
          const result = await adapter.discoverNeighbors(host);
          snmpNeighbors.push(...result);
          hostProduced = hostProduced || result.length > 0;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`${hostLabel(host)}: ${adapter.kind} falhou de forma segura (${message})`);
        }
      }

      const snmpObservations = snmpNeighbors.map((neighbor) => this.correlation.observe(neighbor, hosts));
      for (const observation of snmpObservations) observations.push(observation);

      // SSH fallback: SNMP empty, SNMP incomplete/ambiguous, or explicit deep validation.
      const needsSsh = sshAdapters.length > 0
        && this.shouldFallbackToSsh(snmpNeighbors, snmpObservations, deepValidation);

      if (needsSsh) {
        for (const adapter of sshAdapters) {
          try {
            const result = await adapter.discoverNeighbors(host);
            hostProduced = hostProduced || result.length > 0;
            for (const neighbor of result) {
              observations.push(this.correlation.observe(neighbor, hosts));
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warnings.push(`${hostLabel(host)}: ${adapter.kind} falhou de forma segura (${message})`);
          }
        }
      }

      if (!hostProduced) hostsFailed += 1;
    }

    const adjacencies = this.buildAdjacencies(observations, existingLinkKeys, existingLinkIds, warnings, hosts);
    const stats = {
      hostsQueried: queried.length,
      hostsFailed,
      adjacencies: adjacencies.length,
      confirmed: adjacencies.filter((item) => item.confidence === 'CONFIRMED').length,
      probable: adjacencies.filter((item) => item.confidence === 'PROBABLE').length,
      ambiguous: adjacencies.filter((item) => item.confidence === 'AMBIGUOUS').length,
      unknownNeighbor: adjacencies.filter((item) => item.confidence === 'UNKNOWN_NEIGHBOR').length,
    };

    const preview: LldpTopologyPreview = {
      id: createLocalId('lldp-preview'),
      mapId,
      createdAt: new Date().toISOString(),
      stats,
      adjacencies,
      warnings,
    };
    await this.store.save(preview, this.rawResults(observations));
    return preview;
  }

  private rawResults(observations: LldpObservation[]): TopologyRawDiscoveryResult[] {
    const byKey = new Map<string, TopologyRawDiscoveryResult>();
    for (const observation of observations) {
      const { neighbor } = observation;
      const key = `${neighbor.localDeviceId}|${neighbor.source}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.neighbors.push(neighbor);
      } else {
        byKey.set(key, {
          deviceId: neighbor.localDeviceId,
          method: neighbor.source,
          neighbors: [neighbor],
        });
      }
    }
    return [...byKey.values()];
  }

  private buildAdjacencies(
    observations: LldpObservation[],
    existingLinkKeys: Set<string>,
    existingLinkIds: Map<string, string>,
    warnings: string[],
    hosts: HostRecord[],
  ): LldpAdjacencyProposal[] {
    // Phase 1: merge same-direction observations (SNMP primary, SSH complements).
    const byDirection = new Map<string, LldpObservation[]>();
    for (const observation of observations) {
      const key = this.directionKey(observation);
      byDirection.set(key, [...(byDirection.get(key) ?? []), observation]);
    }
    const merged = [...byDirection.values()].map((items) => this.mergeDirection(items, hosts));

    // Phase 2: group opposite directions by canonical adjacency key.
    const byKey = new Map<string, LldpObservation[]>();
    for (const observation of merged) {
      const key = this.observationKey(observation);
      byKey.set(key, [...(byKey.get(key) ?? []), observation]);
    }

    return [...byKey.values()].map((group) =>
      this.buildAdjacency(group, existingLinkKeys, existingLinkIds, warnings),
    );
  }

  private directionKey(observation: LldpObservation): string {
    return `${observation.neighbor.localDeviceId}|${portKey(observation.neighbor.localPort)}`;
  }

  private mergeDirection(items: LldpObservation[], hosts: HostRecord[]): LldpObservation {
    const primary = items.find((item) => item.neighbor.source === 'LLDP_SNMP') ?? items[0]!;
    const mergedNeighbor = items.reduce(
      (acc, item) => mergeNeighborInfo(acc, item.neighbor),
      { ...primary.neighbor },
    );
    mergedNeighbor.source = primary.neighbor.source;
    mergedNeighbor.id = primary.neighbor.id;
    return this.correlation.observe(mergedNeighbor, hosts);
  }

  private shouldFallbackToSsh(
    snmpNeighbors: DiscoveredNeighbor[],
    snmpObservations: LldpObservation[],
    deepValidation: boolean,
  ): boolean {
    if (snmpNeighbors.length === 0) return true;
    if (deepValidation) return true;
    return snmpObservations.some((observation) => this.isIncomplete(observation));
  }

  private isIncomplete(observation: LldpObservation): boolean {
    const neighbor = observation.neighbor;
    if (!isUsefulValue(neighbor.remoteSystemName)) return true;
    if (!isUsefulValue(neighbor.remotePort)) return true;
    if (!observation.sourceInterface) return true;
    if (!observation.targetHost) return true;
    return false;
  }

  private observationKey(observation: LldpObservation): string {
    const { neighbor, sourceInterface, targetInterface, targetHost } = observation;
    if (sourceInterface && targetInterface) {
      return `if:${[sourceInterface.id, targetInterface.id].sort().join('|')}`;
    }
    const sourceEndpoint = `${neighbor.localDeviceId}|${neighbor.localPort}`;
    const targetEndpoint = `${targetHost?.id ?? `unk:${neighbor.remoteSystemName}`}|${neighbor.remotePort}`;
    return `hp:${[sourceEndpoint, targetEndpoint].sort().join('|')}`;
  }

  private buildAdjacency(
    group: LldpObservation[],
    existingLinkKeys: Set<string>,
    existingLinkIds: Map<string, string>,
    warnings: string[],
  ): LldpAdjacencyProposal {
    const primary = this.pickPrimary(group);
    const observation = primary;
    const neighbor = observation.neighbor;
    const sourceHost = observation.sourceHost;
    const targetHost = observation.targetHost;

    const bySourceHost = new Map<string, LldpObservation[]>();
    for (const item of group) {
      bySourceHost.set(item.neighbor.localDeviceId, [...(bySourceHost.get(item.neighbor.localDeviceId) ?? []), item]);
    }
    const reverse = targetHost ? (bySourceHost.get(targetHost.id) ?? []) : [];
    const reverseConfirmed = reverse.some((item) => item.targetHost?.id === neighbor.localDeviceId);
    const reverseCompatible = reverse.some((item) =>
      item.targetHost?.id === neighbor.localDeviceId && portsCompatible(neighbor, item.neighbor),
    );

    const adjacencyLinkKey = observation.sourceInterface && observation.targetInterface
      ? linkKey({
        sourceInterfaceId: observation.sourceInterface.id,
        targetInterfaceId: observation.targetInterface.id,
      })
      : null;
    const duplicate = Boolean(adjacencyLinkKey && existingLinkKeys.has(adjacencyLinkKey));
    const existingLinkId = adjacencyLinkKey ? (existingLinkIds.get(adjacencyLinkKey) ?? null) : null;

    const reasons: string[] = [];
    reasons.push(`Visto por ${hostLabel(sourceHost) ?? neighbor.localDeviceId} em ${neighbor.localPort}`);
    if (observation.matchedBy) reasons.push(`Correlação por ${observation.matchedBy}`);
    if (reverseConfirmed) reasons.push('Vizinho confirma a adjacência no sentido oposto');
    if (reverseCompatible) reasons.push('Interfaces compatíveis nos dois sentidos');
    if (duplicate) reasons.push('Enlace já existente no mapa');
    if (!observation.sourceInterface) reasons.push('Interface local não resolvida no inventário');
    if (targetHost && !observation.targetInterface) reasons.push('Interface remota não resolvida no inventário');

    if (duplicate && existingLinkId) {
      warnings.push(`${hostLabel(sourceHost)}: enlace LLDP já existente ignorado`);
    }

    return {
      id: createLocalId('lldp-adj'),
      sourceHostId: neighbor.localDeviceId,
      sourceHostname: hostLabel(sourceHost) ?? neighbor.localDeviceId,
      sourcePort: neighbor.localPort,
      sourceIfIndex: neighbor.localIfIndex ?? null,
      sourceInterfaceId: observation.sourceInterface?.id ?? null,
      sourceSpeedBps: observation.sourceInterface?.speedBps ?? null,
      targetHostId: targetHost?.id ?? null,
      targetHostname: hostLabel(targetHost) || neighbor.remoteSystemName,
      targetManagementAddress: neighbor.remoteManagementAddress ?? null,
      targetChassisId: neighbor.remoteChassisId ?? null,
      targetPort: neighbor.remotePort,
      targetPortDescription: neighbor.remotePortDescription ?? null,
      targetInterfaceId: observation.targetInterface?.id ?? null,
      targetSpeedBps: observation.targetInterface?.speedBps ?? null,
      confidence: this.classifyConfidence(observation, reverseConfirmed, reverseCompatible),
      signals: observation.signals,
      reasons,
      duplicate,
      existingLinkId,
      source: neighbor.source,
    };
  }

  private pickPrimary(group: LldpObservation[]): LldpObservation {
    const resolvedSnmp = group.find((item) =>
      item.neighbor.source === 'LLDP_SNMP'
      && item.sourceInterface && item.targetInterface && item.targetHost,
    );
    if (resolvedSnmp) return resolvedSnmp;
    const snmp = group.find((item) => item.neighbor.source === 'LLDP_SNMP');
    if (snmp) return snmp;
    const resolved = group.find((item) =>
      item.sourceInterface && item.targetInterface && item.targetHost,
    );
    return resolved ?? group[0]!;
  }

  private classifyConfidence(
    observation: LldpObservation,
    reverseConfirmed: boolean,
    reverseCompatible: boolean,
  ): LldpAdjacencyProposal['confidence'] {
    if (observation.targetCandidates.length > 1) return 'AMBIGUOUS';
    if (!observation.targetHost) return 'UNKNOWN_NEIGHBOR';
    if (reverseConfirmed && reverseCompatible && observation.sourceInterface && observation.targetInterface) {
      return 'CONFIRMED';
    }
    if (observation.matchedBy && STRONG_SIGNALS.has(observation.matchedBy) && observation.sourceInterface) {
      return 'PROBABLE';
    }
    if (observation.matchedBy === 'SYSTEM_NAME' && observation.sourceInterface) {
      return 'PROBABLE';
    }
    return 'AMBIGUOUS';
  }
}
