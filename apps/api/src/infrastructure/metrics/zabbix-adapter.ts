import type { Device, HistoryPeriod, MetricPoint, NetworkInterface } from '@gmj/shared';
import type { MetricSourceAdapter } from '../../domain/ports';

interface ZabbixResponse<T> {
  result?: T;
  error?: { code: number; message: string; data: string };
}

interface ZabbixHost {
  hostid: string;
  host: string;
  name: string;
  status: string;
  interfaces?: Array<{ ip: string }>;
}

export class ZabbixAdapter implements MetricSourceAdapter {
  readonly kind = 'ZABBIX' as const;
  private requestId = 0;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.url.replace(/\/$/, '')}/api_jsonrpc.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json-rpc', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: ++this.requestId }),
    });
    if (!response.ok) throw new Error(`Zabbix HTTP ${response.status}`);
    const payload = (await response.json()) as ZabbixResponse<T>;
    if (payload.error) throw new Error(`Zabbix ${payload.error.message}: ${payload.error.data}`);
    if (payload.result === undefined) throw new Error('Zabbix returned no result');
    return payload.result;
  }

  async getDevices(): Promise<Device[]> {
    const hosts = await this.call<ZabbixHost[]>('host.get', {
      output: ['hostid', 'host', 'name', 'status'],
      selectInterfaces: ['ip'],
    });
    return hosts.map((host) => ({
      id: `zabbix-${host.hostid}`,
      name: host.name || host.host,
      hostname: host.host,
      ip: host.interfaces?.[0]?.ip ?? '',
      vendor: '',
      model: '',
      status: host.status === '0' ? 'UP' : 'UNKNOWN',
      deviceType: 'generic',
      site: '',
      source: 'ZABBIX',
      discoveryMethod: 'AUTO',
      uptimeSeconds: 0,
      updatedAt: new Date().toISOString(),
      interfaces: [],
    }));
  }

  async getDevice(id: string): Promise<Device | null> {
    return (await this.getDevices()).find((device) => device.id === id) ?? null;
  }

  async getInterfaces(_deviceId: string): Promise<NetworkInterface[]> {
    // Item-to-interface mapping is intentionally explicit and configured by the import workflow.
    return [];
  }

  async getInterface(_id: string): Promise<NetworkInterface | null> {
    return null;
  }

  async getMetrics(_interfaceId: string): Promise<Record<string, number | string>> {
    return {};
  }

  async getHistory(_interfaceId: string, _period: HistoryPeriod): Promise<MetricPoint[]> {
    return [];
  }

  async healthcheck(): Promise<{ version: string }> {
    const version = await this.call<string>('apiinfo.version', {});
    return { version };
  }
}
