import type { SnmpClient, SnmpVarBind } from '../../domain/ports';
import type {
  FastCounterReading,
  FastTrafficReader,
  FastTrafficTarget,
} from './fast-traffic-types';

export const FAST_OIDS = {
  uptime: '1.3.6.1.2.1.1.3.0',
  name: '1.3.6.1.2.1.31.1.1.1.1',
  in: '1.3.6.1.2.1.31.1.1.1.6',
  out: '1.3.6.1.2.1.31.1.1.1.10',
  admin: '1.3.6.1.2.1.2.2.1.7',
  oper: '1.3.6.1.2.1.2.2.1.8',
  lastChange: '1.3.6.1.2.1.2.2.1.9',
  highSpeed: '1.3.6.1.2.1.31.1.1.1.15',
  discontinuity: '1.3.6.1.2.1.31.1.1.1.19',
} as const;

/** Narrow read-only inventory port, also used by the standalone observer. */
export interface FastSnmpHostPort {
  getHost(id: string): Promise<{
    id: string;
    snmpEnabled: boolean;
    snmp?: { version: string; host: string; port: number } | null;
    interfaces: Array<{
      id: string;
      name: string;
      ifIndex: number;
      speedBps?: bigint | number | string | null;
    }>;
  } | null>;
  getDecryptedSnmpCredentials(id: string): Promise<{ community?: string } | null>;
}

/** Big-endian Counter64 buffers never pass through Number (precision loss). */
export function snmpUnsigned(value: SnmpVarBind['value'] | undefined): bigint {
  if (value instanceof Uint8Array) {
    let n = 0n;
    for (const byte of value) n = (n << 8n) | BigInt(byte);
    return n;
  }
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0))
    throw new Error('INVALID_COUNTER');
  if (value === undefined || !/^\d+$/.test(String(value))) throw new Error('MISSING_COUNTER');
  return BigInt(String(value));
}

/** Reuses the inventory and SNMP client. No discovery, SSH or auxiliary collectors. */
export class FastSnmpReader implements FastTrafficReader {
  constructor(
    private readonly hosts: FastSnmpHostPort,
    private readonly client: SnmpClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(targets: FastTrafficTarget[]): Promise<FastCounterReading[]> {
    if (!targets.length) return [];
    const first = targets[0]!;
    if (targets.length > 4 || targets.some((t) => t.deviceId !== first.deviceId))
      throw new Error('INVALID_BATCH');
    const host = await this.hosts.getHost(first.deviceId);
    if (!host?.snmpEnabled || host.snmp?.version !== 'SNMP_V2C' || !host.snmp.host)
      throw new Error('SNMP_NOT_CONFIGURED');
    // Revalidate inventory on EVERY GET, even when scheduler target cache is old.
    for (const t of targets) {
      if (
        !host.interfaces.some(
          (i) => i.id === t.interfaceId && i.ifIndex === t.ifIndex && i.name === t.interfaceName,
        )
      ) {
        throw new Error('INTERFACE_REMOVED_OR_REMAPPED');
      }
    }
    const secret = await this.hosts.getDecryptedSnmpCredentials(host.id);
    if (!secret?.community) throw new Error('SNMP_CREDENTIAL_UNAVAILABLE');
    const oids = [
      FAST_OIDS.uptime,
      ...targets.flatMap((t) =>
        Object.entries(FAST_OIDS)
          .filter(([key]) => key !== 'uptime')
          .map(([, oid]) => `${oid}.${t.ifIndex}`),
      ),
    ];
    const requestStartedAt = this.now();
    const values = await this.client.get(host.snmp.host, oids, {
      community: secret.community,
      version: 'v2c',
      port: host.snmp.port,
    });
    const collectedAt = this.now();
    const rows = new Map(values.map((v) => [v.oid, v.value]));
    if (rows.size !== values.length) throw new Error('DUPLICATE_OID_RESPONSE');
    return targets.map((t) => {
      const get = (key: Exclude<keyof typeof FAST_OIDS, 'uptime'>) =>
        rows.get(`${FAST_OIDS[key]}.${t.ifIndex}`);
      const name = get('name');
      if (name === undefined) throw new Error('INTERFACE_REMOVED_OR_REMAPPED');
      const interfaceName =
        name instanceof Uint8Array ? Buffer.from(name).toString('utf8') : String(name);
      const speed = snmpUnsigned(get('highSpeed')) * 1_000_000n;
      return {
        deviceId: t.deviceId,
        interfaceId: t.interfaceId,
        ifIndex: t.ifIndex,
        interfaceName,
        requestStartedAt,
        collectedAt,
        inOctets: snmpUnsigned(get('in')),
        outOctets: snmpUnsigned(get('out')),
        uptimeTicks: snmpUnsigned(rows.get(FAST_OIDS.uptime)),
        discontinuityTicks: snmpUnsigned(get('discontinuity')),
        lastChangeTicks: snmpUnsigned(get('lastChange')),
        adminStatus: Number(snmpUnsigned(get('admin'))),
        operStatus: Number(snmpUnsigned(get('oper'))),
        speedBps: speed > 0n ? speed : t.speedBps,
      };
    });
  }
}
