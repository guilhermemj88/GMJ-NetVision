import type { HostRecord, NetworkInterface, SourceConnectionState } from '@gmj/shared';
import type { HostRepository } from '../persistence/host-repository';
import { HuaweiVrpDriver } from '../topology/huawei-vrp-driver';
import { interfaceNameKeys, mergeSnmpAndSshInterfaces } from '../topology/interface-correlation';
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
        ? { state: 'CONNECTED', message: `SSH respondeu ao display interface description com ${interfaces.length} interfaces` }
        : { state: 'FAILED', message: 'SSH respondeu, mas display interface description não retornou interfaces válidas' };
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
    if (!sshInterfaces.length) throw new Error('SSH display interface description returned no valid interfaces');
    const merged = mergeSnmpAndSshInterfaces(snmpInterfaces, sshInterfaces);

    // Fallback is evaluated per interface. SNMP data on one port must not stop
    // SSH from filling a different port that has no DDM through SNMP.
    return this.enrichOpticalPower(device, merged);
  }

  async enrichOpticalPower(
    device: HostRecord,
    interfaces: NetworkInterface[],
    snmpFreshAfter?: Date,
  ): Promise<NetworkInterface[]> {
    const needsFallback = interfaces.some((networkInterface) => {
      const hasSnmpPower = networkInterface.opticalSource === 'SNMP'
        && (networkInterface.rxPowerDbm != null || networkInterface.txPowerDbm != null);
      const hasLaneData = (networkInterface.opticalLanes?.length ?? 0) > 1;
      if (hasLaneData) return false;
      if (!hasSnmpPower) return true;
      if (!snmpFreshAfter) return false;
      return !networkInterface.opticalUpdatedAt
        || new Date(networkInterface.opticalUpdatedAt) < snmpFreshAfter;
    });
    if (!needsFallback) return interfaces;
    if (!device.sshEnabled || !device.ssh?.host || !device.ssh.username) return interfaces;
    const credentials = await this.repository.getDecryptedSshCredentials(device.id);
    if (!credentials?.password) throw new Error('SSH credential not configured');

    const driver = new HuaweiVrpDriver();
    const client = new SshClientImpl({
      port: device.ssh.port,
      username: device.ssh.username,
      password: credentials.password,
    });
    const results = await client.execute(device.ssh.host, driver.opticalCommands());
    const commandResult = results.at(-1);
    if (!commandResult || commandResult.exitCode !== 0) throw new Error('Huawei optical SSH command failed');
    const readings = driver.parseOpticalPower(commandResult.stdout);
    if (!readings.length) return interfaces;

    const byName = new Map(readings.flatMap((reading) =>
      interfaceNameKeys(reading.name).map((key) => [key, reading] as const),
    ));
    const now = new Date().toISOString();
    return interfaces.map((networkInterface) => {
      const hasSnmpPower = networkInterface.opticalSource === 'SNMP'
        && (networkInterface.rxPowerDbm != null || networkInterface.txPowerDbm != null);
      const snmpUpdatedAt = networkInterface.opticalUpdatedAt
        ? new Date(networkInterface.opticalUpdatedAt)
        : null;
      const reading = [...interfaceNameKeys(networkInterface.name), ...interfaceNameKeys(networkInterface.description)]
        .map((key) => byName.get(key))
        .find(Boolean);
      if (!reading) return networkInterface;

      const shouldKeepFreshSnmpScalar = hasSnmpPower
        && (!snmpFreshAfter || (snmpUpdatedAt && snmpUpdatedAt >= snmpFreshAfter));
      return {
        ...networkInterface,
        rxPowerDbm: shouldKeepFreshSnmpScalar ? networkInterface.rxPowerDbm : reading.rxPowerDbm,
        txPowerDbm: shouldKeepFreshSnmpScalar ? networkInterface.txPowerDbm : reading.txPowerDbm,
        opticalLanes: reading.opticalLanes.length ? reading.opticalLanes : networkInterface.opticalLanes,
        opticalSource: reading.opticalLanes.length ? 'SSH' : shouldKeepFreshSnmpScalar ? 'SNMP' : 'SSH',
        opticalUpdatedAt: now,
        dataSources: [...new Set([...(networkInterface.dataSources ?? ['SNMP']), 'SSH' as const])],
      };
    });
  }

  private async discoverInterfaces(device: HostRecord): Promise<NetworkInterface[]> {
    if (!device.sshEnabled || !device.ssh?.host || !device.ssh.username) return [];
    const credentials = await this.repository.getDecryptedSshCredentials(device.id);
    if (!credentials?.password) throw new Error('SSH credential not configured');

    // Many imported hosts have vendor empty/unknown even when the target is
    // Huawei VRP. Do not block the explicit SSH test based on inventory metadata.
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