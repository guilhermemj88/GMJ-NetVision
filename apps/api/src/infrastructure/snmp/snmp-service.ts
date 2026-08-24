import type { HostRecord, InterfaceStatus, NetworkInterface, SourceConnectionState } from '@gmj/shared';
import type {
  DeviceMetricSampleInput,
  HostRepository,
  InterfaceMetricSampleInput,
  InterfaceStatusUpdate,
} from '../persistence/host-repository';
import { SnmpClientImpl } from './snmp-client-impl';
import { SnmpV2cDiscoveryAdapter } from './snmpv2c-discovery-adapter';
import type { SshInterfaceService } from '../ssh/ssh-interface-service';
import { SnmpProfileMetricService } from './profile-metric-service';
import type { SnmpProfileDiagnostic } from './profiles/types';
import { calculateCounterDelta } from './counter-delta';
import { decodeSnmpText } from './snmp-text';

const SYSTEM_OIDS = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysObjectId: '1.3.6.1.2.1.1.2.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysName: '1.3.6.1.2.1.1.5.0',
} as const;

const INTERFACE_OIDS = {
  adminStatus: '1.3.6.1.2.1.2.2.1.7',
  operStatus: '1.3.6.1.2.1.2.2.1.8',
  hcInOctets: '1.3.6.1.2.1.31.1.1.1.6',
  hcOutOctets: '1.3.6.1.2.1.31.1.1.1.10',
  inOctets: '1.3.6.1.2.1.2.2.1.10',
  outOctets: '1.3.6.1.2.1.2.2.1.16',
  inErrors: '1.3.6.1.2.1.2.2.1.14',
  outErrors: '1.3.6.1.2.1.2.2.1.20',
  inDiscards: '1.3.6.1.2.1.2.2.1.13',
  outDiscards: '1.3.6.1.2.1.2.2.1.19',
} as const;

const MIN_COUNTER_SAMPLE_SECONDS = 45;
const INTERFACE_REFRESH_MILLISECONDS = 6 * 60 * 60 * 1000;

interface CounterRow {
  ifIndex: number;
  inOctets: bigint;
  outOctets: bigint;
  inErrors: bigint;
  outErrors: bigint;
  inDiscards: bigint;
  outDiscards: bigint;
  timestamp: Date;
}

type VarBind = { oid: string; value: string | number | Uint8Array };

export interface SnmpPollResult {
  hostId: string;
  polledAt: string;
  interfacesChecked: number;
  interfaceSamples: number;
  sysName?: string;
  sysDescr?: string;
  sysObjectId?: string;
  uptimeSeconds?: number;
}

export class SnmpService {
  private readonly client: SnmpClientImpl;
  private readonly discoveryAdapter: SnmpV2cDiscoveryAdapter;
  private readonly activePolls = new Map<string, Promise<SnmpPollResult>>();
  private readonly profileMetrics: SnmpProfileMetricService;
  private readonly lastOpticalAttempts = new Map<string, number>();

  constructor(
    private readonly repository: HostRepository,
    private readonly sshInterfaces?: SshInterfaceService,
    private readonly opticalIntervalMs: number = 300_000,
  ) {
    this.client = new SnmpClientImpl(3000, 1);
    this.discoveryAdapter = new SnmpV2cDiscoveryAdapter(repository);
    this.profileMetrics = new SnmpProfileMetricService(this.client);
  }

  getProfileDiagnostic(deviceId: string): SnmpProfileDiagnostic | null {
    return this.profileMetrics.getDiagnostic(deviceId);
  }

  async testConnectivity(device: HostRecord): Promise<{
    state: Exclude<SourceConnectionState, 'CONFIGURED'>;
    message: string;
  }> {
    if (!device.snmp?.host || !device.snmp.port || !device.snmpEnabled) {
      return { state: 'DISABLED', message: 'SNMP não está habilitado para este host' };
    }
    if (device.snmp.version !== 'SNMP_V2C') {
      return { state: 'FAILED', message: 'SNMPv3 ainda não está implementado no coletor NetVision' };
    }

    try {
      const community = await this.requireCommunity(device.id);
      const result = await this.client.get(device.snmp.host, [SYSTEM_OIDS.sysDescr], {
        community,
        version: 'v2c',
        port: device.snmp.port,
      });
      return result.length
        ? { state: 'CONNECTED', message: `Conectado ao ${device.snmp.host}:${device.snmp.port}` }
        : { state: 'FAILED', message: 'Resposta vazia do equipamento' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('credential')) {
        return { state: 'AUTH_INVALID', message: 'Credencial SNMP não configurada para este host' };
      }
      if (message.toLowerCase().includes('timeout')) {
        return { state: 'TIMEOUT', message: `Timeout ao conectar a ${device.snmp.host}:${device.snmp.port}` };
      }
      if (message.toLowerCase().includes('unreachable') || message.toLowerCase().includes('refused')) {
        return {
          state: 'UNREACHABLE',
          message: `Equipamento ${device.snmp.host}:${device.snmp.port} não está acessível`,
        };
      }
      if (message.toLowerCase().includes('authentication') || message.toLowerCase().includes('community')) {
        return { state: 'AUTH_INVALID', message: 'Falha de autenticação SNMP - verifique community/versão' };
      }
      return { state: 'FAILED', message: `Erro ao conectar: ${message}` };
    }
  }

  async discoverInterfaces(device: HostRecord): Promise<NetworkInterface[]> {
    if (!device.snmpEnabled || !device.snmp?.host || device.snmp.version !== 'SNMP_V2C') return [];
    const community = await this.requireCommunity(device.id);
    return this.discoveryAdapter.discoverInterfaces(device, community);
  }

  async discoverAndPersistInterfaces(device: HostRecord): Promise<NetworkInterface[]> {
    const discovered = await this.discoverInterfaces(device);
    if (!discovered.length) throw new Error('SNMP IF-MIB returned no valid interfaces');
    let merged = discovered;
    if (device.sshEnabled && this.sshInterfaces) {
      try {
        merged = await this.sshInterfaces.enrichInterfaces(device, discovered);
        await this.repository.updateSourceHealth(device.id, {
          source: 'SSH', state: 'CONNECTED',
          message: 'Descrições de interfaces complementadas via SSH Huawei',
          checkedAt: new Date().toISOString(),
        });
      } catch (error) {
        await this.repository.updateSourceHealth(device.id, {
          source: 'SSH', state: 'FAILED',
          message: error instanceof Error ? error.message : 'SSH interface enrichment failed',
          checkedAt: new Date().toISOString(),
        });
      }
    }
    return this.repository.replaceInterfaces(device.id, merged);
  }

  async pollHost(device: HostRecord): Promise<SnmpPollResult> {
    const running = this.activePolls.get(device.id);
    if (running) return running;

    const poll = this.pollHostUnlocked(device).finally(() => {
      if (this.activePolls.get(device.id) === poll) this.activePolls.delete(device.id);
    });
    this.activePolls.set(device.id, poll);
    return poll;
  }

  private async pollHostUnlocked(device: HostRecord): Promise<SnmpPollResult> {
    if (!device.snmpEnabled || !device.snmp?.host) throw new Error('SNMP não está habilitado para este host');
    if (device.snmp.version !== 'SNMP_V2C') throw new Error('SNMPv3 ainda não está implementado');
    const community = await this.requireCommunity(device.id);

    let currentDevice = device;
    const lastDiscovery = currentDevice.lastDiscoveryAt
      ? new Date(currentDevice.lastDiscoveryAt).getTime()
      : 0;
    const shouldRefreshInterfaces = !currentDevice.interfaces.length
      || Date.now() - lastDiscovery >= INTERFACE_REFRESH_MILLISECONDS;
    if (shouldRefreshInterfaces) {
      try {
        await this.discoverAndPersistInterfaces(currentDevice);
        currentDevice = (await this.repository.getHost(device.id)) ?? currentDevice;
      } catch (error) {
        if (!currentDevice.interfaces.length) throw error;
      }
    }

    const snmp = currentDevice.snmp;
    if (!snmp) throw new Error('SNMP não está habilitado para este host');

    const statuses = await this.collectInterfaceStatuses(currentDevice, community);
    await this.repository.updateInterfaceStatuses(currentDevice.id, [...statuses.values()]);

    const previousPromise = this.repository.getLatestCounterSnapshots(currentDevice.id);
    const system = await this.collectSystem(currentDevice, community);
    try {
      const profile = await this.profileMetrics.collect(
        currentDevice.id,
        snmp.host,
        { community, version: 'v2c', port: snmp.port },
        {
          vendor: currentDevice.vendor,
          model: currentDevice.model,
          ...(system.sysObjectId ? { sysObjectId: system.sysObjectId } : {}),
          ...(system.sysDescr ? { sysDescr: system.sysDescr } : {}),
          ...(system.sysName ? { sysName: system.sysName } : {}),
        },
      );
      if (profile.cpuPercent !== undefined) system.cpuPercent = profile.cpuPercent;
    } catch {
      // A vendor metric is optional and must never stop IF-MIB traffic polling.
    }
    const counters = await this.collectCounters(currentDevice, community);
    const previous = await previousPromise;

    const byIndex = new Map(currentDevice.interfaces.map((item) => [item.ifIndex, item]));
    const samples: InterfaceMetricSampleInput[] = [];
    for (const counter of counters.values()) {
      const networkInterface = byIndex.get(counter.ifIndex);
      if (!networkInterface) continue;
      const prior = previous.get(counter.ifIndex);
      const seconds = prior ? (counter.timestamp.getTime() - prior.timestamp.getTime()) / 1000 : 0;

      // Several network platforms cache interface counters for a short interval.
      // A manual poll right after the scheduled poll can therefore return the same
      // counters and create a false zero-rate sample. Skip rate samples until there
      // is enough elapsed time for the counter delta to be meaningful.
      if (prior && seconds > 0 && seconds < MIN_COUNTER_SAMPLE_SECONDS) continue;
      if (prior && counter.timestamp <= prior.timestamp) continue;

      const rxBps = this.calculateBps(counter.inOctets, prior?.inOctets, seconds);
      const txBps = this.calculateBps(counter.outOctets, prior?.outOctets, seconds);
      samples.push({
        interfaceId: networkInterface.id,
        ifIndex: counter.ifIndex,
        timestamp: counter.timestamp,
        inOctets: counter.inOctets,
        outOctets: counter.outOctets,
        rxBps,
        txBps,
        inErrors: counter.inErrors,
        outErrors: counter.outErrors,
        inDiscards: counter.inDiscards,
        outDiscards: counter.outDiscards,
        inErrorsDelta: calculateCounterDelta(counter.inErrors, prior?.inErrors),
        outErrorsDelta: calculateCounterDelta(counter.outErrors, prior?.outErrors),
        inDiscardsDelta: calculateCounterDelta(counter.inDiscards, prior?.inDiscards),
        outDiscardsDelta: calculateCounterDelta(counter.outDiscards, prior?.outDiscards),
        operStatus: statuses.get(counter.ifIndex)?.operStatus ?? networkInterface.operStatus,
      });
    }

    await this.repository.saveSnmpPoll(currentDevice.id, system, samples);
    await this.refreshOpticalPower(currentDevice, community);
    await this.repository.updateSourceHealth(currentDevice.id, {
      source: 'SNMP',
      state: 'CONNECTED',
      message: `Polling SNMP concluído com ${statuses.size} interfaces verificadas e ${samples.length} amostras`,
      checkedAt: system.timestamp.toISOString(),
    });

    return {
      hostId: currentDevice.id,
      polledAt: system.timestamp.toISOString(),
      interfacesChecked: statuses.size,
      interfaceSamples: samples.length,
      ...(system.sysName ? { sysName: system.sysName } : {}),
      ...(system.sysDescr ? { sysDescr: system.sysDescr } : {}),
      ...(system.sysObjectId ? { sysObjectId: system.sysObjectId } : {}),
      ...(system.uptimeSeconds !== undefined ? { uptimeSeconds: Number(system.uptimeSeconds) } : {}),
    };
  }

  private async refreshOpticalPower(device: HostRecord, community: string): Promise<void> {
    const now = Date.now();
    const lastAttempt = this.lastOpticalAttempts.get(device.id) ?? 0;
    if (now - lastAttempt < this.opticalIntervalMs) return;
    this.lastOpticalAttempts.set(device.id, now);
    const startedAt = new Date(now);

    try {
      let interfaces = await this.discoveryAdapter.enrichOpticalPower(
        device,
        device.interfaces,
        community,
      );
      if (device.sshEnabled && this.sshInterfaces) {
        try {
          interfaces = await this.sshInterfaces.enrichOpticalPower(device, interfaces, startedAt);
        } catch {
          // SSH DDM is a per-interface fallback; its failure does not affect SNMP.
        }
      }
      await this.repository.updateInterfaceOptics(device.id, interfaces, startedAt);
    } catch {
      // Optional DDM enrichment must never fail the traffic poll.
    }
  }

  async collectInterfaceStatuses(
    device: HostRecord,
    community?: string,
  ): Promise<Map<number, InterfaceStatusUpdate>> {
    const statuses = new Map<number, InterfaceStatusUpdate>();
    if (!device.snmpEnabled || !device.snmp?.host) return statuses;
    const snmpCommunity = community ?? (await this.requireCommunity(device.id));
    const options = { community: snmpCommunity, version: 'v2c' as const, port: device.snmp.port };
    const [adminRows, operRows] = await Promise.all([
      this.safeWalk(device.snmp.host, INTERFACE_OIDS.adminStatus, options),
      this.safeWalk(device.snmp.host, INTERFACE_OIDS.operStatus, options),
    ]);
    const adminByIndex = this.toRawIndexMap(adminRows);
    const operByIndex = this.toRawIndexMap(operRows);
    const ifIndexes = new Set([...adminByIndex.keys(), ...operByIndex.keys()]);

    for (const ifIndex of ifIndexes) {
      const adminStatus = this.parseAdminStatus(adminByIndex.get(ifIndex));
      const operStatus = this.parseOperStatus(operByIndex.get(ifIndex));
      if (adminStatus === undefined && operStatus === undefined) continue;
      statuses.set(ifIndex, {
        ifIndex,
        ...(adminStatus !== undefined ? { adminStatus } : {}),
        ...(operStatus !== undefined ? { operStatus } : {}),
      });
    }
    return statuses;
  }

  async collectCounters(device: HostRecord, community?: string): Promise<Map<number, CounterRow>> {
    const counters = new Map<number, CounterRow>();
    if (!device.snmpEnabled || !device.snmp?.host) return counters;
    const snmpCommunity = community ?? (await this.requireCommunity(device.id));
    const options = { community: snmpCommunity, version: 'v2c' as const, port: device.snmp.port };

    let hcIn = await this.safeWalk(device.snmp.host, INTERFACE_OIDS.hcInOctets, options);
    let hcOut = await this.safeWalk(device.snmp.host, INTERFACE_OIDS.hcOutOctets, options);

    let inOctets = this.toBigIntIndexMap(hcIn);
    let outOctets = this.toBigIntIndexMap(hcOut);
    if (!inOctets.size || !outOctets.size) {
      hcIn = [];
      hcOut = [];
      const legacyIn = await this.client.walk(device.snmp.host, INTERFACE_OIDS.inOctets, options);
      const legacyOut = await this.client.walk(device.snmp.host, INTERFACE_OIDS.outOctets, options);
      inOctets = this.toBigIntIndexMap(legacyIn);
      outOctets = this.toBigIntIndexMap(legacyOut);
    }

    if (!inOctets.size && !outOctets.size) return counters;

    const inErrors = await this.safeWalk(device.snmp.host, INTERFACE_OIDS.inErrors, options);
    const outErrors = await this.safeWalk(device.snmp.host, INTERFACE_OIDS.outErrors, options);
    const inDiscards = await this.safeWalk(device.snmp.host, INTERFACE_OIDS.inDiscards, options);
    const outDiscards = await this.safeWalk(device.snmp.host, INTERFACE_OIDS.outDiscards, options);

    const inErrorsMap = this.toBigIntIndexMap(inErrors);
    const outErrorsMap = this.toBigIntIndexMap(outErrors);
    const inDiscardsMap = this.toBigIntIndexMap(inDiscards);
    const outDiscardsMap = this.toBigIntIndexMap(outDiscards);
    const now = new Date();

    const indexes = new Set<number>([...inOctets.keys(), ...outOctets.keys()]);
    for (const ifIndex of indexes) {
      counters.set(ifIndex, {
        ifIndex,
        inOctets: inOctets.get(ifIndex) ?? 0n,
        outOctets: outOctets.get(ifIndex) ?? 0n,
        inErrors: inErrorsMap.get(ifIndex) ?? 0n,
        outErrors: outErrorsMap.get(ifIndex) ?? 0n,
        inDiscards: inDiscardsMap.get(ifIndex) ?? 0n,
        outDiscards: outDiscardsMap.get(ifIndex) ?? 0n,
        timestamp: now,
      });
    }
    return counters;
  }

  private async safeWalk(
    host: string,
    oid: string,
    options: { community: string; version: 'v2c'; port: number },
  ): Promise<VarBind[]> {
    try {
      return await this.client.walk(host, oid, options);
    } catch {
      return [];
    }
  }

  private async collectSystem(device: HostRecord, community: string): Promise<DeviceMetricSampleInput> {
    const values = await this.client.get(device.snmp!.host, Object.values(SYSTEM_OIDS), {
      community,
      version: 'v2c',
      port: device.snmp!.port,
    });
    if (!values.length) throw new Error('SNMP system request returned no valid values');
    const byOid = new Map(values.map((value) => [value.oid, value.value]));
    const uptimeHundredths = this.parseCounter(byOid.get(SYSTEM_OIDS.sysUpTime) ?? 0);
    return {
      timestamp: new Date(),
      uptimeSeconds: uptimeHundredths / 100n,
      sysName: this.textValue(byOid.get(SYSTEM_OIDS.sysName)),
      sysDescr: this.textValue(byOid.get(SYSTEM_OIDS.sysDescr)),
      sysObjectId: this.textValue(byOid.get(SYSTEM_OIDS.sysObjectId)),
    };
  }

  private async requireCommunity(hostId: string): Promise<string> {
    const credentials = await this.repository.getDecryptedSnmpCredentials(hostId);
    if (!credentials?.community) throw new Error('SNMP credential not configured');
    return credentials.community;
  }

  private toBigIntIndexMap(varbinds: VarBind[]): Map<number, bigint> {
    const result = new Map<number, bigint>();
    for (const varbind of varbinds) {
      const index = this.extractIfIndex(varbind.oid);
      if (index !== null) result.set(index, this.parseCounter(varbind.value));
    }
    return result;
  }

  private toRawIndexMap(varbinds: VarBind[]): Map<number, VarBind['value']> {
    const result = new Map<number, VarBind['value']>();
    for (const varbind of varbinds) {
      const index = this.extractIfIndex(varbind.oid);
      if (index !== null) result.set(index, varbind.value);
    }
    return result;
  }

  private extractIfIndex(oid: string): number | null {
    const value = parseInt(oid.split('.').at(-1) ?? '', 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  private parseCounter(value: string | number | Uint8Array): bigint {
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value < 0) return 0n;
      return BigInt(Math.trunc(value));
    }
    if (typeof value === 'string') {
      try {
        const parsed = BigInt(value.trim());
        return parsed >= 0n ? parsed : 0n;
      } catch {
        return 0n;
      }
    }
    let result = 0n;
    for (const byte of value) result = (result << 8n) | BigInt(byte);
    return result;
  }

  private calculateBps(current: bigint, previous: bigint | undefined, seconds: number): number {
    if (previous === undefined || seconds <= 0 || current < previous) return 0;
    const deltaBits = (current - previous) * 8n;
    const value = Number(deltaBits) / seconds;
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  private parseAdminStatus(
    value: string | number | Uint8Array | undefined,
  ): NetworkInterface['adminStatus'] | undefined {
    const numeric = typeof value === 'number' ? value : parseInt(this.textValue(value), 10);
    if (numeric === 1) return 'UP';
    if (numeric === 2 || numeric === 3) return 'DOWN';
    return undefined;
  }

  private parseOperStatus(
    value: string | number | Uint8Array | undefined,
  ): InterfaceStatus | undefined {
    const numeric = typeof value === 'number' ? value : parseInt(this.textValue(value), 10);
    if (numeric === 1) return 'UP';
    if (numeric === 2) return 'DOWN';
    if (numeric === 3 || numeric === 4 || numeric === 5) return 'UNKNOWN';
    if (numeric === 6) return 'DISABLED';
    if (numeric === 7) return 'DOWN';
    return undefined;
  }

  private textValue(value: string | number | Uint8Array | undefined): string {
    return decodeSnmpText(value);
  }
}
