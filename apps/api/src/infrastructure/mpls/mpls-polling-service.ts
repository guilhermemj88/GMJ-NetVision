import type { HostRecord, MplsDiscoveryState, MplsSource } from '@gmj/shared';
import { mergeMplsDiscovery } from './mpls-discovery-service';
import type { HuaweiVplsSnmpCollector, HuaweiVplsCollection } from './huawei-vpls-snmp';
import type { HuaweiVsiSshReading, HuaweiVsiSshService } from './huawei-vsi-ssh';
import type { MplsRepository } from './mpls-repository';
import {
  decideMplsSsh,
  hasMplsSshCredentials,
  MplsSshGovernor,
  type MplsSshDenyReason,
  type MplsSshLeaseAcquirer,
} from './mpls-ssh-policy';
import { mplsSshFailureOf, classifyMplsSshFailure, type MplsSshFailureKind } from './mpls-ssh-failure';

/**
 * P6: quando o repositorio expoe o orcamento persistente, o governor passa a
 * usar o banco (vale entre processos e sobrevive a restart). Sem os metodos,
 * cai no contador local — comportamento de laboratorio/demo.
 */
function leaseAcquirerFrom(repository: MplsRepository): MplsSshLeaseAcquirer | undefined {
  const acquire = repository.acquireSshLease;
  const release = repository.releaseSshLease;
  if (typeof acquire !== 'function' || typeof release !== 'function') return undefined;
  return {
    acquireSshLease: (hostId, limits) => acquire.call(repository, hostId, limits),
    releaseSshLease: (leaseId) => release.call(repository, leaseId),
  };
}

export interface MplsPollOutcome {
  supported: boolean | null;
  discoveryState: MplsDiscoveryState;
  sources: MplsSource[];
  collectedAt: string;
  error: string | null;
  /** A1: por que o fallback CLI (SSH) nao rodou nesta rodada. */
  sshDeniedReason?: MplsSshDenyReason | null;
  /** A1-b: a sessao CLI falhou antes de produzir evidencia. */
  sshFailure?: MplsSshFailureKind | null;
}

export interface MplsPollingOptions {
  /** Orcamento de sessoes SSH (concorrencia, teto por hora, timeout). */
  governor?: MplsSshGovernor;
  /** Habilitação explícita por equipamento; default = repositório, senão OFF. */
  isSshEnabledForDevice?: (hostId: string) => Promise<boolean>;
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
  private readonly governor: MplsSshGovernor;

  constructor(
    private readonly collector: HuaweiVplsSnmpCollector,
    private readonly repository: MplsRepository,
    private readonly ssh?: HuaweiVsiSshService,
    private readonly options: MplsPollingOptions = {},
  ) {
    this.governor =
      options.governor ??
      new MplsSshGovernor({}, () => Date.now(), leaseAcquirerFrom(repository));
  }

  /**
   * Habilitação do CLI por equipamento. Fail-closed: repositório sem o método,
   * leitura que falha ou valor diferente de `true` mantêm o fallback desligado.
   */
  private async isSshEnabledFor(hostId: string): Promise<boolean> {
    if (this.options.isSshEnabledForDevice) {
      return (await this.options.isSshEnabledForDevice(hostId)) === true;
    }
    const probe = this.repository.isSshFallbackEnabled;
    if (!probe) return false;
    try {
      return (await probe.call(this.repository, hostId)) === true;
    } catch {
      return false;
    }
  }

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
    // A1: o fallback CLI exige politica (plataforma Huawei VRP + opt-in por
    // equipamento). `sshEnabled` sozinho nunca libera comando Huawei.
    const sshConfigured = hasMplsSshCredentials(device);
    const policy = sshConfigured
      ? await decideMplsSsh({ device, isEnabledForDevice: (id) => this.isSshEnabledFor(id) })
      : ({ allowed: false, reason: 'SSH_NOT_CONFIGURED' } as const);
    const sshAvailable = policy.allowed && Boolean(this.ssh);
    const sshDeniedReason = policy.allowed ? null : policy.reason;

    if (!snmpAvailable && !sshAvailable) {
      return {
        supported: null,
        discoveryState: 'UNKNOWN',
        sources: [],
        collectedAt: attemptedAt.toISOString(),
        error: null,
        sshDeniedReason,
      };
    }

    const [snmp, ssh, sshAttempted] = await this.readBoth(
      device,
      community,
      snmpAvailable,
      sshAvailable,
    );
    if (snmp.errorSafe) {
      await this.safeSaveFailure(device.id, attemptedAt, snmp.errorSafe);
    }

    const noServiceEvidence =
      !snmp.collection ||
      (snmp.collection.vsis.length === 0 &&
        !(snmp.collection.l2vcCircuits?.length) &&
        !(snmp.collection.ldpPeers?.length));

    // (a) CLI liberada, mas SEM leitura nesta rodada: intervalo de cadencia,
    // orcamento esgotado, concorrencia ou timeout. Nenhuma delas e evidencia —
    // gravar aqui rebaixaria um FOUND_L2VC legitimo para INCOMPLETE.
    const cadenceSkip =
      Boolean(this.ssh) && policy.allowed && !sshAttempted && noServiceEvidence;
    // (b) CLI NEGADA pela politica num equipamento que TEM SSH configurado: a
    // rodada SNMP nao trouxe evidencia de servico, entao NAO rebaixa o estado
    // que veio do CLI numa coleta anterior (FOUND_L2VC nao vira INCOMPLETE).
    const policySkip = sshConfigured && !policy.allowed && noServiceEvidence;
    // (c) A1-b: a sessao CLI FALHOU antes de produzir evidencia (auth, timeout,
    // refused, sessao encerrada). Falha de coleta nao e ausencia de servico: o
    // ultimo estado comprovado fica intacto e o motivo vai para o diagnostico.
    const sshFailureSkip = ssh.failure !== null && noServiceEvidence;
    if (cadenceSkip || policySkip || sshFailureSkip) {
      if (sshFailureSkip && !snmp.errorSafe) {
        await this.safeSaveFailure(
          device.id,
          attemptedAt,
          `SSH (${ssh.failure}) ${ssh.reading?.errorSafe ?? 'sem resposta do equipamento'}`,
        );
      }
      await this.repository.touchPolling(device.id, attemptedAt);
      return {
        supported: null,
        discoveryState: 'UNKNOWN',
        sources: snmp.collection ? ['SNMP'] : [],
        collectedAt: attemptedAt.toISOString(),
        error: snmp.errorSafe,
        sshDeniedReason,
        sshFailure: ssh.failure,
      };
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
      sshDeniedReason,
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
      { reading: HuaweiVsiSshReading | null; failure: MplsSshFailureKind | null },
      boolean,
    ]
  > {
    // SNMP primeiro: ele decide se o CLI precisa entrar como fallback agora.
    const snmp = await this.readSnmp(device, community, snmpAvailable);
    if (!sshAvailable || !this.shouldReadSsh(device.id, snmp.collection)) {
      return [snmp, { reading: null, failure: null }, false];
    }
    this.lastSshAt.set(device.id, Date.now());
    const ssh = await this.readSsh(device);
    return [snmp, { reading: ssh.reading, failure: ssh.failure }, ssh.executed];
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

  /**
   * Leitura CLI dentro do orcamento de sessoes (A1): concorrencia, teto por
   * hora e timeout. Estourar o orcamento devolve "sem evidencia" — nunca deixa
   * o polling preso nem abre sessao em rajada nas VTY do equipamento.
   */
  private async readSsh(
    device: HostRecord,
  ): Promise<{
    reading: HuaweiVsiSshReading | null;
    executed: boolean;
    failure: MplsSshFailureKind | null;
  }> {
    const ssh = this.ssh;
    if (!ssh) return { reading: null, executed: false, failure: null };
    const outcome = await this.governor.run(
      device.id,
      async () => {
        try {
          return { reading: await ssh.readVsi(device) };
        } catch (error) {
          // A1-b: excecao tambem e falha de coleta, nunca evidencia.
          const message = error instanceof Error ? error.message : null;
          return { reading: null, exception: message };
        }
      },
      () => ({ reading: null, exception: null }),
    );
    const reading = outcome.value.reading;
    const failure =
      reading === null
        ? // Sem leitura: a excecao (quando houver) classifica o motivo; se a
          // sessao nem rodou (`executed: false`), nao ha falha a relatar.
          outcome.executed
          ? classifyMplsSshFailure(outcome.value.exception)
          : null
        : mplsSshFailureOf(reading);
    return { reading, executed: outcome.executed, failure };
  }

  private async safeSaveFailure(hostId: string, occurredAt: Date, message: string): Promise<void> {
    try {
      await this.repository.saveFailure(hostId, occurredAt, message);
    } catch {
      // O erro de persistencia do aviso nao pode apagar a coleta em si.
    }
  }
}
