import type { HostRecord, NetworkInterface, SourceConnectionState } from '@gmj/shared';
import type { HostRepository } from '../persistence/host-repository';
import {
  HuaweiVrpDriver,
  huaweiMultiLaneInterfaceName,
} from '../topology/huawei-vrp-driver';
import { interfaceNameKeys, mergeSnmpAndSshInterfaces } from '../topology/interface-correlation';
import { SshClientImpl } from './ssh-client-impl';

function hasValidLaneData(networkInterface: NetworkInterface): boolean {
  const lanes = networkInterface.opticalLanes ?? [];
  return lanes.length > 1 && lanes.some((lane) =>
    lane.rxPowerDbm != null || lane.txPowerDbm != null || lane.biasCurrentMa != null
  );
}

function hasFreshLaneData(
  networkInterface: NetworkInterface,
  collectedAfter?: Date,
): boolean {
  if (!hasValidLaneData(networkInterface)) return false;
  if (!collectedAfter) return true;
  if (!networkInterface.opticalLanesUpdatedAt) return false;
  const updatedAt = new Date(networkInterface.opticalLanesUpdatedAt);
  return Number.isFinite(updatedAt.getTime()) && updatedAt >= collectedAfter;
}

function hasFreshSnmpPower(
  networkInterface: NetworkInterface,
  snmpFreshAfter?: Date,
): boolean {
  const hasSnmpPower = networkInterface.opticalSource === 'SNMP'
    && (networkInterface.rxPowerDbm != null || networkInterface.txPowerDbm != null);
  if (!hasSnmpPower) return false;
  if (!snmpFreshAfter) return true;
  if (!networkInterface.opticalUpdatedAt) return false;
  const updatedAt = new Date(networkInterface.opticalUpdatedAt);
  return Number.isFinite(updatedAt.getTime()) && updatedAt >= snmpFreshAfter;
}

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
    // SNMP freshness controls only scalar RX/TX replacement. Missing lanes on a
    // Huawei 40GE/100GE port independently require the per-interface SSH query.
    const multiLaneCandidates = interfaces.filter((networkInterface) =>
      huaweiMultiLaneInterfaceName(networkInterface.name) !== null
      && !hasFreshLaneData(networkInterface, snmpFreshAfter)
    );
    const needsScalarFallback = interfaces.some((networkInterface) =>
      !hasFreshSnmpPower(networkInterface, snmpFreshAfter)
    );
    if (!needsScalarFallback && !multiLaneCandidates.length) return interfaces;
    if (!device.sshEnabled || !device.ssh?.host || !device.ssh.username) return interfaces;
    const credentials = await this.repository.getDecryptedSshCredentials(device.id);
    if (!credentials?.password) return interfaces;

    const driver = new HuaweiVrpDriver();
    const client = new SshClientImpl({
      port: device.ssh.port,
      username: device.ssh.username,
      password: credentials.password,
    });
    const commands = driver.opticalEnrichmentCommands(
      multiLaneCandidates.map((networkInterface) => networkInterface.name),
      needsScalarFallback,
    );
    let results;
    try {
      results = await client.execute(device.ssh.host, commands);
    } catch {
      return interfaces;
    }
    const commandResult = results.at(-1);
    if (!commandResult || commandResult.exitCode !== 0) return interfaces;
    const readings = driver.parseOpticalPower(commandResult.stdout);
    if (!readings.length) return interfaces;

    const byName = new Map(readings.flatMap((reading) =>
      interfaceNameKeys(reading.name).map((key) => [key, reading] as const),
    ));
    const now = new Date().toISOString();
    return interfaces.map((networkInterface) => {
      const keepFreshSnmpPower = hasFreshSnmpPower(networkInterface, snmpFreshAfter);
      const reading = [...interfaceNameKeys(networkInterface.name), ...interfaceNameKeys(networkInterface.description)]
        .map((key) => byName.get(key))
        .find(Boolean);
      if (!reading) return networkInterface;

      const keepSnmpRx = keepFreshSnmpPower && networkInterface.rxPowerDbm != null;
      const keepSnmpTx = keepFreshSnmpPower && networkInterface.txPowerDbm != null;
      const usedSshScalar = (!keepSnmpRx && reading.rxPowerDbm != null)
        || (!keepSnmpTx && reading.txPowerDbm != null);
      const usedSshLanes = reading.opticalLanes.length > 0;
      if (!usedSshScalar && !usedSshLanes) return networkInterface;
      const opticalSource = keepFreshSnmpPower
        ? 'SNMP' as const
        : usedSshScalar
          ? 'SSH' as const
          : networkInterface.opticalSource;
      return {
        ...networkInterface,
        rxPowerDbm: keepSnmpRx ? networkInterface.rxPowerDbm : reading.rxPowerDbm,
        txPowerDbm: keepSnmpTx ? networkInterface.txPowerDbm : reading.txPowerDbm,
        opticalLanes: usedSshLanes ? reading.opticalLanes : networkInterface.opticalLanes,
        ...(usedSshLanes ? {
          opticalLaneSource: 'SSH' as const,
          opticalLanesUpdatedAt: now,
        } : {}),
        ...(opticalSource === undefined ? {} : { opticalSource }),
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
