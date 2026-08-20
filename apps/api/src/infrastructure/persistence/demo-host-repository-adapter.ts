import type {
  CreateHostInput,
  HistoryPeriod,
  HostRecord,
  InterfaceSearchResult,
  MetricPoint,
  NetworkInterface,
  UpdateHostInput,
} from '@gmj/shared';
import type {
  DeviceMetricSampleInput,
  HostRepository,
  InterfaceCounterSnapshot,
  InterfaceMetricSampleInput,
  SnmpCredentialSecret,
  SshCredentialSecret,
} from './host-repository';
import type { DemoMapRepository } from './demo-map-repository';
import type { ConnectionTestResult } from '@gmj/shared';

export class DemoHostRepositoryAdapter implements HostRepository {
  constructor(private readonly repository: DemoMapRepository) {}

  async listHosts(): Promise<HostRecord[]> {
    return this.repository.listHosts();
  }

  async searchInterfaces(query: string, limit: number): Promise<InterfaceSearchResult[]> {
    const normalized = query.trim().toLocaleLowerCase('pt-BR');
    const numeric = /^\d+$/.test(normalized) ? Number(normalized) : null;
    const maps = this.repository.listMaps();
    const mapNames = new Map(maps.map((map) => [map.id, map.name]));

    return this.repository.listHosts().flatMap((host) =>
      host.interfaces.flatMap((networkInterface) => {
        const matches = [
          networkInterface.name,
          networkInterface.alias,
          networkInterface.description,
          host.hostname,
          host.displayName,
          host.managementIp,
        ].some((value) => value.toLocaleLowerCase('pt-BR').includes(normalized))
          || (numeric !== null && networkInterface.ifIndex === numeric);
        if (!matches) return [];
        return [{
          interfaceId: networkInterface.id,
          deviceId: host.id,
          hostname: host.hostname,
          deviceName: host.displayName || host.name,
          interfaceName: networkInterface.name,
          alias: networkInterface.alias,
          description: networkInterface.description,
          ifIndex: networkInterface.ifIndex,
          status: networkInterface.operStatus,
          ip: host.managementIp || null,
          vlan: null,
          maps: host.mapIds.map((mapId) => ({ id: mapId, name: mapNames.get(mapId) ?? mapId })),
        } satisfies InterfaceSearchResult];
      }),
    ).sort((left, right) =>
      left.hostname.localeCompare(right.hostname, 'pt-BR', { numeric: true, sensitivity: 'base' })
      || left.interfaceName.localeCompare(right.interfaceName, 'pt-BR', { numeric: true, sensitivity: 'base' })
      || left.ifIndex - right.ifIndex
    ).slice(0, limit);
  }

  async getHost(hostId: string): Promise<HostRecord | null> {
    return this.repository.getHost(hostId);
  }

  async createHost(input: CreateHostInput, interfaces?: NetworkInterface[]): Promise<HostRecord> {
    return this.repository.createHost(input, interfaces);
  }

  async updateHost(hostId: string, input: UpdateHostInput): Promise<HostRecord | null> {
    return this.repository.updateHost(hostId, input);
  }

  async deleteHost(hostId: string): Promise<boolean> {
    return this.repository.deleteHost(hostId);
  }

  async updateSourceHealth(hostId: string, result: ConnectionTestResult): Promise<void> {
    this.repository.updateSourceHealth(hostId, result);
  }

  async getDecryptedSnmpCredentials(hostId: string): Promise<SnmpCredentialSecret | null> {
    return this.repository.getDecryptedSnmpCredentials(hostId);
  }

  async getDecryptedSshCredentials(hostId: string): Promise<SshCredentialSecret | null> {
    return this.repository.getDecryptedSshCredentials(hostId);
  }

  async replaceInterfaces(_hostId: string, interfaces: NetworkInterface[]): Promise<NetworkInterface[]> {
    return interfaces;
  }

  async updateInterfaceOptics(_hostId: string, _interfaces: NetworkInterface[]): Promise<void> {}

  async getLatestCounterSnapshots(_hostId: string): Promise<Map<number, InterfaceCounterSnapshot>> {
    return new Map();
  }

  async saveSnmpPoll(
    _hostId: string,
    _deviceSample: DeviceMetricSampleInput,
    _samples: InterfaceMetricSampleInput[],
  ): Promise<void> {}

  async getInterfaceHistory(_interfaceId: string, _period: HistoryPeriod): Promise<MetricPoint[]> {
    return [];
  }

  async getInterfaceMetrics(_interfaceId: string): Promise<Record<string, number | string> | null> {
    return null;
  }
}
