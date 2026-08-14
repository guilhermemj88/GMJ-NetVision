import type { Device, DiscoveredNeighbor, NetworkInterface } from '@gmj/shared';
import type {
  DeviceIdentity,
  SnmpClient,
  SnmpVarBind,
  TopologyDiscoveryAdapter,
} from '../../domain/ports';

// Standard LLDP-MIB objects. OIDs never leave this adapter.
export const LLDP_OIDS = {
  sysName: '1.3.6.1.2.1.1.5.0',
  sysDescription: '1.3.6.1.2.1.1.1.0',
  remoteChassisId: '1.0.8802.1.1.2.1.4.1.1.5',
  remotePortId: '1.0.8802.1.1.2.1.4.1.1.7',
  remotePortDescription: '1.0.8802.1.1.2.1.4.1.1.8',
  remoteSystemName: '1.0.8802.1.1.2.1.4.1.1.9',
  remoteSystemDescription: '1.0.8802.1.1.2.1.4.1.1.10',
  remoteCapabilities: '1.0.8802.1.1.2.1.4.1.1.12',
  localPortDescription: '1.0.8802.1.1.2.1.3.7.1.4',
} as const;

function printable(value: SnmpVarBind['value']): string {
  if (value instanceof Uint8Array)
    return new TextDecoder().decode(value).replaceAll('\0', '').trim();
  return String(value).trim();
}

function indexSuffix(oid: string, base: string): string {
  return oid.slice(base.length).replace(/^\./, '');
}

function indexed(values: SnmpVarBind[], base: string): Map<string, string> {
  return new Map(values.map((item) => [indexSuffix(item.oid, base), printable(item.value)]));
}

export class LldpSnmpDiscoveryAdapter implements TopologyDiscoveryAdapter {
  readonly kind = 'LLDP_SNMP' as const;

  constructor(private readonly client: SnmpClient) {}

  async discoverDevice(host: string): Promise<DeviceIdentity> {
    return this.getDeviceIdentity(host);
  }

  async getDeviceIdentity(host: string): Promise<DeviceIdentity> {
    const values = await this.client.get(host, [LLDP_OIDS.sysName, LLDP_OIDS.sysDescription]);
    const byOid = new Map(values.map((item) => [item.oid, printable(item.value)]));
    const hostname = byOid.get(LLDP_OIDS.sysName);
    const systemDescription = byOid.get(LLDP_OIDS.sysDescription);
    return {
      ...(hostname ? { hostname } : {}),
      managementAddress: host,
      ...(systemDescription ? { systemDescription } : {}),
    };
  }

  async discoverNeighbors(device: Device): Promise<DiscoveredNeighbor[]> {
    const [names, chassis, remotePorts, remoteDescriptions, systemDescriptions, localPorts] =
      await Promise.all([
        this.client.walk(device.ip, LLDP_OIDS.remoteSystemName),
        this.client.walk(device.ip, LLDP_OIDS.remoteChassisId),
        this.client.walk(device.ip, LLDP_OIDS.remotePortId),
        this.client.walk(device.ip, LLDP_OIDS.remotePortDescription),
        this.client.walk(device.ip, LLDP_OIDS.remoteSystemDescription),
        this.client.walk(device.ip, LLDP_OIDS.localPortDescription),
      ]);

    const chassisByIndex = indexed(chassis, LLDP_OIDS.remoteChassisId);
    const portsByIndex = indexed(remotePorts, LLDP_OIDS.remotePortId);
    const descriptionsByIndex = indexed(remoteDescriptions, LLDP_OIDS.remotePortDescription);
    const systemsByIndex = indexed(systemDescriptions, LLDP_OIDS.remoteSystemDescription);
    const localByPort = indexed(localPorts, LLDP_OIDS.localPortDescription);

    return names.map((item, row) => {
      const suffix = indexSuffix(item.oid, LLDP_OIDS.remoteSystemName);
      // Remote table index: timeMark.localPortNum.remoteIndex.
      const localPortNum = suffix.split('.')[1] ?? '';
      const remoteChassisId = chassisByIndex.get(suffix);
      const remotePortDescription = descriptionsByIndex.get(suffix);
      const systemDescription = systemsByIndex.get(suffix);
      return {
        id: `snmp-${device.id}-${row}-${suffix}`,
        localDeviceId: device.id,
        localPort: localByPort.get(localPortNum) ?? `ifIndex ${localPortNum}`,
        remoteSystemName: printable(item.value) || remoteChassisId || 'Unknown neighbor',
        ...(remoteChassisId ? { remoteChassisId } : {}),
        remotePort: portsByIndex.get(suffix) ?? 'Unknown port',
        ...(remotePortDescription ? { remotePortDescription } : {}),
        ...(systemDescription ? { systemDescription } : {}),
        capabilities: [],
        source: 'LLDP_SNMP' as const,
        matchStatus: 'UNMATCHED' as const,
      };
    });
  }

  async discoverInterfaces(_device: Device): Promise<NetworkInterface[]> {
    // IF-MIB normalization belongs here; left empty until a concrete SNMP client is configured.
    return [];
  }
}
