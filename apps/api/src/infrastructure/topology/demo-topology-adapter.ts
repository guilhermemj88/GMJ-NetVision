import type { Device, DiscoveredNeighbor, NetworkInterface } from '@gmj/shared';
import type { DeviceIdentity, TopologyDiscoveryAdapter } from '../../domain/ports';

/**
 * Fibra sintetica usada apenas em DEMO_MODE. Nunca toca equipamento real.
 *
 * Cada entrada e [portaLocal, hostnameRemoto, portaRemota]. Adjacencias
 * reciprocas (os dois lados apontando um para o outro na mesma porta) chegam
 * como CONFIRMED; um lado sozinho fica PROBABLE; vizinho fora do inventario
 * fica UNKNOWN_NEIGHBOR. Assim o fluxo automatico tem material real para
 * homologar os tres estados.
 */
const DEMO_FABRIC: Record<string, ReadonlyArray<readonly [string, string, string]>> = {
  'core-01': [
    ['100GE1/0/1', 'agg-centro-01', '100GE1/0/1'],
    ['100GE1/0/2', 'bgp-edge-01', '100GE1/0/1'],
    ['10GE1/0/3', 'SW-FORA-DO-INVENTARIO', 'XGE0/0/1'],
  ],
  'agg-centro': [
    ['100GE1/0/1', 'core-bh-01', '100GE1/0/1'],
    ['100GE1/0/2', 'agg-norte-01', '100GE1/0/1'],
  ],
  'edge-01': [['100GE1/0/1', 'core-bh-01', '100GE1/0/2']],
};

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
    const entries = DEMO_FABRIC[device.id] ?? [];
    return entries.map(([localPort, remoteSystemName, remotePort], index) => ({
      id: `demo-discovery-${device.id}-${index}`,
      localDeviceId: device.id,
      localPort,
      remoteSystemName,
      remotePort,
      capabilities: ['bridge', 'router'],
      source: 'LLDP_SNMP' as const,
      matchStatus: 'UNMATCHED' as const,
    }));
  }
}