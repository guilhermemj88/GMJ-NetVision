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
      id: '',
      name: '',
      hostname: host,
      ip: host,
      vendor: '',
      model: '',
      status: 'UNKNOWN',
      deviceType: 'generic',
      site: '',
      source: 'ZABBIX',
      discoveryMethod: 'SSH',
      uptimeSeconds: 0,
      pppSupported: false,
      pppOnline: 0,
      pppUpdatedAt: null,
      pppSource: null,
      updatedAt: '',
      interfaces: [],
    };
  }

  private driverFor(device: Pick<Device, 'vendor'>): SshDeviceDriver {
    const vendor = device.vendor.trim().toLowerCase();
    const driver = this.drivers.find((candidate) =>
      vendor.includes(candidate.vendor.split(' ')[0]?.toLowerCase() ?? ''),
    );
    if (driver) return driver;

    // Inventory imported before vendor enrichment commonly has an empty or
    // unknown vendor. The legacy behaviour is preserved: a registered Huawei
    // driver still serves those hosts, and with a single driver there is no
    // ambiguity. A KNOWN third-party vendor still fails closed instead of
    // receiving VRP commands.
    if (!vendor || vendor === 'unknown') {
      const legacyHuawei = this.drivers.find(
        (candidate) => candidate.vendor.split(' ')[0]?.toLowerCase() === 'huawei',
      );
      if (legacyHuawei) return legacyHuawei;
      if (this.drivers.length === 1) return this.drivers[0]!;
    }
    throw new Error(`No SSH driver configured for vendor ${device.vendor || 'unknown'}`);
  }

  /**
   * Identity discovery recebe apenas um host, sem vendor: com mais de um
   * driver nao ha como escolher sem risco de mandar comando VRP para um Junos
   * (ou o contrario). Nesse caso falha fechado.
   */
  private identityDriver(): SshDeviceDriver {
    if (this.drivers.length === 1) return this.drivers[0]!;
    throw new Error('SSH identity discovery requires a vendor-scoped driver');
  }

  private stdout(results: Awaited<ReturnType<SshClient['execute']>>): string {
    return results.map((result) => result.stdout).join('\n');
  }

  async discoverDevice(host: string): Promise<DeviceIdentity> {
    return this.getDeviceIdentity(host);
  }

  async getDeviceIdentity(host: string): Promise<DeviceIdentity> {
    const driver = this.identityDriver();
    const { client, host: targetHost } = await this.session(this.deviceForHost(host));
    const results = await client.execute(targetHost, driver.identityCommands());
    return driver.parseIdentity(results.map((result) => result.stdout).join('\n'));
  }

  async discoverNeighbors(device: Device): Promise<DiscoveredNeighbor[]> {
    const driver = this.driverFor(device);
    const { client, host } = await this.session(device);
    const results = await client.execute(host, driver.neighborCommands());
    const output = this.stdout(results);
    const neighbors = driver.parseNeighbors(device.id, output);
    if (neighbors.length > 0) return neighbors;

    const fallbackCommands = driver.neighborFallbackCommands?.();
    if (!fallbackCommands?.length) return neighbors;
    const diagnosticOutput = results
      .map((result) => `${result.stdout}\n${result.stderr}`)
      .join('\n');
    const commandFailed = results.some((result) => result.exitCode !== 0);
    const shouldFallback =
      commandFailed || (driver.shouldFallbackNeighborCommand?.(diagnosticOutput) ?? true);
    if (!shouldFallback) return neighbors;

    const fallbackResults = await client.execute(host, fallbackCommands);
    return driver.parseNeighbors(device.id, this.stdout(fallbackResults));
  }

  async discoverInterfaces(device: Device): Promise<NetworkInterface[]> {
    const driver = this.driverFor(device);
    const { client, host } = await this.session(device);
    const results = await client.execute(host, driver.interfaceCommands());
    return driver.parseInterfaces(device.id, results.map((result) => result.stdout).join('\n'));
  }
}
