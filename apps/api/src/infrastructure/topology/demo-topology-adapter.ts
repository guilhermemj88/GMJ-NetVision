import type { Device, DiscoveredNeighbor, NetworkInterface } from '@gmj/shared';
import type { DeviceIdentity, TopologyDiscoveryAdapter } from '../../domain/ports';

export class DemoTopologyAdapter implements TopologyDiscoveryAdapter {
  readonly kind = 'LLDP_SNMP' as const;

  async discoverDevice(host: string): Promise<DeviceIdentity> {
    return { hostname: host, managementAddress: host, vendor: 'Demo' };
  }

  async getDeviceIdentity(host: string): Promise<DeviceIdentity> {
    return this.discoverDevice(host);
  }

  async discoverInterfaces(device: Device): Promise<NetworkInterface[]> {
    return structuredClone(device.interfaces);
  }

  async discoverNeighbors(device: Device): Promise<DiscoveredNeighbor[]> {
    const names =
      device.id === 'core-01'
        ? [
            ['100GE1/0/1', 'AGG-CENTRO-01', '100GE1/0/48'],
            ['100GE1/0/2', 'BGP-EDGE-01', '100GE0/0/0'],
            ['10GE1/0/8', 'SW-UNKNOWN', 'XGE0/0/1'],
          ]
        : [
            [device.interfaces[0]?.name ?? 'GE0/0/1', 'CORE-BH-01', '100GE1/0/24'],
            [device.interfaces[1]?.name ?? 'GE0/0/2', 'NEW-ACCESS-01', 'GE0/0/48'],
          ];
    return names.map(([localPort, remoteSystemName, remotePort], index) => ({
      id: `demo-discovery-${device.id}-${index}`,
      localDeviceId: device.id,
      localPort: localPort ?? 'Unknown',
      remoteSystemName: remoteSystemName ?? 'Unknown',
      remotePort: remotePort ?? 'Unknown',
      capabilities: ['bridge', 'router'],
      source: 'LLDP_SNMP',
      matchStatus: 'UNMATCHED',
    }));
  }
}
