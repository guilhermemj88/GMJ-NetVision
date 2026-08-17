import type {
  CreateHostInput,
  HistoryPeriod,
  HostRecord,
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
