import type {
  HostRecord,
  MapSettings,
  NetworkInterface,
  NetworkLink,
  NetworkMap,
  SourceHealth,
} from '@gmj/shared';

export function makeInterface(
  partial: Partial<NetworkInterface> & { id: string; deviceId: string; name: string; ifIndex: number },
): NetworkInterface {
  return {
    alias: '',
    description: '',
    mac: '',
    mtu: 1500,
    speedBps: 1_000_000_000,
    adminStatus: 'UP',
    operStatus: 'UP',
    rxBps: 0,
    txBps: 0,
    rxUtilization: 0,
    txUtilization: 0,
    rxErrors: 0,
    txErrors: 0,
    rxDiscards: 0,
    txDiscards: 0,
    dataSources: ['SNMP'],
    ...partial,
  };
}

function health(state: SourceHealth['state'] = 'DISABLED'): SourceHealth {
  return { state, lastSuccess: null, lastFailure: null, lastErrorSafe: null };
}

export function makeHost(
  partial: Partial<HostRecord> & { id: string; hostname: string },
): HostRecord {
  const hostname = partial.hostname;
  return {
    name: hostname,
    ip: '',
    vendor: '',
    model: '',
    status: 'UP',
    deviceType: 'switch',
    site: '',
    source: 'LLDP_SNMP',
    discoveryMethod: 'AUTO',
    uptimeSeconds: 0,
    updatedAt: '',
    interfaces: [],
    displayName: hostname,
    managementIp: '',
    description: '',
    notes: '',
    origin: 'MANUAL',
    useZabbix: false,
    zabbix: null,
    sshEnabled: false,
    ssh: null,
    snmpEnabled: true,
    snmp: {
      version: 'SNMP_V2C',
      host: '',
      port: 161,
      username: '',
      securityLevel: 'NO_AUTH_NO_PRIV',
      authProtocol: null,
      privacyProtocol: null,
      credentialConfigured: false,
    },
    sourceHealth: { ZABBIX: health(), SSH: health(), SNMP: health() },
    lastPollingAt: null,
    lastDiscoveryAt: null,
    mapIds: [],
    mapCount: 0,
    createdAt: '',
    ...partial,
  };
}

export function makeLink(
  partial: Partial<NetworkLink> & {
    id: string;
    mapId: string;
    sourceDeviceId: string;
    sourceInterfaceId: string;
    targetDeviceId: string;
    targetInterfaceId: string;
  },
): NetworkLink {
  return {
    capacityBps: 1_000_000_000,
    autoCapacityBps: 1_000_000_000,
    capacitySource: 'AUTO',
    label: '',
    status: 'UP',
    discoverySource: 'MANUAL',
    metricSource: 'DEMO',
    visualStyle: null,
    metricDisplay: null,
    directions: {
      A_TO_B: { bps: 0, utilization: 0 },
      B_TO_A: { bps: 0, utilization: 0 },
    },
    rxBps: 0,
    txBps: 0,
    rxUtilization: 0,
    txUtilization: 0,
    rxErrors: 0,
    txErrors: 0,
    rxDiscards: 0,
    txDiscards: 0,
    createdAt: '',
    updatedAt: '',
    ...partial,
  };
}

export function makeMap(
  partial: Partial<NetworkMap> & { id: string; links?: NetworkLink[]; devices?: HostRecord[] },
): NetworkMap {
  const settings: MapSettings = {
    nodeDisplayMode: 'ICON_2D',
    linkDisplayStyle: 'HYBRID',
    linkMetricDisplay: 'BOTH',
    filters: {
      showTraffic: true,
      showUtilization: true,
      showLabels: true,
      showOffline: true,
      showInterfaces: false,
    },
    viewport: { x: 0, y: 0, zoom: 1 },
    nodeScale: 100,
    linkScale: 100,
    labelScale: 100,
  };
  return {
    name: partial.id,
    description: '',
    mode: 'HYBRID',
    isDefault: false,
    settings,
    nodes: [],
    devices: [],
    links: [],
    createdAt: '',
    updatedAt: '',
    ...partial,
  };
}
