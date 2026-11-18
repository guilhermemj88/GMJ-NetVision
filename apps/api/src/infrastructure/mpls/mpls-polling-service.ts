import type { HostRecord, MplsDiscoveryState, MplsSource } from '@gmj/shared';
import { mergeMplsDiscovery } from './mpls-discovery-service';
import type { HuaweiVplsSnmpCollector, HuaweiVplsCollection } from './huawei-vpls-snmp';
import type { HuaweiVsiSshReading, HuaweiVsiSshService } from './huawei-vsi-ssh';
import type { MplsRepository } from './mpls-repository';

export interface MplsPollOutcome {
  supported: boolean | null;
  discoveryState: MplsDiscoveryState;
  sources: MplsSource[];
  collectedAt: string;
  error: string | null;
}

/** Fallback CLI quando a MIB nao entrega VSI: fonte unica, mas com cadencia. */
const SSH_FALLBACK_INTERVAL_MS = 2 * 60_000;
/** Com VSI na MIB, o CLI roda so para evidenciar divergencia SNMP x SSH. */
const SSH_CONFLICT_INTERVAL_MS = 10 * 60_000;

/**
 * Coleta MPLS do equipamento.
 *
 * Nenhuma das fontes derruba a outra: a MIB pode estar vazia, o CLI pode nao
 * reconhecer o comando, e o resultado ainda assim precisa dizer o que foi
 * comprovado. Quem decide o estado final e o `mergeMplsDiscovery` — nunca a
 * tabela SNMP sozinha.
 */
export class MplsPollingService {
  private readonly activePolls = new Map<string, Promise<MplsPollOutcome>>();
  private readonly lastSshAt = new Map<string, number>();

  constructor(
    private readonly collector: HuaweiVplsSnmpCollector,
    private readonly repository: MplsRepository,
    private readonly ssh?: HuaweiVsiSshService,
  ) {}

  /**
   * O polling SNMP roda a cada minuto; abrir uma sessao CLI nesse ritmo seria
   * abusivo com o equipamento. O SSH roda como fallback quando a MIB nao tem
   * VSI, e com cadencia maior quando ela tem (so para evidenciar divergencia).
   */
  private shouldReadSsh(deviceId: string, snmp: HuaweiVplsCollection | null): boolean {
    if (!this.ssh) return false;
    const last = this.lastSshAt.get(deviceId) ?? 0;
    const interval =
      !snmp || snmp.vsis.length === 0 ? SSH_FALLBACK_INTERVAL_MS : SSH_CONFLICT_INTERVAL_MS;
    return Date.now() - last >= interval;
  }

  async poll(device: HostRecord, community: string): Promise<MplsPollOutcome> {
    const running = this.activePolls.get(device.id);
    if (running) return running;
    const poll = this.pollUnlocked(device, community).finally(() => {
      if (this.activePolls.get(device.id) === poll) this.activePolls.delete(device.id);
    });
    this.activePolls.set(device.id, poll);
    return poll;
  }

  private async pollUnlocked(device: HostRecord, community: string): Promise<MplsPollOutcome> {
    const attemptedAt = new Date();
    const snmpConfig = device.snmp;
    const snmpAvailable = Boolean(
      device.snmpEnabled && snmpConfig?.host && snmpConfig.version === 'SNMP_V2C',
    );
    const sshAvailable = Boolean(device.sshEnabled && device.ssh?.host);
    if (!snmpAvailable && !sshAvailable) {
      return {
        supported: null,
        discoveryState: 'UNKNOWN',
        sources: [],
        collectedAt: attemptedAt.toISOString(),
        error: null,
      };
    }

    const [snmp, ssh] = await this.readBoth(device, community, snmpAvailable, sshAvailable);
    if (snmp.errorSafe) {
      await this.safeSaveFailure(device.id, attemptedAt, snmp.errorSafe);
    }

    const result = mergeMplsDiscovery({ snmp: snmp.collection, ssh: ssh.reading });
    await this.repository.saveCollection(device.id, result.collection);

    const partialError = result.collection.errors.length
      ? `Falha parcial na coleta MPLS: ${result.collection.errors.join('; ')}`
      : null;
    if (partialError) {
      await this.safeSaveFailure(device.id, result.collection.collectedAt, partialError);
    }

    return {
      supported: result.collection.supported,
      discoveryState: result.discoveryState,
      sources: result.sources,
      collectedAt: result.collection.collectedAt.toISOString(),
      error: snmp.errorSafe ?? partialError,
    };
  }

  private async readBoth(
    device: HostRecord,
    community: string,
    snmpAvailable: boolean,
    sshAvailable: boolean,
  ): Promise<
    [
      { collection: HuaweiVplsCollection | null; errorSafe: string | null },
      { reading: HuaweiVsiSshReading | null },
    ]
  > {
    // SNMP primeiro: ele decide se o CLI precisa entrar como fallback agora.
    const snmp = await this.readSnmp(device, community, snmpAvailable);
    if (!sshAvailable || !this.shouldReadSsh(device.id, snmp.collection)) {
      return [snmp, { reading: null }];
    }
    this.lastSshAt.set(device.id, Date.now());
    return [snmp, await this.readSsh(device, sshAvailable)];
  }

  private async readSnmp(
    device: HostRecord,
    community: string,
    available: boolean,
  ): Promise<{ collection: HuaweiVplsCollection | null; errorSafe: string | null }> {
    if (!available || !device.snmp?.host) return { collection: null, errorSafe: null };
    try {
      const collection = await this.collector.collect(device.snmp.host, {
        community,
        version: 'v2c',
        port: device.snmp.port,
      });
      return { collection, errorSafe: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha na coleta MPLS via SNMP';
      return { collection: null, errorSafe: message };
    }
  }

  private async readSsh(
    device: HostRecord,
    available: boolean,
  ): Promise<{ reading: HuaweiVsiSshReading | null }> {
    if (!available || !this.ssh) return { reading: null };
    try {
      return { reading: await this.ssh.readVsi(device) };
    } catch {
      // O SSH falhou por inteiro: a leitura SNMP (se houver) continua valendo e
      // o estado vira INCOMPLETE em vez de "MPLS não disponível".
      return { reading: null };
    }
  }

  private async safeSaveFailure(hostId: string, occurredAt: Date, message: string): Promise<void> {
    try {
      await this.repository.saveFailure(hostId, occurredAt, message);
    } catch {
      // O erro de persistencia do aviso nao pode apagar a coleta em si.
    }
  }
}
