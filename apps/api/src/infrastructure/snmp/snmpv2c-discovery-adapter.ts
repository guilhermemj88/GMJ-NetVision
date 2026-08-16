import type { Device, DiscoveredNeighbor, NetworkInterface, HostRecord } from '@gmj/shared';
import { createLocalId } from '@gmj/shared';
import type { DeviceIdentity, TopologyDiscoveryAdapter } from '../../domain/ports';
import type { HostRepository } from '../persistence/host-repository';
import { SnmpClientImpl } from './snmp-client-impl';

const IF_MIB_OIDS = {
  ifIndex: '1.3.6.1.2.1.2.2.1.1',
  ifDescr: '1.3.6.1.2.1.2.2.1.2',
  ifType: '1.3.6.1.2.1.2.2.1.3',
  ifSpeed: '1.3.6.1.2.1.2.2.1.5',
  ifPhysAddress: '1.3.6.1.2.1.2.2.1.6',
  ifAdminStatus: '1.3.6.1.2.1.2.2.1.7',
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
  ifName: '1.3.6.1.2.1.31.1.1.1.1',
  ifHCInOctets: '1.3.6.1.2.1.31.1.1.1.6',
  ifHCOutOctets: '1.3.6.1.2.1.31.1.1.1.10',
  ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15',
  ifAlias: '1.3.6.1.2.1.31.1.1.1.18',
  ifInOctets: '1.3.6.1.2.1.2.2.1.10',
  ifOutOctets: '1.3.6.1.2.1.2.2.1.16',
} as const;

const SYSTEM_OIDS = {
  sysName: '1.3.6.1.2.1.1.5.0',
  sysDescription: '1.3.6.1.2.1.1.1.0',
} as const;

function getOidSuffix(oid: string, base: string): string {
  return oid.substring(base.length).replace(/^\./, '');
}

function normalizeStatus(value: unknown): 'UP' | 'DOWN' {
  let num = 0;
  if (typeof value === 'string') num = parseInt(value, 10);
  else if (typeof value === 'number') num = value;
  return num === 1 ? 'UP' : 'DOWN';
}

function formatMac(value: string | number | Uint8Array): string {
  if (typeof value === 'string') return value.toUpperCase();
  if (typeof value === 'number') return '';
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, '0').toUpperCase())
    .join(':');
}

function parseSpeed(value: unknown): number {
  let num = 0;
  if (typeof value === 'string') num = parseInt(value, 10);
  else if (typeof value === 'number') num = value;
  return Math.max(0, num || 0);
}

export class SnmpV2cDiscoveryAdapter implements TopologyDiscoveryAdapter {
  readonly kind = 'LLDP_SNMP' as const;
  private readonly client: SnmpClientImpl;

  constructor(private readonly repository: HostRepository) {
    this.client = new SnmpClientImpl(5000, 2);
  }

  async discoverDevice(host: string): Promise<DeviceIdentity> {
    return this.getDeviceIdentity(host);
  }

  async getDeviceIdentity(host: string, community: string = 'public'): Promise<DeviceIdentity> {
    try {
      const values = await this.client.get(
        host,
        [SYSTEM_OIDS.sysName, SYSTEM_OIDS.sysDescription],
        { community, version: 'v2c', port: 161 },
      );
      const byOid = new Map(values.map((value) => [value.oid, value.value]));
      const hostname = String(byOid.get(SYSTEM_OIDS.sysName) ?? '').trim();
      const systemDescription = String(byOid.get(SYSTEM_OIDS.sysDescription) ?? '').trim();
      return {
        ...(hostname ? { hostname } : {}),
        managementAddress: host,
        ...(systemDescription ? { systemDescription } : {}),
      };
    } catch (error) {
      throw new Error(
        `Failed to discover device identity: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async discoverInterfaces(device: Device, community?: string): Promise<NetworkInterface[]> {
    const hostRecord = device as HostRecord;
    if (!hostRecord.snmp?.host || !hostRecord.snmp.port) return [];

    const snmpCommunity = community ?? (await this.getSnmpCommunity(device.id));
    if (!snmpCommunity) return [];

    try {
      const [indices, descrs, speeds, physAddrs, adminStates, operStates, names, highSpeeds, aliases] =
        await Promise.all([
          this.walk(hostRecord, IF_MIB_OIDS.ifIndex, snmpCommunity),
          this.walk(hostRecord, IF_MIB_OIDS.ifDescr, snmpCommunity),
          this.walk(hostRecord, IF_MIB_OIDS.ifSpeed, snmpCommunity),
          this.walk(hostRecord, IF_MIB_OIDS.ifPhysAddress, snmpCommunity),
          this.walk(hostRecord, IF_MIB_OIDS.ifAdminStatus, snmpCommunity),
          this.walk(hostRecord, IF_MIB_OIDS.ifOperStatus, snmpCommunity),
          this.walk(hostRecord, IF_MIB_OIDS.ifName, snmpCommunity),
          this.walk(hostRecord, IF_MIB_OIDS.ifHighSpeed, snmpCommunity),
          this.walk(hostRecord, IF_MIB_OIDS.ifAlias, snmpCommunity),
        ]);

      const descByIndex = this.indexMap(descrs, IF_MIB_OIDS.ifDescr);
      const speedByIndex = this.indexMap(speeds, IF_MIB_OIDS.ifSpeed);
      const macByIndex = this.indexMap(physAddrs, IF_MIB_OIDS.ifPhysAddress);
      const adminByIndex = this.indexMap(adminStates, IF_MIB_OIDS.ifAdminStatus);
      const operByIndex = this.indexMap(operStates, IF_MIB_OIDS.ifOperStatus);
      const nameByIndex = this.indexMap(names, IF_MIB_OIDS.ifName);
      const highSpeedByIndex = this.indexMap(highSpeeds, IF_MIB_OIDS.ifHighSpeed);
      const aliasByIndex = this.indexMap(aliases, IF_MIB_OIDS.ifAlias);

      return indices.map((indexVb) => {
        const ifIndex = parseInt(String(indexVb.value), 10);
        const suffix = String(ifIndex);
        const description = String(descByIndex.get(suffix) ?? '');
        const name = String(nameByIndex.get(suffix) ?? description ?? `if${ifIndex}`);
        const alias = String(aliasByIndex.get(suffix) ?? '');
        const mac = formatMac(macByIndex.get(suffix) ?? '');
        const adminStatus = normalizeStatus(adminByIndex.get(suffix) ?? '2');
        const operStatus = normalizeStatus(operByIndex.get(suffix) ?? '2');
        const highSpeed = highSpeedByIndex.get(suffix);
        const speedBps = highSpeed
          ? parseSpeed(highSpeed) * 1_000_000
          : parseSpeed(speedByIndex.get(suffix) ?? 0);

        return {
          id: createLocalId('interface'),
          deviceId: device.id,
          name,
          alias,
          description,
          ifIndex,
          mac,
          mtu: 1500,
          speedBps,
          adminStatus,
          operStatus,
          rxBps: 0,
          txBps: 0,
          rxUtilization: 0,
          txUtilization: 0,
          rxErrors: 0,
          txErrors: 0,
          rxDiscards: 0,
          txDiscards: 0,
          dataSources: ['SNMP'],
        } satisfies NetworkInterface;
      });
    } catch (error) {
      throw new Error(
        `Failed to discover interfaces: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async discoverNeighbors(_device: Device): Promise<DiscoveredNeighbor[]> {
    return [];
  }

  private walk(host: HostRecord, oid: string, community: string) {
    return this.client.walk(host.snmp!.host, oid, {
      community,
      version: 'v2c',
      port: host.snmp!.port,
    });
  }

  private indexMap(
    varbinds: Array<{ oid: string; value: string | number | Uint8Array }>,
    baseOid: string,
  ): Map<string, string | number | Uint8Array> {
    const map = new Map<string, string | number | Uint8Array>();
    for (const varbind of varbinds) {
      const suffix = getOidSuffix(varbind.oid, baseOid);
      if (suffix) map.set(suffix, varbind.value);
    }
    return map;
  }

  private async getSnmpCommunity(deviceId: string): Promise<string | null> {
    const credentials = await this.repository.getDecryptedSnmpCredentials(deviceId);
    return credentials?.community ?? null;
  }
}
