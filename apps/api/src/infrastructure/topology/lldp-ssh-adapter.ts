import type { Device, DiscoveredNeighbor, NetworkInterface } from '@gmj/shared';
import type {
  DeviceIdentity,
  LldpSshSession,
  LldpSshSessionFactory,
  SshClient,
  SshDeviceDriver,
  TopologyDiscoveryAdapter,
} from '../../domain/ports';

export class LldpSshDiscoveryAdapter implements TopologyDiscoveryAdapter {
  readonly kind = 'LLDP_SSH' as const;

  constructor(
    private readonly drivers: SshDeviceDriver[],
    private readonly sessionFactory?: LldpSshSessionFactory,
    private readonly client?: SshClient,
  ) {}

  private async session(device: Device): Promise<LldpSshSession> {
    if (this.sessionFactory) return this.sessionFactory.open(device);
    if (this.client) return { client: this.client, host: device.ip };
    throw new Error('No SSH transport configured');
  }

  private deviceForHost(host: string): Device {
    return {
      id: '', name: '', hostname: host, ip: host, vendor: '', model: '',
      status: 'UNKNOWN', deviceType: 'generic', site: '', source: 'ZABBIX',
      discoveryMethod: 'SSH', uptimeSeconds: 0, updatedAt: '', interfaces: [],
    };
  }

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
    const { client, host: targetHost } = await this.session(this.deviceForHost(host));
    const results = await client.execute(targetHost, driver.identityCommands());
    return driver.parseIdentity(results.map((result) => result.stdout).join('\n'));
  }

  async discoverNeighbors(device: Device): Promise<DiscoveredNeighbor[]> {
    const driver = this.driverFor(device);
    const { client, host } = await this.session(device);
    const results = await client.execute(host, driver.neighborCommands());
    return driver.parseNeighbors(device.id, results.map((result) => result.stdout).join('\n'));
  }

  async discoverInterfaces(device: Device): Promise<NetworkInterface[]> {
    const driver = this.driverFor(device);
    const { client, host } = await this.session(device);
    const results = await client.execute(host, driver.interfaceCommands());
    return driver.parseInterfaces(device.id, results.map((result) => result.stdout).join('\n'));
  }
}
