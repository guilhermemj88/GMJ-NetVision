import type {
  DiscoveredNeighbor,
  HostRecord,
  LldpCorrelationSignal,
  NetworkInterface,
} from '@gmj/shared';
import { interfaceNameKeys } from '../infrastructure/topology/interface-correlation';

export type LldpSignalKind = LldpCorrelationSignal['kind'];

export interface LldpObservation {
  neighbor: DiscoveredNeighbor;
  sourceHost: HostRecord | null;
  sourceInterface: NetworkInterface | null;
  targetHost: HostRecord | null;
  targetCandidates: HostRecord[];
  targetInterface: NetworkInterface | null;
  matchedBy: LldpSignalKind | null;
  signals: LldpCorrelationSignal[];
}

function normalize(value: string | undefined | null): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeMac(value: string | undefined | null): string {
  return (value ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
}

function uniqueHosts(hosts: HostRecord[]): HostRecord[] {
  return [...new Map(hosts.map((host) => [host.id, host])).values()];
}

function matchInterfaceByKeys(host: HostRecord, keys: Set<string>): NetworkInterface | null {
  const candidates = host.interfaces.filter((networkInterface) =>
    [...interfaceNameKeys(networkInterface.name), ...interfaceNameKeys(networkInterface.description)]
      .some((key) => keys.has(key)),
  );
  return candidates.length === 1 ? candidates[0]! : null;
}

function matchInterfaceByAlias(host: HostRecord, keys: Set<string>): NetworkInterface | null {
  const candidates = host.interfaces.filter((networkInterface) =>
    interfaceNameKeys(networkInterface.alias).some((key) => keys.has(key)),
  );
  return candidates.length === 1 ? candidates[0]! : null;
}

function matchInterfaceByMac(host: HostRecord, mac: string): NetworkInterface | null {
  if (!mac) return null;
  const candidates = host.interfaces.filter(
    (networkInterface) => normalizeMac(networkInterface.mac) === mac,
  );
  return candidates.length === 1 ? candidates[0]! : null;
}

// LLDP-MIB LldpPortIdSubtype values.
const PORT_ID_SUBTYPE = {
  INTERFACE_ALIAS: 1,
  PORT_COMPONENT: 2,
  MAC_ADDRESS: 3,
  NETWORK_ADDRESS: 4,
  INTERFACE_NAME: 5,
  AGENT_CIRCUIT_ID: 6,
  LOCAL: 7,
} as const;

export class LldpCorrelationService {
  /**
   * Resolves the local interface of an observation against the host inventory.
   * The strategy depends on lldpLocPortIdSubtype; an ifIndex is never invented
   * from the LLDP table index.
   */
  resolveLocalInterface(host: HostRecord, neighbor: DiscoveredNeighbor): NetworkInterface | null {
    if (neighbor.localIfIndex !== undefined && Number.isInteger(neighbor.localIfIndex) && neighbor.localIfIndex > 0) {
      const byIndex = host.interfaces.filter((networkInterface) => networkInterface.ifIndex === neighbor.localIfIndex);
      if (byIndex.length === 1) return byIndex[0]!;
    }

    const keys = new Set(interfaceNameKeys(neighbor.localPort));
    switch (neighbor.localPortSubtype) {
      case PORT_ID_SUBTYPE.INTERFACE_ALIAS:
        return matchInterfaceByAlias(host, keys) ?? matchInterfaceByKeys(host, keys);
      case PORT_ID_SUBTYPE.MAC_ADDRESS: {
        const mac = normalizeMac(neighbor.localMac ?? neighbor.localPort);
        return matchInterfaceByMac(host, mac);
      }
      case PORT_ID_SUBTYPE.PORT_COMPONENT:
        // ENTITY-MIB / entPhysicalAlias mapping is not available yet; fall back
        // conservatively to ifName/ifDescr.
        return matchInterfaceByKeys(host, keys);
      case PORT_ID_SUBTYPE.INTERFACE_NAME:
      default:
        // interfaceName(5), local(7) and unknown subtypes: correlate
        // lldpLocPortId with ifName, with ifDescr as a conservative fallback.
        return matchInterfaceByKeys(host, keys);
    }
  }

  /** Resolves the remote interface on an already matched remote host. */
  resolveRemoteInterface(host: HostRecord, port: string, portDescription?: string): NetworkInterface | null {
    const keys = new Set(interfaceNameKeys(port));
    const byName = keys.size ? matchInterfaceByKeys(host, keys) : null;
    if (byName) return byName;
    if (portDescription) {
      const descriptionKeys = new Set(interfaceNameKeys(portDescription));
      return matchInterfaceByKeys(host, descriptionKeys) ?? matchInterfaceByAlias(host, descriptionKeys);
    }
    return null;
  }

  /**
   * Correlates one neighbor observation against the full inventory.
   * Only strong signals (management IP, chassis ID, sysName) may identify the
   * remote host. Remote port and description are used later, after the host is
   * identified, to resolve the remote interface.
   */
  observe(neighbor: DiscoveredNeighbor, hosts: HostRecord[]): LldpObservation {
    const sourceHost = hosts.find((host) => host.id === neighbor.localDeviceId) ?? null;
    const sourceInterface = sourceHost
      ? this.resolveLocalInterface(sourceHost, neighbor)
      : null;

    const signals: LldpCorrelationSignal[] = [];
    let targetHost: HostRecord | null = null;
    let targetCandidates: HostRecord[] = [];
    let matchedBy: LldpSignalKind | null = null;

    const managementAddress = neighbor.remoteManagementAddress?.trim();
    if (managementAddress) {
      signals.push({ kind: 'MANAGEMENT_IP', value: managementAddress });
      const candidates = uniqueHosts(hosts.filter((host) =>
        normalize(host.managementIp) === normalize(managementAddress)
        || normalize(host.ip) === normalize(managementAddress)
        || normalize(host.zabbix?.ip) === normalize(managementAddress),
      ));
      if (candidates.length) {
        targetCandidates = candidates;
        matchedBy = 'MANAGEMENT_IP';
      }
    }

    if (!matchedBy && neighbor.remoteChassisId) {
      signals.push({ kind: 'CHASSIS_ID', value: neighbor.remoteChassisId });
      const chassis = normalize(neighbor.remoteChassisId);
      const mac = normalizeMac(neighbor.remoteChassisId);
      const candidates = uniqueHosts(hosts.filter((host) =>
        normalize(host.hostname) === chassis
        || normalize(host.name) === chassis
        || (mac && host.interfaces.some((networkInterface) => normalizeMac(networkInterface.mac) === mac)),
      ));
      if (candidates.length) {
        targetCandidates = candidates;
        matchedBy = 'CHASSIS_ID';
      }
    }

    if (!matchedBy && neighbor.remoteSystemName) {
      signals.push({ kind: 'SYSTEM_NAME', value: neighbor.remoteSystemName });
      const systemName = normalize(neighbor.remoteSystemName);
      const candidates = uniqueHosts(hosts.filter((host) =>
        [host.hostname, host.name, host.displayName].some((value) => normalize(value) === systemName),
      ));
      if (candidates.length) {
        targetCandidates = candidates;
        matchedBy = 'SYSTEM_NAME';
      }
    }

    if (targetCandidates.length === 1) targetHost = targetCandidates[0]!;
    const targetInterface = targetHost
      ? this.resolveRemoteInterface(targetHost, neighbor.remotePort, neighbor.remotePortDescription)
      : null;

    return {
      neighbor,
      sourceHost,
      sourceInterface,
      targetHost,
      targetCandidates,
      targetInterface,
      matchedBy,
      signals,
    };
  }
}
