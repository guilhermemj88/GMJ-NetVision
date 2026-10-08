import type {
  CreateHostInput,
  HistoryPeriod,
  HostRecord,
  InterfaceSearchResult,
  MetricPoint,
  NetworkInterface,
  OpticalHistoryPoint,
  UpdateHostInput,
} from '@gmj/shared';
import type {
  DeviceMetricSampleInput,
  HostRepository,
  InterfaceCounterSnapshot,
  InterfaceMetricSampleInput,
  InterfaceMetricWindowRow,
  InterfaceOccurrenceRow,
  InterfaceOpticalThresholdRecord,
  InterfaceOpticalThresholdUpdateInput,
  InterfaceOpticalWindowRow,
  InterfaceStatusTransition,
  InterfaceStatusUpdate,
  SnmpCredentialSecret,
  SshCredentialSecret,
} from './host-repository';
import type { DemoMapRepository } from './demo-map-repository';
import type { ConnectionTestResult } from '@gmj/shared';

export class DemoHostRepositoryAdapter implements HostRepository {
  private readonly opticalThresholds = new Map<string, InterfaceOpticalThresholdRecord>();

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

  async updateInterfaceStatuses(
    hostId: string,
    statuses: InterfaceStatusUpdate[],
  ): Promise<InterfaceStatusTransition[]> {
    return this.repository.updateInterfaceStatuses(hostId, statuses);
  }

  async updateInterfaceOptics(
    _hostId: string,
    _interfaces: NetworkInterface[],
    _collectedAfter?: Date,
  ): Promise<void> {}

  async getInterfaceOpticalThresholds(deviceId: string): Promise<InterfaceOpticalThresholdRecord[]> {
    const host = await this.repository.getHost(deviceId);
    const interfaceIds = new Set((host?.interfaces ?? []).map((networkInterface) => networkInterface.id));
    return [...this.opticalThresholds.values()].filter((record) =>
      interfaceIds.has(record.interfaceId),
    );
  }

  async updateInterfaceOpticalThresholds(
    _deviceId: string,
    entries: InterfaceOpticalThresholdUpdateInput[],
  ): Promise<void> {
    for (const entry of entries) {
      this.opticalThresholds.set(entry.interfaceId, {
        interfaceId: entry.interfaceId,
        thresholds: entry.thresholds,
        source: entry.source,
        updatedAt: entry.updatedAt,
        refreshAfter: entry.refreshAfter,
      });
    }
  }

  async getRecentInterfaceOccurrenceRows(_since: Date): Promise<InterfaceOccurrenceRow[]> {
    return [];
  }

  async getLatestCounterSnapshots(_hostId: string): Promise<Map<number, InterfaceCounterSnapshot>> {
    return new Map();
  }

  async getRecentInterfaceMetricSamples(
    _deviceId: string,
    _since: Date,
  ): Promise<InterfaceMetricWindowRow[]> {
    return [];
  }

  async getRecentInterfaceOpticalSamples(
    _deviceId: string,
    _since: Date,
  ): Promise<InterfaceOpticalWindowRow[]> {
    return [];
  }

  async saveSnmpPoll(
    _hostId: string,
    _deviceSample: DeviceMetricSampleInput,
    _samples: InterfaceMetricSampleInput[],
  ): Promise<void> {}

  async getInterfaceHistory(_interfaceId: string, _period: HistoryPeriod): Promise<MetricPoint[]> {
    return [];
  }

  async getInterfaceOpticalHistory(
    _interfaceId: string,
    _period: HistoryPeriod,
  ): Promise<OpticalHistoryPoint[]> {
    return [];
  }

  async getInterfaceMetrics(_interfaceId: string): Promise<Record<string, number | string> | null> {
    return null;
  }
}
