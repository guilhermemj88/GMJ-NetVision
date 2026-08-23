import {
  aggregateMetricHistory,
  type Device,
  type DeviceStatus,
  type HistoryPeriod,
  type MetricPoint,
  type NetworkInterface,
  type ZabbixHostCandidate,
} from '@gmj/shared';
import type { MetricSourceAdapter } from '../../domain/ports';

interface ZabbixResponse<T> {
  result?: T;
  error?: { code: number; message: string; data: string };
}

interface ZabbixHostInterface {
  interfaceid: string;
  ip: string;
  main: string;
  type: string;
}

interface ZabbixHost {
  hostid: string;
  host: string;
  name: string;
  status: string;
  interfaces?: ZabbixHostInterface[];
  inventory?: { vendor?: string; model?: string; type?: string };
}

export interface ZabbixItem {
  itemid: string;
  hostid: string;
  name: string;
  key_: string;
  lastvalue: string;
  units: string;
  value_type: string;
  status: string;
}

interface ZabbixHistoryValue {
  itemid: string;
  clock: string;
  value: string;
}

type ZabbixAuthMode = 'AUTH_FIELD' | 'BEARER';
type InterfaceMetricRole =
  'rx' | 'tx' | 'status' | 'inErrors' | 'outErrors' | 'inDiscards' | 'outDiscards' | 'speed';

const periodSeconds: Record<HistoryPeriod, number> = {
  '15m': 900,
  '1h': 3_600,
  '6h': 21_600,
  '24h': 86_400,
  '7d': 604_800,
};

function safeNumber(value: string | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rateFromItem(item: ZabbixItem | undefined): number {
  const value = safeNumber(item?.lastvalue);
  return item?.units === 'Bps' ? value * 8 : item?.units.toLowerCase() === 'bps' ? value : value;
}

function interfaceName(item: ZabbixItem, ifIndex: number): string {
  const match = item.name.match(/^Interface\s+(.+?)(?:\([^)]*\))?:/i);
  return match?.[1]?.trim() || `ifIndex ${ifIndex}`;
}

function itemRole(key: string): InterfaceMetricRole | null {
  const normalized = key.toLowerCase();
  if (normalized.startsWith('net.if.in.errors[') || normalized.includes('ifinerrors.'))
    return 'inErrors';
  if (normalized.startsWith('net.if.out.errors[') || normalized.includes('ifouterrors.'))
    return 'outErrors';
  if (normalized.startsWith('net.if.in.discards[') || normalized.includes('ifindiscards.'))
    return 'inDiscards';
  if (normalized.startsWith('net.if.out.discards[') || normalized.includes('ifoutdiscards.'))
    return 'outDiscards';
  if (normalized.startsWith('net.if.status[') || normalized.includes('ifoperstatus.'))
    return 'status';
  if (normalized.startsWith('net.if.speed[') || normalized.includes('ifhighspeed.')) return 'speed';
  if (normalized.startsWith('net.if.in[') || normalized.includes('ifhcinoctets.')) return 'rx';
  if (normalized.startsWith('net.if.out[') || normalized.includes('ifhcoutoctets.')) return 'tx';
  return null;
}

function itemIfIndex(key: string): number | null {
  const bracket = key.match(/\.(\d+)(?:[,\]])/);
  if (bracket?.[1]) return Number(bracket[1]);
  const finalNumber = key.match(/(\d+)\]$/);
  return finalNumber?.[1] ? Number(finalNumber[1]) : null;
}

export function normalizeZabbixInterfaceItems(
  hostId: string,
  deviceId: string,
  items: ZabbixItem[],
): NetworkInterface[] {
  const grouped = new Map<number, Partial<Record<InterfaceMetricRole, ZabbixItem>>>();
  for (const item of items) {
    const role = itemRole(item.key_);
    const ifIndex = itemIfIndex(item.key_);
    if (!role || ifIndex === null) continue;
    grouped.set(ifIndex, { ...grouped.get(ifIndex), [role]: item });
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([ifIndex, metrics]) => {
      const identityItem =
        metrics.rx ?? metrics.tx ?? metrics.status ?? metrics.inErrors ?? metrics.outErrors;
      const statusValue = safeNumber(metrics.status?.lastvalue);
      const speedValue = safeNumber(metrics.speed?.lastvalue);
      const speedBps = speedValue > 0 ? speedValue : 1_000_000_000;
      const rxBps = rateFromItem(metrics.rx);
      const txBps = rateFromItem(metrics.tx);
      return {
        id: `zabbix-interface-${hostId}-${ifIndex}`,
        deviceId,
        name: identityItem ? interfaceName(identityItem, ifIndex) : `ifIndex ${ifIndex}`,
        alias: '',
        description: identityItem?.name ?? '',
        ifIndex,
        mac: '',
        mtu: 1500,
        speedBps,
        adminStatus: 'UP',
        operStatus:
          statusValue === 1
            ? 'UP'
            : statusValue === 2
              ? 'DOWN'
              : statusValue === 0
                ? 'UNKNOWN'
                : 'WARNING',
        rxBps,
        txBps,
        rxUtilization: speedBps > 0 ? (rxBps / speedBps) * 100 : 0,
        txUtilization: speedBps > 0 ? (txBps / speedBps) * 100 : 0,
        rxErrors: safeNumber(metrics.inErrors?.lastvalue),
        txErrors: safeNumber(metrics.outErrors?.lastvalue),
        rxDiscards: safeNumber(metrics.inDiscards?.lastvalue),
        txDiscards: safeNumber(metrics.outDiscards?.lastvalue),
        telemetryAvailable: Boolean(metrics.rx || metrics.tx),
        rxItemId: metrics.rx?.itemid ?? null,
        txItemId: metrics.tx?.itemid ?? null,
        statusItemId: metrics.status?.itemid ?? null,
        inErrorsItemId: metrics.inErrors?.itemid ?? null,
        outErrorsItemId: metrics.outErrors?.itemid ?? null,
        inDiscardsItemId: metrics.inDiscards?.itemid ?? null,
        outDiscardsItemId: metrics.outDiscards?.itemid ?? null,
        dataSources: ['ZABBIX'],
      };
    });
}

export class ZabbixAdapter implements MetricSourceAdapter {
  readonly kind = 'ZABBIX' as const;
  private requestId = 0;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly authMode: ZabbixAuthMode = 'AUTH_FIELD',
  ) {}

  private async call<T>(
    method: string,
    params: Record<string, unknown>,
    authenticated = true,
  ): Promise<T> {
    const endpoint = `${this.url.replace(/\/$/, '').replace(/\/api_jsonrpc\.php$/, '')}/api_jsonrpc.php`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json-rpc',
        ...(authenticated && this.authMode === 'BEARER'
          ? { Authorization: `Bearer ${this.token}` }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        id: ++this.requestId,
        ...(authenticated && this.authMode === 'AUTH_FIELD' ? { auth: this.token } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Zabbix HTTP ${response.status}`);
    const payload = (await response.json()) as ZabbixResponse<T>;
    if (payload.error) throw new Error(`Zabbix ${method} falhou (código ${payload.error.code})`);
    if (payload.result === undefined) throw new Error(`Zabbix ${method} retornou resposta vazia`);
    return payload.result;
  }

  async getHostCandidates(): Promise<ZabbixHostCandidate[]> {
    const hosts = await this.call<ZabbixHost[]>('host.get', {
      output: ['hostid', 'host', 'name', 'status'],
      selectInterfaces: ['interfaceid', 'ip', 'main', 'type'],
      selectInventory: ['vendor', 'model', 'type'],
      sortfield: 'host',
    });
    return Promise.all(
      hosts.map(async (host) => {
        const main = host.interfaces?.find((item) => item.main === '1') ?? host.interfaces?.[0];
        const interfaces = await this.getInterfaces(host.hostid);
        return {
          hostId: host.hostid,
          hostname: host.host,
          displayName: host.name || host.host,
          managementIp: main?.ip ?? '',
          primaryInterfaceId: main?.interfaceid ?? '',
          vendor: host.inventory?.vendor ?? '',
          model: host.inventory?.model ?? host.inventory?.type ?? '',
          status: host.status === '0' ? ('UP' as const) : ('UNKNOWN' as const),
          alreadyRegistered: false,
          matchedHostId: null,
          interfaceCount: interfaces.length,
        };
      }),
    );
  }

  async getDevices(): Promise<Device[]> {
    const candidates = await this.getHostCandidates();
    return Promise.all(
      candidates.map(async (host) => ({
        id: `zabbix-${host.hostId}`,
        name: host.displayName,
        hostname: host.hostname,
        ip: host.managementIp,
        vendor: host.vendor,
        model: host.model,
        status: host.status,
        deviceType: 'generic',
        site: '',
        source: 'ZABBIX',
        discoveryMethod: 'AUTO',
        uptimeSeconds: 0,
        updatedAt: new Date().toISOString(),
        interfaces: await this.getInterfaces(host.hostId),
      })),
    );
  }

  async getDevice(id: string): Promise<Device | null> {
    return (await this.getDevices()).find((device) => device.id === id) ?? null;
  }

  async getItems(hostId: string): Promise<ZabbixItem[]> {
    return this.call<ZabbixItem[]>('item.get', {
      hostids: hostId.replace(/^zabbix-/, ''),
      output: ['itemid', 'hostid', 'name', 'key_', 'lastvalue', 'units', 'value_type', 'status'],
      filter: { status: '0' },
    });
  }

  async getInterfaces(deviceId: string): Promise<NetworkInterface[]> {
    const hostId = deviceId.replace(/^zabbix-/, '');
    return normalizeZabbixInterfaceItems(hostId, `zabbix-${hostId}`, await this.getItems(hostId));
  }

  async getInterface(id: string): Promise<NetworkInterface | null> {
    const match = id.match(/^zabbix-interface-(.+)-(\d+)$/);
    if (!match?.[1] || !match[2]) return null;
    return (
      (await this.getInterfaces(match[1])).find((item) => item.ifIndex === Number(match[2])) ?? null
    );
  }

  async getMetrics(interfaceId: string): Promise<Record<string, number | string>> {
    const networkInterface = await this.getInterface(interfaceId);
    if (!networkInterface) return {};
    return {
      rxBps: networkInterface.rxBps,
      txBps: networkInterface.txBps,
      operStatus: networkInterface.operStatus,
      rxErrors: networkInterface.rxErrors,
      txErrors: networkInterface.txErrors,
      rxDiscards: networkInterface.rxDiscards,
      txDiscards: networkInterface.txDiscards,
    };
  }

  async getHistory(interfaceId: string, period: HistoryPeriod): Promise<MetricPoint[]> {
    const networkInterface = await this.getInterface(interfaceId);
    if (!networkInterface) return [];
    const itemIds = [networkInterface.rxItemId, networkInterface.txItemId].filter(
      (value): value is string => Boolean(value),
    );
    if (itemIds.length === 0) return [];
    const values = await this.call<ZabbixHistoryValue[]>('history.get', {
      output: 'extend',
      history: 3,
      itemids: itemIds,
      time_from: Math.floor(Date.now() / 1000) - periodSeconds[period],
      sortfield: 'clock',
      sortorder: 'ASC',
      limit: 2_000,
    });
    const byClock = new Map<string, MetricPoint>();
    values.forEach((value) => {
      const point = byClock.get(value.clock) ?? {
        timestamp: new Date(Number(value.clock) * 1000).toISOString(),
        rxBps: 0,
        txBps: 0,
        rxErrors: 0,
        txErrors: 0,
        rxDiscards: 0,
        txDiscards: 0,
      };
      if (value.itemid === networkInterface.rxItemId) point.rxBps = safeNumber(value.value);
      if (value.itemid === networkInterface.txItemId) point.txBps = safeNumber(value.value);
      byClock.set(value.clock, point);
    });
    return aggregateMetricHistory([...byClock.values()], period);
  }

  async healthcheck(): Promise<{ version: string }> {
    const version = await this.call<string>('apiinfo.version', {}, false);
    return { version };
  }
}

export function demoZabbixCandidates(existingHosts: Device[]): ZabbixHostCandidate[] {
  const existing = existingHosts.slice(0, 2).map((host, index) => ({
    hostId: `demo-existing-${index + 1}`,
    hostname: host.hostname,
    displayName: host.name,
    managementIp: host.ip,
    primaryInterfaceId: `demo-interface-${index + 1}`,
    vendor: host.vendor,
    model: host.model,
    status: host.status,
    alreadyRegistered: true,
    matchedHostId: host.id,
    interfaceCount: host.interfaces.length,
  }));
  const fresh: ZabbixHostCandidate[] = [
    ['673001', 'BHE-VTA-6730-MPLS-01', '10.100.101.10', 'Huawei', 'NetEngine 6730'],
    ['673002', 'BHE-VTA-6730-MPLS-02', '10.100.101.11', 'Huawei', 'NetEngine 6730'],
    ['400001', 'NEW-ACCESS-01', '10.100.120.1', 'Huawei', 'S6730-H'],
  ].map(([hostId, hostname, ip, vendor, model], index) => ({
    hostId: hostId!,
    hostname: hostname!,
    displayName: hostname!,
    managementIp: ip!,
    primaryInterfaceId: `demo-new-interface-${index + 1}`,
    vendor: vendor!,
    model: model!,
    status: 'UP' as DeviceStatus,
    alreadyRegistered: false,
    matchedHostId: null,
    interfaceCount: 4,
  }));
  return [...existing, ...fresh];
}
