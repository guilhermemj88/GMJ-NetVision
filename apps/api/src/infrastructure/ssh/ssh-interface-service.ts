import type { HostRecord, NetworkInterface, SourceConnectionState } from '@gmj/shared';
import type { HostRepository } from '../persistence/host-repository';
import {
  type HuaweiOpticalReading,
  HuaweiVrpDriver,
  huaweiDiagnosisCommand,
  huaweiInterfaceTransceiverVerboseCommand,
  huaweiMultiLaneInterfaceName,
} from '../topology/huawei-vrp-driver';
import { hasHuaweiMultiLaneCapability } from '../topology/huawei-optical';
import { interfaceNameKeys, mergeSnmpAndSshInterfaces } from '../topology/interface-correlation';
import { SshClientImpl } from './ssh-client-impl';

function hasValidLaneData(networkInterface: NetworkInterface): boolean {
  return hasHuaweiMultiLaneCapability(networkInterface.opticalLanes);
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

function hasFreshOpticalPower(
  networkInterface: NetworkInterface,
  collectedAfter?: Date,
): boolean {
  const hasPower = networkInterface.rxPowerDbm != null || networkInterface.txPowerDbm != null;
  if (!hasPower) return false;
  if (!collectedAfter) return true;
  if (!networkInterface.opticalUpdatedAt) return false;
  const updatedAt = new Date(networkInterface.opticalUpdatedAt);
  return Number.isFinite(updatedAt.getTime()) && updatedAt >= collectedAfter;
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
    // Capability is evaluated per interface. Two fresh SNMP lanes suppress SSH,
    // while unresolved high-capacity ports proceed through the two CLI formats.
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
    let enriched = interfaces;

    if (multiLaneCandidates.length) {
      const diagnosisCommands = multiLaneCandidates.flatMap((networkInterface) => {
        const command = huaweiDiagnosisCommand(networkInterface.name);
        return command ? [command] : [];
      });
      const diagnosisReadings = await this.executeOpticalCommands(
        client,
        device.ssh.host,
        driver,
        diagnosisCommands,
      );
      enriched = this.applySshReadings(enriched, diagnosisReadings, snmpFreshAfter);

      const unresolvedIds = new Set(multiLaneCandidates.flatMap((candidate) => {
        const current = enriched.find((networkInterface) => networkInterface.id === candidate.id);
        return current && hasFreshLaneData(current, snmpFreshAfter) ? [] : [candidate.id];
      }));
      const verboseCommands = multiLaneCandidates.flatMap((networkInterface) => {
        if (!unresolvedIds.has(networkInterface.id)) return [];
        const command = huaweiInterfaceTransceiverVerboseCommand(networkInterface.name);
        return command ? [command] : [];
      });
      const verboseReadings = await this.executeOpticalCommands(
        client,
        device.ssh.host,
        driver,
        verboseCommands,
      );
      enriched = this.applySshReadings(enriched, verboseReadings, snmpFreshAfter);
    }

    // Preserve the existing chassis-wide SSH scalar fallback for interfaces on
    // which the specific commands and scalar SNMP both provided no fresh power.
    if (enriched.some((networkInterface) => !hasFreshOpticalPower(networkInterface, snmpFreshAfter))) {
      const scalarReadings = await this.executeOpticalCommands(
        client,
        device.ssh.host,
        driver,
        ['display transceiver verbose'],
      );
      enriched = this.applySshReadings(enriched, scalarReadings, snmpFreshAfter);
    }

    return enriched;
  }

  private async executeOpticalCommands(
    client: SshClientImpl,
    host: string,
    driver: HuaweiVrpDriver,
    commands: string[],
  ): Promise<HuaweiOpticalReading[]> {
    if (!commands.length) return [];
    try {
      const results = await client.execute(host, [
        'screen-length 0 temporary',
        ...new Set(commands),
      ]);
      const result = results.at(-1);
      return result?.exitCode === 0 ? driver.parseOpticalPower(result.stdout) : [];
    } catch {
      return [];
    }
  }

  private applySshReadings(
    interfaces: NetworkInterface[],
    readings: HuaweiOpticalReading[],
    snmpFreshAfter?: Date,
  ): NetworkInterface[] {
    if (!readings.length) return interfaces;
    const byName = new Map(readings.flatMap((reading) =>
      interfaceNameKeys(reading.name).map((key) => [key, reading] as const),
    ));
    const now = new Date().toISOString();

    return interfaces.map((networkInterface) => {
      const reading = [
        ...interfaceNameKeys(networkInterface.name),
        ...interfaceNameKeys(networkInterface.description),
      ].map((key) => byName.get(key)).find(Boolean);
      if (!reading) return networkInterface;

      const keepFreshSnmpPower = hasFreshSnmpPower(networkInterface, snmpFreshAfter);
      const keepFreshSnmpLanes = networkInterface.opticalLaneSource === 'SNMP'
        && hasFreshLaneData(networkInterface, snmpFreshAfter);
      const keepSnmpRx = keepFreshSnmpPower && networkInterface.rxPowerDbm != null;
      const keepSnmpTx = keepFreshSnmpPower && networkInterface.txPowerDbm != null;
      const usedSshRx = !keepSnmpRx && reading.rxPowerDbm != null;
      const usedSshTx = !keepSnmpTx && reading.txPowerDbm != null;
      const usedSshScalar = usedSshRx || usedSshTx;
      const usedSshLanes = !keepFreshSnmpLanes && reading.opticalLanes.length > 0;
      if (!usedSshScalar && !usedSshLanes) return networkInterface;

      return {
        ...networkInterface,
        rxPowerDbm: usedSshRx ? reading.rxPowerDbm : networkInterface.rxPowerDbm,
        txPowerDbm: usedSshTx ? reading.txPowerDbm : networkInterface.txPowerDbm,
        ...(usedSshScalar ? {
          opticalSource: 'SSH' as const,
          opticalUpdatedAt: now,
        } : {}),
        ...(usedSshLanes ? {
          opticalLanes: reading.opticalLanes,
          opticalLaneSource: 'SSH' as const,
          opticalLanesUpdatedAt: now,
        } : {}),
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
