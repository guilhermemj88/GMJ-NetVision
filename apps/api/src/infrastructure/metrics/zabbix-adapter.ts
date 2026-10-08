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
  dns?: string;
  useip?: string;
  main: string;
  type: string;
  port?: string;
  details?: { version?: string; community?: string; bulk?: string };
}

interface ZabbixHost {
  hostid: string;
  host: string;
  name: string;
  status: string;
  interfaces?: ZabbixHostInterface[];
  inventory?: { vendor?: string; model?: string; type?: string };
}

const SNMP_INTERFACE_TYPE = '2';
/**
 * Campos públicos de interface usados pelo preview. `details` fica de fora: é
 * onde o Zabbix devolve a community e nenhum fluxo de preview pode recebê-la.
 */
const ZABBIX_PUBLIC_INTERFACE_FIELDS = ['interfaceid', 'ip', 'dns', 'useip', 'port', 'main', 'type'];
/** Campos privados da importação — única consulta autorizada a pedir `details`. */
const ZABBIX_PRIVATE_SNMP_INTERFACE_FIELDS = [...ZABBIX_PUBLIC_INTERFACE_FIELDS, 'details'];
/** Macro Zabbix não resolvida (ex.: {$SNMP_COMMUNITY}) nunca é community real. */
const ZABBIX_MACRO_PATTERN = /\{\$[^}]+\}/;

function selectSnmpInterface(
  interfaces: ZabbixHostInterface[] | undefined,
): ZabbixHostInterface | null {
  const candidates = (interfaces ?? []).filter((item) => item.type === SNMP_INTERFACE_TYPE);
  if (candidates.length === 0) return null;
  return candidates.find((item) => item.main === '1') ?? candidates[0] ?? null;
}

function isUnresolvedZabbixMacro(value: string): boolean {
  return ZABBIX_MACRO_PATTERN.test(value);
}

/** IPs placeholder que o Zabbix grava quando useip=0 (a interface usa DNS). */
function usableManagementIp(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === '0.0.0.0' || trimmed === '::' || trimmed === '127.0.0.1' || trimmed === '::1') {
    return null;
  }
  return trimmed;
}

function snmpPortOf(zabbixInterface: ZabbixHostInterface | null): number | null {
  const port = Number(zabbixInterface?.port);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

/**
 * Configuração SNMP privada derivada da interface SNMP do Zabbix. Circula
 * somente no backend durante a importação: a community nunca vai para o
 * preview, respostas públicas, logs, erros ou MCP.
 */
export interface ZabbixSnmpImportConfig {
  enabled: true;
  version: 'SNMP_V2C';
  host: string;
  port: number;
  community: string;
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
      selectInterfaces: ZABBIX_PUBLIC_INTERFACE_FIELDS,
      selectInventory: ['vendor', 'model', 'type'],
      sortfield: 'host',
    });
    return Promise.all(
      hosts.map(async (host) => {
        const snmpInterface = selectSnmpInterface(host.interfaces);
        const legacyInterface =
          host.interfaces?.find((item) => item.main === '1' && item.type !== SNMP_INTERFACE_TYPE) ??
          host.interfaces?.find((item) => item.type !== SNMP_INTERFACE_TYPE);
        // useip=0 significa "conectar via DNS": o ip da interface SNMP vira
        // placeholder (127.0.0.1/0.0.0.0) e não é autoritativo. O managementIp
        // do NetVision é orientado a IP, então mantemos o melhor IP real
        // disponível (interface legada → ip da SNMP) sem nunca zerá-lo.
        const snmpIp = usableManagementIp(snmpInterface?.ip);
        const snmpUsesIp = String(snmpInterface?.useip ?? '1') === '1';
        let managementIp: string;
        let primaryInterfaceId: string;
        if (snmpInterface) {
          primaryInterfaceId = snmpInterface.interfaceid;
          managementIp =
            (snmpUsesIp ? snmpIp : null) ?? usableManagementIp(legacyInterface?.ip) ?? snmpIp ?? '';
        } else {
          const legacy =
            host.interfaces?.find((item) => item.main === '1') ?? host.interfaces?.[0];
          primaryInterfaceId = legacy?.interfaceid ?? '';
          managementIp = legacy?.ip ?? '';
        }
        const interfaces = await this.getInterfaces(host.hostid);
        return {
          hostId: host.hostid,
          hostname: host.host,
          displayName: host.name || host.host,
          managementIp,
          primaryInterfaceId,
          vendor: host.inventory?.vendor ?? '',
          model: host.inventory?.model ?? host.inventory?.type ?? '',
          status: host.status === '0' ? ('UP' as const) : ('UNKNOWN' as const),
          alreadyRegistered: false,
          matchedHostId: null,
          interfaceCount: interfaces.length,
          snmpAvailable: Boolean(snmpInterface),
          // A versão vive em `details` (privado): só a importação pode resolvê-la.
          snmpVersion: null,
          snmpPort: snmpPortOf(snmpInterface),
        };
      }),
    );
  }

  /**
   * Config SNMP privada para a importação (somente backend). Retorna null
   * quando não há interface SNMP v2c com community utilizável — nunca inventa
   * community, nunca copia segredos de SNMPv3 e ignora macros não resolvidas.
   */
  async getSnmpImportConfig(hostId: string): Promise<ZabbixSnmpImportConfig | null> {
    const hosts = await this.call<ZabbixHost[]>('host.get', {
      hostids: hostId.replace(/^zabbix-/, ''),
      output: ['hostid'],
      selectInterfaces: ZABBIX_PRIVATE_SNMP_INTERFACE_FIELDS,
    });
    const snmpInterface = selectSnmpInterface(hosts[0]?.interfaces);
    if (!snmpInterface || snmpInterface.details?.version !== '2') return null;
    const community = snmpInterface.details?.community?.trim();
    // Macro não resolvida ({$SNMP_COMMUNITY}) não é community: não criptografa
    // o token literal nem tenta resolver macros globais/templates nesta fase.
    if (!community || isUnresolvedZabbixMacro(community)) return null;
    const ip = snmpInterface.ip?.trim() ?? '';
    const dns = snmpInterface.dns?.trim() ?? '';
    const useip = String(snmpInterface.useip ?? '1') === '1';
    // useip=0: o alvo SNMP é o nome DNS configurado (o cliente SNMP resolve).
    const target = useip ? ip : dns || usableManagementIp(ip) || '';
    if (!target) return null;
    return {
      enabled: true,
      version: 'SNMP_V2C',
      host: target,
      port: snmpPortOf(snmpInterface) ?? 161,
      community,
    };
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
        pppSupported: false,
        pppOnline: 0,
        pppUpdatedAt: null,
        pppSource: null,
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
