import type { HostRecord, NetworkInterface } from '@gmj/shared';
import type { HostRepository, InterfaceOpticalThresholdRecord } from '../persistence/host-repository';
import { interfaceNameKeys } from '../topology/interface-correlation';
import {
  HuaweiVrpDriver,
  huaweiDiagnosisCommand,
  huaweiMultiLaneInterfaceName,
  type HuaweiOpticalReading,
} from '../topology/huawei-vrp-driver';
import {
  hasUsefulOpticalThresholds,
  opticalThresholdsLayoutChanged,
  opticalThresholdsV1FromHuawei,
  summaryOpticalThresholdSource,
} from '../topology/optical-thresholds';
import { SshClientImpl } from './ssh-client-impl';

export interface OpticalThresholdServiceOptions {
  /** Intervalo de validade dos thresholds persistidos (default 24h). */
  refreshHours?: number;
  /** Cooldown de dispositivo depois de falha SSH (default 60min). */
  failureCooldownMs?: number;
  /** Teto de comandos por ciclo do slow path (default 16). */
  maxCommands?: number;
  now?: () => number;
}

const DEFAULT_REFRESH_HOURS = 24;
const DEFAULT_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;
const DEFAULT_MAX_COMMANDS = 16;

function thresholdCandidates(interfaces: NetworkInterface[]): NetworkInterface[] {
  return interfaces.filter((networkInterface) =>
    huaweiMultiLaneInterfaceName(networkInterface.name) !== null
    || networkInterface.rxPowerDbm != null
    || networkInterface.txPowerDbm != null
    || (networkInterface.opticalLanes?.length ?? 0) > 0,
  );
}

function observedLaneIds(networkInterface: NetworkInterface): number[] {
  return (networkInterface.opticalLanes ?? [])
    .map((lane) => lane.lane)
    .filter((lane) => Number.isInteger(lane))
    .sort((left, right) => left - right);
}

function needsThresholdRefresh(
  record: InterfaceOpticalThresholdRecord | null,
  networkInterface: NetworkInterface,
  now: number,
): boolean {
  if (!record || !record.refreshAfter) return true;
  if (record.refreshAfter.getTime() <= now) return true;
  return opticalThresholdsLayoutChanged(record.thresholds, observedLaneIds(networkInterface));
}

/**
 * Slow path de thresholds opticos, SEPARADO do enrichment de potencia:
 * `enrichOpticalPower` retorna cedo quando o SNMP esta fresco (correto para a
 * potencia atual, nao para os thresholds). Aqui so entram interfaces sem
 * threshold persistido, com `refreshAfter` vencido ou com layout de lane novo.
 */
export class OpticalThresholdService {
  private readonly refreshMs: number;
  private readonly failureCooldownMs: number;
  private readonly maxCommands: number;
  private readonly now: () => number;
  private readonly failureCooldownUntil = new Map<string, number>();

  constructor(
    private readonly repository: HostRepository,
    options: OpticalThresholdServiceOptions = {},
  ) {
    this.refreshMs = (options.refreshHours ?? DEFAULT_REFRESH_HOURS) * 3_600_000;
    this.failureCooldownMs = options.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS;
    this.maxCommands = options.maxCommands ?? DEFAULT_MAX_COMMANDS;
    this.now = options.now ?? Date.now;
  }

  /** Nunca lanca: o slow path de thresholds nao pode derrubar o polling. */
  async refreshOpticalThresholds(device: HostRecord): Promise<void> {
    try {
      await this.run(device);
    } catch {
      // Falha de threshold e opcional; o ciclo SNMP/SSH de potencia segue valido.
    }
  }

  private async run(device: HostRecord): Promise<void> {
    if (!device.sshEnabled || !device.ssh?.host || !device.ssh.username) return;
    const now = this.now();
    if ((this.failureCooldownUntil.get(device.id) ?? 0) > now) return;

    const candidates = thresholdCandidates(device.interfaces);
    if (!candidates.length) return;
    const records = new Map(
      (await this.repository.getInterfaceOpticalThresholds(device.id)).map((record) => [
        record.interfaceId,
        record,
      ]),
    );
    const stale = candidates.filter((candidate) =>
      needsThresholdRefresh(records.get(candidate.id) ?? null, candidate, now),
    );
    if (!stale.length) return;

    const credentials = await this.repository.getDecryptedSshCredentials(device.id);
    if (!credentials?.password) return;

    const readings = await this.collectReadings(device, credentials.password, stale, now);
    if (readings === null) return;

    const byName = new Map(
      readings.flatMap((reading) => interfaceNameKeys(reading.name).map((key) => [key, reading] as const)),
    );
    const refreshedAt = new Date(now);
    const refreshAfter = new Date(now + this.refreshMs);
    await this.repository.updateInterfaceOpticalThresholds(
      device.id,
      stale.map((candidate) => {
        const reading = [
          ...interfaceNameKeys(candidate.name),
          ...interfaceNameKeys(candidate.description),
        ].map((key) => byName.get(key)).find(Boolean);
        const laneIds = observedLaneIds(candidate);
        const useful = reading ? hasUsefulOpticalThresholds(reading.thresholds) : false;
        const thresholds = reading && (useful || laneIds.length)
          ? opticalThresholdsV1FromHuawei(reading.thresholds, laneIds)
          : null;
        return {
          interfaceId: candidate.id,
          thresholds,
          source: summaryOpticalThresholdSource(thresholds),
          updatedAt: refreshedAt,
          refreshAfter,
        };
      }),
    );
  }

  /** null = falha de SSH (cooldown aplicado); [] = nada util retornado. */
  private async collectReadings(
    device: HostRecord,
    password: string,
    stale: NetworkInterface[],
    now: number,
  ): Promise<HuaweiOpticalReading[] | null> {
    const diagnosisCommands: string[] = [];
    for (const candidate of stale) {
      if (diagnosisCommands.length >= this.maxCommands - 2) break;
      const command = huaweiDiagnosisCommand(candidate.name);
      if (command && !diagnosisCommands.includes(command)) diagnosisCommands.push(command);
    }
    const commands = [
      'screen-length 0 temporary',
      ...diagnosisCommands,
      'display transceiver verbose',
    ];
    const client = new SshClientImpl({
      port: device.ssh?.port ?? 22,
      username: device.ssh?.username ?? '',
      password,
      contextCommand: device.ssh?.contextCommand ?? null,
      shellTimeoutMs: 90_000,
    });
    try {
      const results = await client.execute(device.ssh?.host ?? '', commands);
      const result = results.at(-1);
      if (result?.exitCode !== 0) return [];
      return new HuaweiVrpDriver().parseOpticalPower(result.stdout);
    } catch {
      this.failureCooldownUntil.set(device.id, now + this.failureCooldownMs);
      return null;
    }
  }
}
