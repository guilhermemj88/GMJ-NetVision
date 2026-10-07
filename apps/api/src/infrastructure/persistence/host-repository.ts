import type {
  ConnectionTestResult,
  CreateHostInput,
  HistoryPeriod,
  HostRecord,
  InterfaceSearchResult,
  MetricPoint,
  NetworkInterface,
  OpticalHistoryPoint,
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
  /** FCS/CRC (EtherLike-MIB); ausente/null = nao coletado ou sem suporte. */
  fcsErrors?: bigint | null | undefined;
}

/** Linha crua da janela do motor de alarmes (deltas persistidos por par). */
export interface InterfaceMetricWindowRow {
  interfaceId: string;
  timestamp: Date;
  inErrors: bigint;
  outErrors: bigint;
  inDiscards: bigint;
  outDiscards: bigint;
  inErrorsDelta: bigint;
  outErrorsDelta: bigint;
  inDiscardsDelta: bigint;
  outDiscardsDelta: bigint;
  fcsErrors: bigint | null;
  fcsErrorsDelta: bigint | null;
}

export interface InterfaceMetricSampleInput extends InterfaceCounterSnapshot {
  rxBps: number;
  txBps: number;
  inErrorsDelta: bigint;
  outErrorsDelta: bigint;
  inDiscardsDelta: bigint;
  outDiscardsDelta: bigint;
  /** NULL = metrica nao suportada/nao coletada; 0 = coletada e sem erro. */
  fcsErrors?: bigint | null | undefined;
  fcsErrorsDelta?: bigint | null | undefined;
  operStatus: NetworkInterface['operStatus'];
}

export interface InterfaceStatusUpdate {
  ifIndex: number;
  adminStatus?: NetworkInterface['adminStatus'];
  operStatus?: NetworkInterface['operStatus'];
}

export interface InterfaceStatusTransition {
  deviceId: string;
  interfaceId: string;
  ifIndex: number;
  previousStatus: NetworkInterface['operStatus'];
  newStatus: NetworkInterface['operStatus'];
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
  searchInterfaces(query: string, limit: number): Promise<InterfaceSearchResult[]>;
  getHost(hostId: string): Promise<HostRecord | null>;
  createHost(input: CreateHostInput, interfaces?: NetworkInterface[]): Promise<HostRecord>;
  updateHost(hostId: string, input: UpdateHostInput): Promise<HostRecord | null>;
  deleteHost(hostId: string): Promise<boolean>;
  updateSourceHealth(hostId: string, result: ConnectionTestResult): Promise<void>;
  getDecryptedSnmpCredentials(hostId: string): Promise<SnmpCredentialSecret | null>;
  getDecryptedSshCredentials(hostId: string): Promise<SshCredentialSecret | null>;
  replaceInterfaces(hostId: string, interfaces: NetworkInterface[]): Promise<NetworkInterface[]>;
  updateInterfaceStatuses(
    hostId: string,
    statuses: InterfaceStatusUpdate[],
  ): Promise<InterfaceStatusTransition[]>;
  updateInterfaceOptics(
    hostId: string,
    interfaces: NetworkInterface[],
    collectedAfter?: Date,
  ): Promise<void>;
  getLatestCounterSnapshots(hostId: string): Promise<Map<number, InterfaceCounterSnapshot>>;
  /** Amostras recentes do device (janela do motor de alarmes), ordem crescente. */
  getRecentInterfaceMetricSamples(deviceId: string, since: Date): Promise<InterfaceMetricWindowRow[]>;
  saveSnmpPoll(
    hostId: string,
    deviceSample: DeviceMetricSampleInput,
    samples: InterfaceMetricSampleInput[],
  ): Promise<void>;
  getInterfaceHistory(interfaceId: string, period: HistoryPeriod): Promise<MetricPoint[]>;
  getInterfaceOpticalHistory(
    interfaceId: string,
    period: HistoryPeriod,
  ): Promise<OpticalHistoryPoint[]>;
  getInterfaceMetrics(interfaceId: string): Promise<Record<string, number | string> | null>;
}
