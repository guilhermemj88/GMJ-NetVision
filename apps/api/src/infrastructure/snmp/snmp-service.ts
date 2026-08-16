import type { HostRecord, InterfaceStatus, NetworkInterface, SourceConnectionState } from '@gmj/shared';
import type {
  DeviceMetricSampleInput,
  HostRepository,
  InterfaceMetricSampleInput,
} from '../persistence/host-repository';
import { SnmpClientImpl } from './snmp-client-impl';
import { SnmpV2cDiscoveryAdapter } from './snmpv2c-discovery-adapter';

const SYSTEM_OIDS = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysObjectId: '1.3.6.1.2.1.1.2.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysName: '1.3.6.1.2.1.1.5.0',
} as const;

const INTERFACE_OIDS = {
  hcInOctets: '1.3.6.1.2.1.31.1.1.1.6',
  hcOutOctets: '1.3.6.1.2.1.31.1.1.1.10',
  inOctets: '1.3.6.1.2.1.2.2.1.10',
  outOctets: '1.3.6.1.2.1.2.2.1.16',
  inErrors: '1.3.6.1.2.1.2.2.1.14',
  outErrors: '1.3.6.1.2.1.2.2.1.20',
  inDiscards: '1.3.6.1.2.1.2.2.1.13',
  outDiscards: '1.3.6.1.2.1.2.2.1.19',
  operStatus: '1.3.6.1.2.1.2.2.1.8',
} as const;

interface CounterRow {
  ifIndex: number;
  inOctets: bigint;
  outOctets: bigint;
  inErrors: bigint;
  outErrors: bigint;
  inDiscards: bigint;
  outDiscards: bigint;
  operStatus: InterfaceStatus;
  timestamp: Date;
}

export interface SnmpPollResult {
  hostId: string;
  polledAt: string;
  interfaceSamples: number;
  sysName?: string;
  sysDescr?: string;
  sysObjectId?: string;
  uptimeSeconds?: number;
}

export class SnmpService {
  private readonly client: SnmpClientImpl;
  private readonly discoveryAdapter: SnmpV2cDiscoveryAdapter;

  constructor(private readonly repository: HostRepository) {
    this.client = new SnmpClientImpl(5000, 2);
    this.discoveryAdapter = new SnmpV2cDiscoveryAdapter(repository);
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
    if (!discovered.length) return [];
    return this.repository.replaceInterfaces(device.id, discovered);
  }

  async pollHost(device: HostRecord): Promise<SnmpPollResult> {
    if (!device.snmpEnabled || !device.snmp?.host) throw new Error('SNMP não está habilitado para este host');
    if (device.snmp.version !== 'SNMP_V2C') throw new Error('SNMPv3 ainda não está implementado');
    const community = await this.requireCommunity(device.id);

    let currentDevice = device;
    if (!currentDevice.interfaces.length) {
      await this.discoverAndPersistInterfaces(currentDevice);
      currentDevice = (await this.repository.getHost(device.id)) ?? currentDevice;
    }

    const [system, counters, previous] = await Promise.all([
      this.collectSystem(currentDevice, community),
      this.collectCounters(currentDevice, community),
      this.repository.getLatestCounterSnapshots(currentDevice.id),
    ]);

    const byIndex = new Map(currentDevice.interfaces.map((item) => [item.ifIndex, item]));
    const samples: InterfaceMetricSampleInput[] = [];
    for (const counter of counters.values()) {
      const networkInterface = byIndex.get(counter.ifIndex);
      if (!networkInterface) continue;
      const prior = previous.get(counter.ifIndex);
      const seconds = prior ? (counter.timestamp.getTime() - prior.timestamp.getTime()) / 1000 : 0;
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
        operStatus: counter.operStatus,
      });
    }

    await this.repository.saveSnmpPoll(currentDevice.id, system, samples);
    await this.repository.updateSourceHealth(currentDevice.id, {
      source: 'SNMP',
      state: 'CONNECTED',
      message: `Polling SNMP concluído com ${samples.length} interfaces`,
      checkedAt: system.timestamp.toISOString(),
    });

    return {
      hostId: currentDevice.id,
      polledAt: system.timestamp.toISOString(),
      interfaceSamples: samples.length,
      ...(system.sysName ? { sysName: system.sysName } : {}),
      ...(system.sysDescr ? { sysDescr: system.sysDescr } : {}),
      ...(system.sysObjectId ? { sysObjectId: system.sysObjectId } : {}),
      ...(system.uptimeSeconds !== undefined ? { uptimeSeconds: Number(system.uptimeSeconds) } : {}),
    };
  }

  async collectCounters(device: HostRecord, community?: string): Promise<Map<number, CounterRow>> {
    const counters = new Map<number, CounterRow>();
    if (!device.snmpEnabled || !device.snmp?.host) return counters;
    const snmpCommunity = community ?? (await this.requireCommunity(device.id));
    const options = { community: snmpCommunity, version: 'v2c' as const, port: device.snmp.port };

    const [hcIn, hcOut, inErrors, outErrors, inDiscards, outDiscards, operStatus] = await Promise.all([
      this.client.walk(device.snmp.host, INTERFACE_OIDS.hcInOctets, options),
      this.client.walk(device.snmp.host, INTERFACE_OIDS.hcOutOctets, options),
      this.client.walk(device.snmp.host, INTERFACE_OIDS.inErrors, options),
      this.client.walk(device.snmp.host, INTERFACE_OIDS.outErrors, options),
      this.client.walk(device.snmp.host, INTERFACE_OIDS.inDiscards, options),
      this.client.walk(device.snmp.host, INTERFACE_OIDS.outDiscards, options),
      this.client.walk(device.snmp.host, INTERFACE_OIDS.operStatus, options),
    ]);

    let inOctets = this.toBigIntIndexMap(hcIn);
    let outOctets = this.toBigIntIndexMap(hcOut);
    if (!inOctets.size || !outOctets.size) {
      const [legacyIn, legacyOut] = await Promise.all([
        this.client.walk(device.snmp.host, INTERFACE_OIDS.inOctets, options),
        this.client.walk(device.snmp.host, INTERFACE_OIDS.outOctets, options),
      ]);
      inOctets = this.toBigIntIndexMap(legacyIn);
      outOctets = this.toBigIntIndexMap(legacyOut);
    }

    const inErrorsMap = this.toBigIntIndexMap(inErrors);
    const outErrorsMap = this.toBigIntIndexMap(outErrors);
    const inDiscardsMap = this.toBigIntIndexMap(inDiscards);
    const outDiscardsMap = this.toBigIntIndexMap(outDiscards);
    const statusMap = new Map(operStatus.map((item) => [this.extractIfIndex(item.oid), item.value]));
    const now = new Date();

    for (const [ifIndex, inValue] of inOctets) {
      if (ifIndex === null) continue;
      counters.set(ifIndex, {
        ifIndex,
        inOctets: inValue,
        outOctets: outOctets.get(ifIndex) ?? 0n,
        inErrors: inErrorsMap.get(ifIndex) ?? 0n,
        outErrors: outErrorsMap.get(ifIndex) ?? 0n,
        inDiscards: inDiscardsMap.get(ifIndex) ?? 0n,
        outDiscards: outDiscardsMap.get(ifIndex) ?? 0n,
        operStatus: this.parseOperStatus(statusMap.get(ifIndex)),
        timestamp: now,
      });
    }
    return counters;
  }

  private async collectSystem(device: HostRecord, community: string): Promise<DeviceMetricSampleInput> {
    const values = await this.client.get(device.snmp!.host, Object.values(SYSTEM_OIDS), {
      community,
      version: 'v2c',
      port: device.snmp!.port,
    });
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

  private toBigIntIndexMap(
    varbinds: Array<{ oid: string; value: string | number | Uint8Array }>,
  ): Map<number, bigint> {
    const result = new Map<number, bigint>();
    for (const varbind of varbinds) {
      const index = this.extractIfIndex(varbind.oid);
      if (index !== null) result.set(index, this.parseCounter(varbind.value));
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

  private parseOperStatus(value: string | number | Uint8Array | undefined): InterfaceStatus {
    const numeric = typeof value === 'number' ? value : parseInt(this.textValue(value), 10);
    if (numeric === 1) return 'UP';
    if (numeric === 2) return 'DOWN';
    if (numeric === 6) return 'DISABLED';
    return 'UNKNOWN';
  }

  private textValue(value: string | number | Uint8Array | undefined): string {
    if (value === undefined) return '';
    if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8').replace(/\0+$/g, '').trim();
    return String(value).trim();
  }
}
