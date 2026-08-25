import type {
  Device,
  DiscoveredNeighbor,
  HostRecord,
  NetworkInterface,
  OpticalLaneReading,
} from '@gmj/shared';
import { createLocalId } from '@gmj/shared';
import type { DeviceIdentity, TopologyDiscoveryAdapter } from '../../domain/ports';
import type { HostRepository } from '../persistence/host-repository';
import {
  HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS,
  parseHuaweiOpticalLaneCsv,
} from '../topology/huawei-optical';
import { interfaceNameKeys } from '../topology/interface-correlation';
import { microWattsToDbm } from '../topology/optical-power';
import { SnmpClientImpl } from './snmp-client-impl';
import { decodeSnmpText } from './snmp-text';

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

const ENTITY_MIB_OIDS = {
  physicalName: '1.3.6.1.2.1.47.1.1.1.1.7',
} as const;

type VarBind = { oid: string; value: string | number | Uint8Array };

type OpticalReading = {
  rxPowerDbm: number | null;
  txPowerDbm: number | null;
  opticalLanes: OpticalLaneReading[];
};

function getOidSuffix(oid: string, base: string): string {
  return oid.substring(base.length).replace(/^\./, '');
}

function numericValue(value: unknown): number {
  let num = 0;
  if (typeof value === 'string') num = Number(value.trim());
  else if (typeof value === 'number') num = value;
  else if (value instanceof Uint8Array) num = Number(decodeSnmpText(value));
  return Number.isFinite(num) ? num : 0;
}

function normalizeAdminStatus(value: unknown): 'UP' | 'DOWN' {
  return numericValue(value) === 1 ? 'UP' : 'DOWN';
}

function normalizeOperStatus(value: unknown): NetworkInterface['operStatus'] {
  const num = numericValue(value);
  if (num === 1) return 'UP';
  if (num === 2) return 'DOWN';
  if (num === 6) return 'DISABLED';
  return 'UNKNOWN';
}

function formatMac(value: string | number | Uint8Array): string {
  if (typeof value === 'string') return value.toUpperCase();
  if (typeof value === 'number') return '';
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, '0').toUpperCase())
    .join(':');
}

function parseSpeed(value: unknown): number {
  const num = numericValue(value);
  return Math.max(0, num || 0);
}

export class SnmpV2cDiscoveryAdapter implements TopologyDiscoveryAdapter {
  readonly kind = 'LLDP_SNMP' as const;
  private readonly client: SnmpClientImpl;

  constructor(private readonly repository: HostRepository) {
    this.client = new SnmpClientImpl(3000, 1);
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
      const hostname = decodeSnmpText(byOid.get(SYSTEM_OIDS.sysName));
      const systemDescription = decodeSnmpText(byOid.get(SYSTEM_OIDS.sysDescription));
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
      const indices = await this.walk(hostRecord, IF_MIB_OIDS.ifIndex, snmpCommunity);
      if (!indices.length) return [];

      const names = await this.safeWalk(hostRecord, IF_MIB_OIDS.ifName, snmpCommunity);
      const descrs = await this.safeWalk(hostRecord, IF_MIB_OIDS.ifDescr, snmpCommunity);
      const adminStates = await this.safeWalk(hostRecord, IF_MIB_OIDS.ifAdminStatus, snmpCommunity);
      const operStates = await this.safeWalk(hostRecord, IF_MIB_OIDS.ifOperStatus, snmpCommunity);
      const highSpeeds = await this.safeWalk(hostRecord, IF_MIB_OIDS.ifHighSpeed, snmpCommunity);
      const speeds = await this.safeWalk(hostRecord, IF_MIB_OIDS.ifSpeed, snmpCommunity);
      const aliases = await this.safeWalk(hostRecord, IF_MIB_OIDS.ifAlias, snmpCommunity);
      const physAddrs = await this.safeWalk(hostRecord, IF_MIB_OIDS.ifPhysAddress, snmpCommunity);

      // Huawei exposes optical DDM through HUAWEI-ENTITY-EXTENT-MIB. The index
      // is entPhysicalIndex, so correlate it to the IF-MIB interface by
      // entPhysicalName. Unsupported devices simply return no optical data.
      const opticalByName = await this.collectOpticalByInterfaceName(hostRecord, snmpCommunity);

      const descByIndex = this.indexMap(descrs, IF_MIB_OIDS.ifDescr);
      const speedByIndex = this.indexMap(speeds, IF_MIB_OIDS.ifSpeed);
      const macByIndex = this.indexMap(physAddrs, IF_MIB_OIDS.ifPhysAddress);
      const adminByIndex = this.indexMap(adminStates, IF_MIB_OIDS.ifAdminStatus);
      const operByIndex = this.indexMap(operStates, IF_MIB_OIDS.ifOperStatus);
      const nameByIndex = this.indexMap(names, IF_MIB_OIDS.ifName);
      const highSpeedByIndex = this.indexMap(highSpeeds, IF_MIB_OIDS.ifHighSpeed);
      const aliasByIndex = this.indexMap(aliases, IF_MIB_OIDS.ifAlias);
      const now = new Date().toISOString();

      return indices.flatMap((indexVb) => {
        const ifIndex = parseInt(decodeSnmpText(indexVb.value), 10);
        if (!Number.isInteger(ifIndex) || ifIndex <= 0) return [];
        const suffix = String(ifIndex);
        const description = decodeSnmpText(descByIndex.get(suffix));
        const discoveredName = decodeSnmpText(nameByIndex.get(suffix));
        const name = discoveredName || description || `if${ifIndex}`;
        const alias = decodeSnmpText(aliasByIndex.get(suffix));
        const mac = formatMac(macByIndex.get(suffix) ?? '');
        const adminStatus = normalizeAdminStatus(adminByIndex.get(suffix));
        const operStatus = normalizeOperStatus(operByIndex.get(suffix));
        const highSpeedMbps = parseSpeed(highSpeedByIndex.get(suffix));
        const speedBps = highSpeedMbps > 0
          ? highSpeedMbps * 1_000_000
          : parseSpeed(speedByIndex.get(suffix) ?? 0);
        const optical = [...interfaceNameKeys(name), ...interfaceNameKeys(description)]
          .map((key) => opticalByName.get(key))
          .find(Boolean);

        return [{
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
          ...this.snmpOpticalFields(optical, now),
          dataSources: ['SNMP'],
        } satisfies NetworkInterface];
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

  async enrichOpticalPower(
    device: HostRecord,
    interfaces: NetworkInterface[],
    community?: string,
  ): Promise<NetworkInterface[]> {
    if (!device.snmp?.host || !device.snmp.port) return interfaces;
    const snmpCommunity = community ?? (await this.getSnmpCommunity(device.id));
    if (!snmpCommunity) return interfaces;
    const readings = await this.collectOpticalByInterfaceName(device, snmpCommunity);
    const now = new Date().toISOString();

    return interfaces.map((networkInterface) => {
      const reading = [...interfaceNameKeys(networkInterface.name), ...interfaceNameKeys(networkInterface.description)]
        .map((key) => readings.get(key))
        .find(Boolean);
      if (!reading) return networkInterface;
      return {
        ...networkInterface,
        ...this.snmpOpticalFields(reading, now),
      };
    });
  }

  private async collectOpticalByInterfaceName(
    host: HostRecord,
    community: string,
  ): Promise<Map<string, OpticalReading>> {
    const [names, scalarRx, scalarTx, laneBias, laneRx, laneTx] = await Promise.all([
      this.safeWalk(host, ENTITY_MIB_OIDS.physicalName, community),
      this.safeWalk(host, HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS.rxPowerUw, community),
      this.safeWalk(host, HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS.txPowerUw, community),
      this.safeWalk(host, HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS.biasCurrentByLane, community),
      this.safeWalk(host, HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS.rxPowerByLane, community),
      this.safeWalk(host, HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS.txPowerByLane, community),
    ]);
    return this.opticalByInterfaceName(names, scalarRx, scalarTx, laneBias, laneRx, laneTx);
  }

  private snmpOpticalFields(
    reading: OpticalReading | undefined,
    timestamp: string,
  ): Partial<NetworkInterface> {
    if (!reading) return {};
    const hasScalar = reading.rxPowerDbm !== null || reading.txPowerDbm !== null;
    const hasLanes = reading.opticalLanes.length > 0;
    return {
      ...(hasScalar ? {
        rxPowerDbm: reading.rxPowerDbm,
        txPowerDbm: reading.txPowerDbm,
        opticalSource: 'SNMP' as const,
        opticalUpdatedAt: timestamp,
      } : {}),
      ...(hasLanes ? {
        opticalLanes: reading.opticalLanes,
        opticalLaneSource: 'SNMP' as const,
        opticalLanesUpdatedAt: timestamp,
      } : {}),
    };
  }

  private walk(host: HostRecord, oid: string, community: string): Promise<VarBind[]> {
    return this.client.walk(host.snmp!.host, oid, {
      community,
      version: 'v2c',
      port: host.snmp!.port,
    });
  }

  private async safeWalk(host: HostRecord, oid: string, community: string): Promise<VarBind[]> {
    try {
      return await this.walk(host, oid, community);
    } catch {
      return [];
    }
  }

  private indexMap(varbinds: VarBind[], baseOid: string): Map<string, string | number | Uint8Array> {
    const map = new Map<string, string | number | Uint8Array>();
    for (const varbind of varbinds) {
      const suffix = getOidSuffix(varbind.oid, baseOid);
      if (suffix) map.set(suffix, varbind.value);
    }
    return map;
  }

  private opticalByInterfaceName(
    names: VarBind[],
    scalarRxValues: VarBind[],
    scalarTxValues: VarBind[],
    laneBiasValues: VarBind[],
    laneRxValues: VarBind[],
    laneTxValues: VarBind[],
  ): Map<string, OpticalReading> {
    const namesByIndex = this.indexMap(names, ENTITY_MIB_OIDS.physicalName);
    const scalarRxByIndex = this.indexMap(
      scalarRxValues,
      HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS.rxPowerUw,
    );
    const scalarTxByIndex = this.indexMap(
      scalarTxValues,
      HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS.txPowerUw,
    );
    const laneBiasByIndex = this.indexMap(
      laneBiasValues,
      HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS.biasCurrentByLane,
    );
    const laneRxByIndex = this.indexMap(
      laneRxValues,
      HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS.rxPowerByLane,
    );
    const laneTxByIndex = this.indexMap(
      laneTxValues,
      HUAWEI_ENTITY_EXTENT_OPTICAL_OIDS.txPowerByLane,
    );
    const result = new Map<string, OpticalReading>();
    for (const [index, rawName] of namesByIndex) {
      const rxPowerDbm = microWattsToDbm(scalarRxByIndex.get(index));
      const txPowerDbm = microWattsToDbm(scalarTxByIndex.get(index));
      const opticalLanes = parseHuaweiOpticalLaneCsv(
        laneRxByIndex.get(index),
        laneTxByIndex.get(index),
        laneBiasByIndex.get(index),
      );
      if (rxPowerDbm === null && txPowerDbm === null && opticalLanes.length === 0) continue;
      for (const key of interfaceNameKeys(decodeSnmpText(rawName))) {
        result.set(key, { rxPowerDbm, txPowerDbm, opticalLanes });
      }
    }
    return result;
  }

  private async getSnmpCommunity(deviceId: string): Promise<string | null> {
    const credentials = await this.repository.getDecryptedSnmpCredentials(deviceId);
    return credentials?.community ?? null;
  }
}
