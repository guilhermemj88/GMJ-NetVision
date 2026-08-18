import type { Device, DiscoveredNeighbor, NetworkInterface } from '@gmj/shared';
import type {
  DeviceIdentity,
  LldpSnmpTarget,
  LldpSnmpTargetProvider,
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
  localPortIdSubtype: '1.0.8802.1.1.2.1.3.7.1.2',
  localPortId: '1.0.8802.1.1.2.1.3.7.1.3',
  localPortDescription: '1.0.8802.1.1.2.1.3.7.1.4',
  remoteManAddr: '1.0.8802.1.1.2.1.4.2.1.2',
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

/**
 * Decodes the management address table (lldpRemManAddrTable).
 *
 * The address is encoded in the OID index after
 * timeMark.localPortNum.remoteIndex.subtype, so the remaining octets are
 * decoded by InetAddressType. Only IPv4 (subtype 1) is currently supported;
 * other subtypes (IPv6, DNS, ...) are ignored safely. The address octets are
 * never reinterpreted as ASCII from the value bytes.
 */
function managementAddressByIndex(values: SnmpVarBind[], base: string): Map<string, string> {
  const byKey = new Map<string, string[]>();
  for (const item of values) {
    const suffix = indexSuffix(item.oid, base);
    const parts = suffix.split('.');
    // timeMark(0) . localPortNum(1) . remoteIndex(2) . subtype(3) . address...
    const key = `${parts[0] ?? ''}.${parts[1] ?? ''}.${parts[2] ?? ''}`;
    const subtype = Number(parts[3]);
    const addressParts = parts.slice(4);
    if (subtype !== 1 || addressParts.length < 4) continue;
    const address = addressParts.slice(0, 4).join('.');
    byKey.set(key, [...(byKey.get(key) ?? []), address]);
  }
  // Multiple management addresses may exist (IPv4 + IPv6, loopbacks, ...).
  // Keep the first IPv4 address; other subtypes are intentionally skipped.
  const result = new Map<string, string>();
  for (const [key, addresses] of byKey) {
    if (addresses[0]) result.set(key, addresses[0]);
  }
  return result;
}

export class LldpSnmpDiscoveryAdapter implements TopologyDiscoveryAdapter {
  readonly kind = 'LLDP_SNMP' as const;

  constructor(
    private readonly client: SnmpClient,
    private readonly targetProvider?: LldpSnmpTargetProvider,
  ) {}

  private async resolveTarget(device: Device): Promise<LldpSnmpTarget> {
    if (this.targetProvider) return this.targetProvider.resolve(device);
    return { host: device.ip, port: 161, community: 'public' };
  }

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
    const target = await this.resolveTarget(device);
    const options = { community: target.community, version: 'v2c' as const, port: target.port };
    const [names, chassis, remotePorts, remoteDescriptions, systemDescriptions, localPortIds, localPortIdSubtypes, localPortDescriptions, manAddrs] =
      await Promise.all([
        this.client.walk(target.host, LLDP_OIDS.remoteSystemName, options),
        this.client.walk(target.host, LLDP_OIDS.remoteChassisId, options),
        this.client.walk(target.host, LLDP_OIDS.remotePortId, options),
        this.client.walk(target.host, LLDP_OIDS.remotePortDescription, options),
        this.client.walk(target.host, LLDP_OIDS.remoteSystemDescription, options),
        this.client.walk(target.host, LLDP_OIDS.localPortId, options),
        this.client.walk(target.host, LLDP_OIDS.localPortIdSubtype, options),
        this.client.walk(target.host, LLDP_OIDS.localPortDescription, options),
        this.client.walk(target.host, LLDP_OIDS.remoteManAddr, options),
      ]);

    const chassisByIndex = indexed(chassis, LLDP_OIDS.remoteChassisId);
    const portsByIndex = indexed(remotePorts, LLDP_OIDS.remotePortId);
    const descriptionsByIndex = indexed(remoteDescriptions, LLDP_OIDS.remotePortDescription);
    const systemsByIndex = indexed(systemDescriptions, LLDP_OIDS.remoteSystemDescription);
    const localById = indexed(localPortIds, LLDP_OIDS.localPortId);
    const localSubtypeByNum = indexed(localPortIdSubtypes, LLDP_OIDS.localPortIdSubtype);
    const localDescriptionByNum = indexed(localPortDescriptions, LLDP_OIDS.localPortDescription);
    const manAddrByIndex = managementAddressByIndex(manAddrs, LLDP_OIDS.remoteManAddr);

    return names.map((item, row) => {
      const suffix = indexSuffix(item.oid, LLDP_OIDS.remoteSystemName);
      // Remote table index: timeMark.localPortNum.remoteIndex.
      const localPortNum = suffix.split('.')[1] ?? '';
      const remoteChassisId = chassisByIndex.get(suffix);
      const remotePortDescription = descriptionsByIndex.get(suffix);
      const systemDescription = systemsByIndex.get(suffix);
      // The local port id is interpreted by the correlation layer according to
      // lldpLocPortIdSubtype. Never fabricate an ifIndex from the table index.
      const localPort = localById.get(localPortNum)
        || localDescriptionByNum.get(localPortNum)
        || `port ${localPortNum}`;
      const localPortIdSubtype = Number(localSubtypeByNum.get(localPortNum) ?? '');
      const localMac = localPortIdSubtype === 3 ? localById.get(localPortNum) : undefined;
      const remoteManagementAddress = manAddrByIndex.get(suffix);
      return {
        id: `snmp-${device.id}-${row}-${suffix}`,
        localDeviceId: device.id,
        localPort,
        ...(Number.isInteger(localPortIdSubtype) && localPortIdSubtype >= 0
          ? { localPortSubtype: localPortIdSubtype }
          : {}),
        ...(localMac ? { localMac } : {}),
        remoteSystemName: printable(item.value) || remoteChassisId || 'Unknown neighbor',
        ...(remoteChassisId ? { remoteChassisId } : {}),
        ...(remoteManagementAddress ? { remoteManagementAddress } : {}),
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
