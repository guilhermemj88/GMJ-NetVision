import type { Device, DiscoveredNeighbor, NetworkInterface } from '@gmj/shared';
import type {
  DeviceIdentity,
  SshClient,
  SshDeviceDriver,
  TopologyDiscoveryAdapter,
} from '../../domain/ports';

export class LldpSshDiscoveryAdapter implements TopologyDiscoveryAdapter {
  readonly kind = 'LLDP_SSH' as const;

  constructor(
    private readonly client: SshClient,
    private readonly drivers: SshDeviceDriver[],
  ) {}

  private driverFor(device: Pick<Device, 'vendor'>): SshDeviceDriver {
    const driver = this.drivers.find((candidate) =>
      device.vendor.toLowerCase().includes(candidate.vendor.split(' ')[0]?.toLowerCase() ?? ''),
    );
    if (!driver) throw new Error(`No SSH driver configured for vendor ${device.vendor}`);
    return driver;
  }

  async discoverDevice(host: string): Promise<DeviceIdentity> {
    return this.getDeviceIdentity(host);
  }

  async getDeviceIdentity(host: string): Promise<DeviceIdentity> {
    const driver = this.drivers[0];
    if (!driver) throw new Error('No SSH device driver configured');
    const results = await this.client.execute(host, driver.identityCommands());
    return driver.parseIdentity(results.map((result) => result.stdout).join('\n'));
  }

  async discoverNeighbors(device: Device): Promise<DiscoveredNeighbor[]> {
    const driver = this.driverFor(device);
    const results = await this.client.execute(device.ip, driver.neighborCommands());
    return driver.parseNeighbors(device.id, results.map((result) => result.stdout).join('\n'));
  }

  async discoverInterfaces(device: Device): Promise<NetworkInterface[]> {
    const driver = this.driverFor(device);
    const results = await this.client.execute(device.ip, driver.interfaceCommands());
    return driver.parseInterfaces(device.id, results.map((result) => result.stdout).join('\n'));
  }
}
