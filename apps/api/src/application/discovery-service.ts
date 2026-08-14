import type { Device, DiscoveredNeighbor, DiscoveryReview } from '@gmj/shared';
import type { TopologyDiscoveryAdapter } from '../domain/ports';

function normalize(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export class DiscoveryService {
  constructor(private readonly adapters: TopologyDiscoveryAdapter[]) {}

  correlate(neighbor: DiscoveredNeighbor, devices: Device[]): DiscoveredNeighbor {
    const identities = [
      neighbor.remoteSystemName,
      neighbor.remoteManagementAddress,
      neighbor.remoteChassisId,
    ]
      .map(normalize)
      .filter(Boolean);
    const matches = devices.filter((device) =>
      [device.hostname, device.name, device.ip]
        .map(normalize)
        .some((value) => identities.includes(value)),
    );
    if (matches.length === 1 && matches[0]) {
      return { ...neighbor, matchStatus: 'MATCHED', matchedDeviceId: matches[0].id };
    }
    if (matches.length > 1) return { ...neighbor, matchStatus: 'AMBIGUOUS' };
    return { ...neighbor, matchStatus: 'UNMATCHED' };
  }

  async discover(device: Device, devices: Device[]): Promise<DiscoveryReview> {
    const access = device as Device & { snmpEnabled?: boolean; sshEnabled?: boolean };
    const method = access.snmpEnabled ? 'SNMP' : access.sshEnabled ? 'SSH' : device.discoveryMethod;
    const ordered = access.snmpEnabled
      ? [
          ...this.adapters.filter((adapter) => adapter.kind === 'LLDP_SNMP'),
          ...(access.sshEnabled
            ? this.adapters.filter((adapter) => adapter.kind === 'LLDP_SSH')
            : []),
        ]
      : access.sshEnabled
        ? this.adapters.filter((adapter) => adapter.kind === 'LLDP_SSH')
        : method === 'SNMP'
          ? this.adapters.filter((adapter) => adapter.kind === 'LLDP_SNMP')
          : method === 'SSH'
            ? this.adapters.filter((adapter) => adapter.kind === 'LLDP_SSH')
            : this.adapters;
    const warnings: string[] = [];
    const discovered = [];

    for (const adapter of ordered) {
      try {
        const neighbors = (await adapter.discoverNeighbors(device)).map((neighbor) =>
          this.correlate(neighbor, devices),
        );
        discovered.push(...neighbors);
        if (neighbors.length === 0) warnings.push(`${adapter.kind}: nenhum vizinho retornado`);
      } catch {
        warnings.push(`${adapter.kind}: falha segura durante a consulta`);
      }
    }
    const unique = discovered.filter(
      (neighbor, index, all) =>
        all.findIndex(
          (candidate) =>
            normalize(candidate.localPort) === normalize(neighbor.localPort) &&
            normalize(candidate.remoteChassisId || candidate.remoteSystemName) ===
              normalize(neighbor.remoteChassisId || neighbor.remoteSystemName),
        ) === index,
    );
    return { deviceId: device.id, method, neighbors: unique, warnings };
  }
}
