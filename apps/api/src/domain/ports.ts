import type {
  Device,
  DiscoveredNeighbor,
  HistoryPeriod,
  MetricPoint,
  NetworkInterface,
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
  parseIdentity(output: string): DeviceIdentity;
  parseInterfaces(deviceId: string, output: string): NetworkInterface[];
  parseNeighbors(deviceId: string, output: string): DiscoveredNeighbor[];
}

export interface SnmpVarBind {
  oid: string;
  value: string | number | Uint8Array;
}

export interface SnmpClient {
  walk(host: string, oid: string): Promise<SnmpVarBind[]>;
  get(host: string, oids: string[]): Promise<SnmpVarBind[]>;
}
