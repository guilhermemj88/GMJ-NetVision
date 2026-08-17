import type { HostRecord, NetworkInterface, SourceConnectionState } from '@gmj/shared';
import type { HostRepository } from '../persistence/host-repository';
import { HuaweiVrpDriver } from '../topology/huawei-vrp-driver';
import { mergeSnmpAndSshInterfaces } from '../topology/interface-correlation';
import { SshClientImpl } from './ssh-client-impl';

export class SshInterfaceService {
  constructor(private readonly repository: HostRepository) {}

  async testConnectivity(device: HostRecord): Promise<{
    state: Exclude<SourceConnectionState, 'CONFIGURED'>;
    message: string;
  }> {
    if (!device.sshEnabled || !device.ssh?.host) {
      return { state: 'DISABLED', message: 'SSH não está habilitado para este host' };
    }
    try {
      const interfaces = await this.discoverInterfaces(device);
      return interfaces.length
        ? { state: 'CONNECTED', message: `SSH Huawei respondeu com ${interfaces.length} interfaces` }
        : { state: 'FAILED', message: 'SSH respondeu, mas o comando Huawei não retornou interfaces válidas' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'SSH transport failed';
      if (message.toLowerCase().includes('authentication')) return { state: 'AUTH_INVALID', message };
      if (message.toLowerCase().includes('timeout')) return { state: 'TIMEOUT', message };
      if (message.toLowerCase().includes('unreachable')) return { state: 'UNREACHABLE', message };
      return { state: 'FAILED', message };
    }
  }

  async enrichInterfaces(
    device: HostRecord,
    snmpInterfaces: NetworkInterface[],
  ): Promise<NetworkInterface[]> {
    const sshInterfaces = await this.discoverInterfaces(device);
    if (!sshInterfaces.length) throw new Error('SSH Huawei returned no valid interface descriptions');
    return mergeSnmpAndSshInterfaces(snmpInterfaces, sshInterfaces);
  }

  private async discoverInterfaces(device: HostRecord): Promise<NetworkInterface[]> {
    if (!device.sshEnabled || !device.ssh?.host || !device.ssh.username) return [];
    if (!device.vendor.toLowerCase().includes('huawei')) {
      throw new Error(`SSH interface discovery is not supported for vendor ${device.vendor || 'unknown'}`);
    }
    const credentials = await this.repository.getDecryptedSshCredentials(device.id);
    if (!credentials?.password) throw new Error('SSH credential not configured');

    const driver = new HuaweiVrpDriver();
    const client = new SshClientImpl({
      port: device.ssh.port,
      username: device.ssh.username,
      password: credentials.password,
    });
    const results = await client.execute(device.ssh.host, driver.interfaceCommands());
    const commandResult = results.at(-1);
    if (!commandResult || commandResult.exitCode !== 0) throw new Error('Huawei SSH command failed');
    return driver.parseInterfaces(device.id, commandResult.stdout);
  }
}
