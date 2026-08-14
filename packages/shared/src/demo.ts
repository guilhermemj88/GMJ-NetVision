import type {
  Device,
  DeviceStatus,
  DeviceType,
  MetricPoint,
  NetworkInterface,
  NetworkLink,
  NetworkMap,
  Position,
} from './types';

const now = new Date('2026-08-14T15:32:00.000Z').toISOString();

function makeInterfaces(
  deviceId: string,
  count: number,
  status: DeviceStatus,
  baseGbps: number,
): NetworkInterface[] {
  return Array.from({ length: count }, (_, index) => {
    const speedBps = index < 2 ? 100_000_000_000 : 10_000_000_000;
    const utilization = status === 'DOWN' ? 0 : Math.max(2, baseGbps * 2.6 - index * 4.1);
    return {
      id: `${deviceId}-if-${index + 1}`,
      deviceId,
      name: index < 2 ? `100GE1/0/${index + 1}` : `10GE1/0/${index + 1}`,
      alias: index === 0 ? 'UPLINK-PRIMARY' : index === 1 ? 'UPLINK-BACKUP' : `ACCESS-${index - 1}`,
      description: index < 2 ? 'Backbone optical link' : 'Distribution interface',
      ifIndex: 1000 + index,
      mac: `A0:3D:6F:${deviceId.slice(-2).padStart(2, '0')}:${String(index).padStart(2, '0')}:01`,
      mtu: index < 2 ? 9216 : 1500,
      speedBps,
      adminStatus: status === 'DOWN' ? 'DOWN' : 'UP',
      operStatus: status === 'DOWN' ? 'DOWN' : index === count - 1 && count > 3 ? 'WARNING' : 'UP',
      rxBps: (utilization / 100) * speedBps,
      txBps: (Math.max(1, utilization - 6.2) / 100) * speedBps,
      rxUtilization: utilization,
      txUtilization: Math.max(1, utilization - 6.2),
      rxErrors: index === count - 1 ? 18 : index,
      txErrors: index === count - 1 ? 4 : 0,
      rxDiscards: index === count - 1 ? 9 : 0,
      txDiscards: index === count - 1 ? 2 : 0,
    };
  });
}

function device(
  id: string,
  name: string,
  type: DeviceType,
  ip: string,
  vendor: string,
  model: string,
  site: string,
  status: DeviceStatus,
  load: number,
): Device {
  return {
    id,
    name,
    hostname: name.toLowerCase(),
    ip,
    vendor,
    model,
    status,
    deviceType: type,
    site,
    source: 'DEMO',
    discoveryMethod: 'AUTO',
    uptimeSeconds: 11_286_400 + load * 10_000,
    ...(status === 'DOWN' ? {} : { cpuPercent: 31 + load, memoryPercent: 48 + load * 0.7 }),
    updatedAt: now,
    interfaces: makeInterfaces(id, type === 'core' || type === 'aggregation' ? 6 : 4, status, load),
  };
}

export const demoDevices: Device[] = [
  device(
    'internet',
    'INTERNET',
    'internet',
    '0.0.0.0',
    'Transit',
    'Global IP',
    'External',
    'UP',
    11,
  ),
  device('ix-bh', 'IX-BH', 'ix', '172.16.0.1', 'IX.br', 'PIX Fabric', 'Belo Horizonte', 'UP', 14),
  device('edge-01', 'BGP-EDGE-01', 'edge', '10.0.0.1', 'Juniper', 'MX204', 'DC Savassi', 'UP', 19),
  device(
    'fw-01',
    'FW-BORDA-01',
    'firewall',
    '10.0.0.5',
    'Fortinet',
    'FG-1800F',
    'DC Savassi',
    'WARNING',
    22,
  ),
  device(
    'core-01',
    'CORE-BH-01',
    'core',
    '10.10.0.1',
    'Huawei',
    'NE8000 M8',
    'DC Savassi',
    'UP',
    24,
  ),
  device(
    'core-02',
    'CORE-BH-02',
    'core',
    '10.10.0.2',
    'Huawei',
    'NE8000 M8',
    'DC Contagem',
    'UP',
    20,
  ),
  device(
    'agg-centro',
    'AGG-CENTRO-01',
    'aggregation',
    '10.20.0.1',
    'Huawei',
    'NE40E-X8A',
    'Centro',
    'UP',
    16,
  ),
  device(
    'agg-norte',
    'AGG-NORTE-01',
    'aggregation',
    '10.20.0.2',
    'Cisco',
    'NCS 540',
    'Venda Nova',
    'WARNING',
    12,
  ),
  device(
    'agg-oeste',
    'AGG-OESTE-01',
    'aggregation',
    '10.20.0.3',
    'Cisco',
    'NCS 540',
    'Contagem',
    'UP',
    10,
  ),
  device(
    'olt-centro',
    'OLT-CENTRO-01',
    'olt',
    '10.30.0.1',
    'Huawei',
    'MA5800-X17',
    'Centro',
    'UP',
    8,
  ),
  device(
    'olt-norte',
    'OLT-NORTE-01',
    'olt',
    '10.30.0.2',
    'Nokia',
    'ISAM FX-16',
    'Venda Nova',
    'DOWN',
    0,
  ),
  device(
    'olt-oeste',
    'OLT-OESTE-01',
    'olt',
    '10.30.0.3',
    'Huawei',
    'MA5800-X7',
    'Contagem',
    'UP',
    7,
  ),
  device(
    'customers',
    'CLIENTES',
    'customers',
    '192.168.100.1',
    'GMJ',
    'Subscriber Cloud',
    'Metropolitana',
    'UP',
    6,
  ),
];

const positions: Record<string, Position> = {
  internet: { x: 40, y: 245 },
  'ix-bh': { x: 40, y: 420 },
  'edge-01': { x: 290, y: 325 },
  'fw-01': { x: 500, y: 170 },
  'core-01': { x: 540, y: 320 },
  'core-02': { x: 540, y: 500 },
  'agg-centro': { x: 830, y: 185 },
  'agg-norte': { x: 830, y: 355 },
  'agg-oeste': { x: 830, y: 525 },
  'olt-centro': { x: 1110, y: 175 },
  'olt-norte': { x: 1110, y: 350 },
  'olt-oeste': { x: 1110, y: 525 },
  customers: { x: 1380, y: 350 },
};

const linkPairs: Array<[string, string, number, number, DeviceStatus]> = [
  ['internet', 'edge-01', 100, 31.7, 'UP'],
  ['ix-bh', 'edge-01', 100, 22.1, 'UP'],
  ['edge-01', 'core-01', 100, 42.4, 'UP'],
  ['edge-01', 'core-02', 100, 27.8, 'UP'],
  ['fw-01', 'core-01', 40, 21.2, 'WARNING'],
  ['core-01', 'core-02', 100, 51.4, 'UP'],
  ['core-01', 'agg-centro', 100, 38.7, 'UP'],
  ['core-01', 'agg-norte', 100, 62.3, 'WARNING'],
  ['core-02', 'agg-norte', 100, 28.2, 'UP'],
  ['core-02', 'agg-oeste', 100, 34.9, 'UP'],
  ['agg-centro', 'olt-centro', 40, 13.4, 'UP'],
  ['agg-norte', 'olt-norte', 40, 0, 'DOWN'],
  ['agg-oeste', 'olt-oeste', 40, 11.8, 'UP'],
  ['olt-centro', 'customers', 40, 10.2, 'UP'],
  ['olt-norte', 'customers', 40, 0, 'DOWN'],
  ['olt-oeste', 'customers', 40, 8.6, 'UP'],
];

function findInterface(deviceId: string, index: number): NetworkInterface {
  const found = demoDevices.find((item) => item.id === deviceId)?.interfaces[index];
  if (!found) throw new Error(`Demo interface missing: ${deviceId}/${index}`);
  return found;
}

export const demoLinks: NetworkLink[] = linkPairs.map(
  ([source, target, capacity, tx, status], index) => ({
    id: `link-${index + 1}`,
    mapId: 'backbone-main',
    sourceDeviceId: source,
    sourceInterfaceId: findInterface(source, index % 2).id,
    targetDeviceId: target,
    targetInterfaceId: findInterface(target, (index + 1) % 2).id,
    capacityBps: capacity * 1_000_000_000,
    label: `${capacity}G BACKBONE`,
    status,
    discoverySource: index < 10 ? 'LLDP_SNMP' : 'LLDP_SSH',
    metricSource: 'DEMO',
    rxBps: tx * 0.68 * 1_000_000_000,
    txBps: tx * 1_000_000_000,
    rxUtilization: capacity === 0 ? 0 : (tx * 0.68 * 100) / capacity,
    txUtilization: capacity === 0 ? 0 : (tx * 100) / capacity,
    rxErrors: status === 'WARNING' ? 42 : 0,
    txErrors: status === 'WARNING' ? 17 : 0,
    rxDiscards: status === 'WARNING' ? 12 : 0,
    txDiscards: status === 'WARNING' ? 5 : 0,
    createdAt: now,
    updatedAt: now,
  }),
);

export const demoMap: NetworkMap = {
  id: 'backbone-main',
  name: 'Backbone Principal',
  mode: 'HYBRID',
  devices: demoDevices,
  nodes: demoDevices.map((item, index) => ({
    id: `node-${item.id}`,
    mapId: 'backbone-main',
    deviceId: item.id,
    position: positions[item.id] ?? { x: 100 + index * 100, y: 300 },
    locked: item.id === 'internet' || item.id === 'customers',
    positionSource: item.id === 'internet' || item.id === 'customers' ? 'MANUAL' : 'AUTO',
  })),
  links: demoLinks,
  updatedAt: now,
};

const periodSettings = {
  '15m': { count: 30, stepMs: 30_000 },
  '1h': { count: 60, stepMs: 60_000 },
  '6h': { count: 72, stepMs: 300_000 },
  '24h': { count: 96, stepMs: 900_000 },
  '7d': { count: 84, stepMs: 7_200_000 },
} as const;

export function createDemoHistory(
  interfaceId: string,
  period: keyof typeof periodSettings,
): MetricPoint[] {
  const config = periodSettings[period];
  const seed = [...interfaceId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const end = Date.parse(now);
  return Array.from({ length: config.count }, (_, index) => {
    const wave = Math.sin((index + seed) / 6) * 0.08 + Math.sin((index + seed) / 17) * 0.04;
    const base = 19_000_000_000 + (seed % 14) * 700_000_000;
    return {
      timestamp: new Date(end - (config.count - 1 - index) * config.stepMs).toISOString(),
      rxBps: Math.max(0, base * (0.78 + wave)),
      txBps: Math.max(0, base * (1.02 + wave * 1.2)),
      rxErrors: Math.max(0, Math.round(Math.sin(index / 7) * 2 + 2)),
      txErrors: Math.max(0, Math.round(Math.cos(index / 9) * 1.5 + 1)),
      rxDiscards: Math.max(0, Math.round(Math.sin(index / 11) + 1)),
      txDiscards: index % 19 === 0 ? 1 : 0,
    };
  });
}

export function cloneDemoMap(): NetworkMap {
  return structuredClone(demoMap);
}
