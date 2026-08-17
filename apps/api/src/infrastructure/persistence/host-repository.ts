import type {
  ConnectionTestResult,
  CreateHostInput,
  HistoryPeriod,
  HostRecord,
  MetricPoint,
  NetworkInterface,
  UpdateHostInput,
} from '@gmj/shared';

export interface SnmpCredentialSecret {
  community?: string;
  authPassword?: string;
  privacyPassword?: string;
}

export interface SshCredentialSecret {
  password?: string;
}

export interface InterfaceCounterSnapshot {
  interfaceId: string;
  ifIndex: number;
  timestamp: Date;
  inOctets: bigint;
  outOctets: bigint;
  inErrors: bigint;
  outErrors: bigint;
  inDiscards: bigint;
  outDiscards: bigint;
}

export interface InterfaceMetricSampleInput extends InterfaceCounterSnapshot {
  rxBps: number;
  txBps: number;
  inErrorsDelta: bigint;
  outErrorsDelta: bigint;
  inDiscardsDelta: bigint;
  outDiscardsDelta: bigint;
  operStatus: NetworkInterface['operStatus'];
}

export interface DeviceMetricSampleInput {
  timestamp: Date;
  uptimeSeconds?: bigint;
  sysName?: string;
  sysDescr?: string;
  sysObjectId?: string;
  cpuPercent?: number;
}

export interface HostRepository {
  listHosts(): Promise<HostRecord[]>;
  getHost(hostId: string): Promise<HostRecord | null>;
  createHost(input: CreateHostInput, interfaces?: NetworkInterface[]): Promise<HostRecord>;
  updateHost(hostId: string, input: UpdateHostInput): Promise<HostRecord | null>;
  deleteHost(hostId: string): Promise<boolean>;
  updateSourceHealth(hostId: string, result: ConnectionTestResult): Promise<void>;
  getDecryptedSnmpCredentials(hostId: string): Promise<SnmpCredentialSecret | null>;
  getDecryptedSshCredentials(hostId: string): Promise<SshCredentialSecret | null>;
  replaceInterfaces(hostId: string, interfaces: NetworkInterface[]): Promise<NetworkInterface[]>;
  updateInterfaceOptics(hostId: string, interfaces: NetworkInterface[]): Promise<void>;
  getLatestCounterSnapshots(hostId: string): Promise<Map<number, InterfaceCounterSnapshot>>;
  saveSnmpPoll(
    hostId: string,
    deviceSample: DeviceMetricSampleInput,
    samples: InterfaceMetricSampleInput[],
  ): Promise<void>;
  getInterfaceHistory(interfaceId: string, period: HistoryPeriod): Promise<MetricPoint[]>;
  getInterfaceMetrics(interfaceId: string): Promise<Record<string, number | string> | null>;
}
