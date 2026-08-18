import type {
  CreateLinkInput,
  Device,
  DiscoveredNeighbor,
  DiscoverySource,
  HistoryPeriod,
  LldpTopologyPreview,
  MetricPoint,
  NetworkInterface,
  NetworkLink,
  NetworkMap,
} from '@gmj/shared';

export interface DeviceIdentity {
  hostname?: string;
  managementAddress?: string;
  chassisId?: string;
  systemDescription?: string;
  vendor?: string;
  model?: string;
}

export interface TopologyDiscoveryAdapter {
  readonly kind: 'LLDP_SNMP' | 'LLDP_SSH';
  discoverDevice(host: string): Promise<DeviceIdentity>;
  discoverNeighbors(device: Device): Promise<DiscoveredNeighbor[]>;
  discoverInterfaces(device: Device): Promise<NetworkInterface[]>;
  getDeviceIdentity(host: string): Promise<DeviceIdentity>;
}

export interface MetricSourceAdapter {
  readonly kind: 'ZABBIX' | 'DEMO';
  getDevices(): Promise<Device[]>;
  getDevice(id: string): Promise<Device | null>;
  getInterfaces(deviceId: string): Promise<NetworkInterface[]>;
  getInterface(id: string): Promise<NetworkInterface | null>;
  getMetrics(interfaceId: string): Promise<Record<string, number | string>>;
  getHistory(interfaceId: string, period: HistoryPeriod): Promise<MetricPoint[]>;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SshClient {
  execute(host: string, commands: string[]): Promise<CommandResult[]>;
}

export interface SshDeviceDriver {
  readonly vendor: string;
  identityCommands(): string[];
  interfaceCommands(): string[];
  neighborCommands(): string[];
  neighborFallbackCommands?(): string[];
  shouldFallbackNeighborCommand?(output: string): boolean;
  neighborInterfaceCommands?(neighborInterface: string): string[];
  parseIdentity(output: string): DeviceIdentity;
  parseInterfaces(deviceId: string, output: string): NetworkInterface[];
  parseNeighbors(deviceId: string, output: string): DiscoveredNeighbor[];
}

export interface SnmpVarBind {
  oid: string;
  value: string | number | Uint8Array;
}

export interface SnmpRequestOptions {
  community?: string;
  version?: 'v2c' | 'v3';
  port?: number;
}

export interface SnmpClient {
  walk(host: string, oid: string, options?: SnmpRequestOptions): Promise<SnmpVarBind[]>;
  get(host: string, oids: string[], options?: SnmpRequestOptions): Promise<SnmpVarBind[]>;
}

export interface LldpSnmpTarget {
  host: string;
  port: number;
  community: string;
}

export interface LldpSnmpTargetProvider {
  resolve(device: Device): Promise<LldpSnmpTarget>;
}

export interface LldpSshSession {
  client: SshClient;
  host: string;
}

export interface LldpSshSessionFactory {
  open(device: Device): Promise<LldpSshSession>;
}

/**
 * Minimal contract the topology apply service needs from a map repository.
 * Both the demo and Prisma implementations satisfy it; return types may be
 * synchronous or asynchronous, so the service awaits without assumptions.
 */
export interface TopologyLinkRepository {
  getMap(mapId: string): NetworkMap | null | Promise<NetworkMap | null>;
  createDiscoveredLink(
    mapId: string,
    input: CreateLinkInput,
    discoverySource: DiscoverySource,
  ): NetworkLink | null | Promise<NetworkLink | null>;
}
export interface TopologyRawDiscoveryResult {
  deviceId: string;
  method: Exclude<DiscoverySource, 'MANUAL'>;
  neighbors: DiscoveredNeighbor[];
}

/**
 * Persists a derived LLDP topology preview so it survives an API restart.
 * The demo/test implementation keeps previews in memory.
 */
export interface TopologyPreviewStore {
  save(
    preview: LldpTopologyPreview,
    rawResults: TopologyRawDiscoveryResult[],
  ): void | Promise<void>;
  load(previewId: string): LldpTopologyPreview | null | Promise<LldpTopologyPreview | null>;
}
