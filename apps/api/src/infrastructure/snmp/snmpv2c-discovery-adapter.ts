import type { Device, DiscoveredNeighbor, NetworkInterface, HostRecord } from '@gmj/shared';
import { createLocalId } from '@gmj/shared';
import type { DeviceIdentity, TopologyDiscoveryAdapter } from '../../domain/ports';
import type { DemoMapRepository } from '../persistence/demo-map-repository';
import { SnmpClientImpl } from './snmp-client-impl';

// IF-MIB OIDs for interface discovery
const IF_MIB_OIDS = {
  // Basic interface table (ifTable)
  ifIndex: '1.3.6.1.2.1.2.2.1.1',
  ifDescr: '1.3.6.1.2.1.2.2.1.2',
  ifType: '1.3.6.1.2.1.2.2.1.3',
  ifSpeed: '1.3.6.1.2.1.2.2.1.5',
  ifPhysAddress: '1.3.6.1.2.1.2.2.1.6',
  ifAdminStatus: '1.3.6.1.2.1.2.2.1.7',
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8',

  // Extended interface table (ifXTable)
  ifName: '1.3.6.1.2.1.31.1.1.1.1',
  ifHCInOctets: '1.3.6.1.2.1.31.1.1.1.6',
  ifHCOutOctets: '1.3.6.1.2.1.31.1.1.1.10',
  ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15',
  ifAlias: '1.3.6.1.2.1.31.1.1.1.18',

  // Fallback counters (32-bit, used if HC not available)
  ifInOctets: '1.3.6.1.2.1.2.2.1.10',
  ifOutOctets: '1.3.6.1.2.1.2.2.1.16',
} as const;

// System identity OIDs
const SYSTEM_OIDS = {
  sysName: '1.3.6.1.2.1.1.5.0',
  sysDescription: '1.3.6.1.2.1.1.1.0',
} as const;

/**
 * Extract suffix (index) from OID.
 * E.g., "1.3.6.1.2.1.2.2.1.2.5" -> "5"
 */
function getOidSuffix(oid: string, base: string): string {
  return oid.substring(base.length).replace(/^\./, '');
}

/**
 * Normalize status values.
 * SNMP status: 1=up, 2=down, 3=testing, etc.
 */
function normalizeStatus(value: unknown): 'UP' | 'DOWN' {
  let num = 0;
  if (typeof value === 'string') {
    num = parseInt(value, 10);
  } else if (typeof value === 'number') {
    num = value;
  }
  return num === 1 ? 'UP' : 'DOWN';
}

/**
 * Parse MAC address from hex string.
 */
function formatMac(value: string | number | Uint8Array): string {
  if (typeof value === 'string') return value.toUpperCase();
  if (typeof value === 'number') return '';
  if (value instanceof Uint8Array) {
    return Array.from(value)
      .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
      .join(':');
  }
  return '';
}

/**
 * Parse speed from SNMP value.
 * ifSpeed is in bps, ifHighSpeed is in Mbps.
 */
function parseSpeed(value: unknown): number {
  let num = 0;
  if (typeof value === 'string') {
    num = parseInt(value, 10);
  } else if (typeof value === 'number') {
    num = value;
  }
  return Math.max(0, num || 0);
}

/**
 * SNMP v2c Discovery Adapter for real network equipment.
 * Discovers topology and interfaces via SNMP, supports IF-MIB.
 */
export class SnmpV2cDiscoveryAdapter implements TopologyDiscoveryAdapter {
  readonly kind = 'LLDP_SNMP' as const;
  private readonly client: SnmpClientImpl;

  constructor(private readonly repository: DemoMapRepository) {
    this.client = new SnmpClientImpl(5000, 2);
  }

  /**
   * Discover device identity (hostname, description).
   */
  async discoverDevice(host: string): Promise<DeviceIdentity> {
    return this.getDeviceIdentity(host);
  }

  /**
   * Get device identity via SNMP system objects.
   */
  async getDeviceIdentity(host: string, community: string = 'public'): Promise<DeviceIdentity> {
    try {
      const values = await this.client.get(
        host,
        [SYSTEM_OIDS.sysName, SYSTEM_OIDS.sysDescription],
        { community, version: 'v2c', port: 161 },
      );

      const byOid = new Map(values.map((v) => [v.oid, v.value]));
      const hostname = String(byOid.get(SYSTEM_OIDS.sysName) ?? '').trim();
      const systemDescription = String(byOid.get(SYSTEM_OIDS.sysDescription) ?? '').trim();

      return {
        ...(hostname ? { hostname } : {}),
        managementAddress: host,
        ...(systemDescription ? { systemDescription } : {}),
      };
    } catch (error) {
      throw new Error(`Failed to discover device identity: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Discover network interfaces via IF-MIB.
   * Returns interfaces with speed, MAC, admin/oper status, and counter OIDs.
   */
  async discoverInterfaces(device: Device, community?: string): Promise<NetworkInterface[]> {
    const hostRecord = device as HostRecord;
    if (!hostRecord.snmp?.host || !hostRecord.snmp.port) {
      return [];
    }

    const snmpCommunity = community ?? (await this.getSnmpCommunity(device.id));
    if (!snmpCommunity) {
      return [];
    }

    try {
      // Walk all interface tables in parallel
      const [
        indices,
        descrs,
        speeds,
        physAddrs,
        adminStates,
        operStates,
        names,
        ifHighSpeeds,
        aliases,
      ] = await Promise.all([
        this.client.walk(hostRecord.snmp.host, IF_MIB_OIDS.ifIndex, {
          community: snmpCommunity,
          version: 'v2c',
          port: hostRecord.snmp.port,
        }),
        this.client.walk(hostRecord.snmp.host, IF_MIB_OIDS.ifDescr, {
          community: snmpCommunity,
          version: 'v2c',
          port: hostRecord.snmp.port,
        }),
        this.client.walk(hostRecord.snmp.host, IF_MIB_OIDS.ifSpeed, {
          community: snmpCommunity,
          version: 'v2c',
          port: hostRecord.snmp.port,
        }),
        this.client.walk(hostRecord.snmp.host, IF_MIB_OIDS.ifPhysAddress, {
          community: snmpCommunity,
          version: 'v2c',
          port: hostRecord.snmp.port,
        }),
        this.client.walk(hostRecord.snmp.host, IF_MIB_OIDS.ifAdminStatus, {
          community: snmpCommunity,
          version: 'v2c',
          port: hostRecord.snmp.port,
        }),
        this.client.walk(hostRecord.snmp.host, IF_MIB_OIDS.ifOperStatus, {
          community: snmpCommunity,
          version: 'v2c',
          port: hostRecord.snmp.port,
        }),
        this.client.walk(hostRecord.snmp.host, IF_MIB_OIDS.ifName, {
          community: snmpCommunity,
          version: 'v2c',
          port: hostRecord.snmp.port,
        }),
        this.client.walk(hostRecord.snmp.host, IF_MIB_OIDS.ifHighSpeed, {
          community: snmpCommunity,
          version: 'v2c',
          port: hostRecord.snmp.port,
        }),
        this.client.walk(hostRecord.snmp.host, IF_MIB_OIDS.ifAlias, {
          community: snmpCommunity,
          version: 'v2c',
          port: hostRecord.snmp.port,
        }),
      ]);

      // Build index maps
      const descByIndex = this.indexMap(descrs, IF_MIB_OIDS.ifDescr);
      const speedByIndex = this.indexMap(speeds, IF_MIB_OIDS.ifSpeed);
      const macByIndex = this.indexMap(physAddrs, IF_MIB_OIDS.ifPhysAddress);
      const adminByIndex = this.indexMap(adminStates, IF_MIB_OIDS.ifAdminStatus);
      const operByIndex = this.indexMap(operStates, IF_MIB_OIDS.ifOperStatus);
      const nameByIndex = this.indexMap(names, IF_MIB_OIDS.ifName);
      const highSpeedByIndex = this.indexMap(ifHighSpeeds, IF_MIB_OIDS.ifHighSpeed);
      const aliasByIndex = this.indexMap(aliases, IF_MIB_OIDS.ifAlias);

      // Build NetworkInterface objects
      const interfaces: NetworkInterface[] = indices.map((indexVb) => {
        const ifIndex = parseInt(String(indexVb.value), 10);
        const suffix = String(ifIndex);

        // Collect values
        const description = String(descByIndex.get(suffix) ?? '');
        const name = String(nameByIndex.get(suffix) ?? description ?? `if${ifIndex}`);
        const alias = String(aliasByIndex.get(suffix) ?? '');
        const mac = formatMac(macByIndex.get(suffix) ?? '');
        const adminStatus = normalizeStatus(adminByIndex.get(suffix) ?? '2'); // Default DOWN
        const operStatus = normalizeStatus(operByIndex.get(suffix) ?? '2'); // Default DOWN

        // Determine speed: prefer ifHighSpeed (in Mbps), fall back to ifSpeed (in bps)
        let speedBps = 0;
        const highSpeedVal = highSpeedByIndex.get(suffix);
        if (highSpeedVal) {
          speedBps = parseSpeed(highSpeedVal) * 1_000_000; // Mbps to bps
        } else {
          speedBps = parseSpeed(speedByIndex.get(suffix) ?? 0);
        }

        return {
          id: createLocalId('interface'),
          deviceId: device.id,
          name,
          alias,
          description,
          ifIndex,
          mac,
          mtu: 1500, // Will be updated by subsequent polling if available
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
        };
      });

      return interfaces;
    } catch (error) {
      throw new Error(`Failed to discover interfaces: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * LLDP discovery not yet implemented for SNMP v2c discovery.
   * Left empty for now; will be handled by existing LldpSnmpDiscoveryAdapter.
   */
  async discoverNeighbors(_device: Device): Promise<DiscoveredNeighbor[]> {
    return [];
  }

  /**
   * Build a map from SNMP index to value.
   * E.g., OID "1.3.6.1.2.1.2.2.1.2.5" with base "1.3.6.1.2.1.2.2.1.2" -> Map("5" -> value)
   */
  private indexMap(
    varbinds: Array<{ oid: string; value: string | number | Uint8Array }>,
    baseOid: string,
  ): Map<string, string | number | Uint8Array> {
    const map = new Map<string, string | number | Uint8Array>();
    for (const vb of varbinds) {
      const suffix = getOidSuffix(vb.oid, baseOid);
      if (suffix) {
        map.set(suffix, vb.value);
      }
    }
    return map;
  }

  /**
   * Get SNMP community for device from repository.
   * Decrypts stored credentials and extracts community string.
   */
  private async getSnmpCommunity(deviceId: string): Promise<string | null> {
    const credentials = await this.repository.getDecryptedSnmpCredentials(deviceId);
    return credentials?.community ?? null;
  }
}
