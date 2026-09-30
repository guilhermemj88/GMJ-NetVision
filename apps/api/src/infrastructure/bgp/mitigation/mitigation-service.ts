import type { HostRecord } from '@gmj/shared';
import type {
  BgpMitigationDiscoveryDeviceDto,
  BgpMitigationDiscoveryResponseDto,
  BgpMitigationEventDto,
  BgpMitigationHealthDto,
  BgpMitigationPatchInput,
  BgpMitigationProfileDto,
  BgpMitigationSimulateInput,
  BgpMitigationSimulationDto,
  BgpMitigationSimulationRowDto,
  BgpPeerMitigationExclusionDto,
  MitigationBlockReason,
  MitigationExclusionReason,
  MitigationPrefixStatus,
  MitigationProfileMode,
  MitigationRuntimeState,
  MitigationSimulationResult,
  MitigationWorkerState,
} from '@gmj/shared';
import type { BgpDashboardPeer } from '@gmj/shared';
import { effectiveBandwidthBps } from './bandwidth-parser';
import { persistedPeersToBgpOutcome } from './mitigation-persisted-peers';
import {
  DEFAULT_MITIGATION_RT,
  mitigationConfigFromEnv,
  mitigationThresholdBps,
  recoveryThresholdBps,
  type MitigationEngineConfig,
} from './mitigation-config';
import type {
  BgpMitigationDiscoveryService,
  MitigationDiscoveryProfile,
} from './mitigation-discovery-service';
import { prefixStatus, safetyBlocks } from './mitigation-planner';
import type {
  MitigationAddressFamily,
  MitigationPeerExclusionRecord,
  MitigationProfileRecord,
  MitigationRepository,
  MitigationRuntimeRecord,
} from './mitigation-repository';
import type { BgpMitigationSchemaProbe } from './mitigation-schema-probe';
import { evaluateTraffic } from './mitigation-state-machine';
import { SimulationCommandExecutor } from './simulation-command-executor';
import { plannedPairOf } from './mitigation-command-service';
import {
  DEFAULT_BOGON_PREFIX_LIST,
  DEFAULT_TARGET_PREFIX_LIST,
} from './mitigation-planner';

// Camada de servico da mitigacao DDoS (SIMULATION_ONLY).
//
// Nada aqui executa comando no equipamento. O unico caminho de escrita no
// Huawei seria um LiveCommandExecutor, que NAO existe nesta fase: a simulacao
// devolve apenas TEXTO de preview.
//
// A migration da mitigacao ainda nao esta aplicada em producao, entao toda
// leitura/escrita no repositorio passa por guarda: se o schema nao existir, a
// API responde de forma segura em vez de quebrar o NetVision atual.

export interface BgpMitigationServiceDeps {
  repository: MitigationRepository;
  discovery: Pick<BgpMitigationDiscoveryService, 'discoverMitigationProfiles'> &
    Partial<Pick<BgpMitigationDiscoveryService, 'discoverFromBgpOutcome'>>;
  /** Peers BGP ja persistidos (com interface correlacionada), quando houver. */
  persistedPeers?: { listForDevice(deviceId: string): Promise<BgpDashboardPeer[]> };
  hosts: { getHost(id: string): Promise<HostRecord | null> };
  schemaProbe: BgpMitigationSchemaProbe;
  repositoryKind: 'DATABASE' | 'MEMORY';
  /** Valor false enquanto a tabela da exclusao por peer nao estiver aplicada. */
  peerExclusionSchemaReady?: () => Promise<boolean>;
  /** Configuracao efetiva de execucao (executor/live write/allowlist). */
  execution?: {
    executor: 'MOCK' | 'HUAWEI';
    liveWriteEnabled: boolean;
    allowedDeviceIds: readonly string[];
  };
  /** Estado do runtime do motor AUTO (quando o processo o hospeda). */
  autoStatus?: () => {
    state: 'OFF' | 'RUNNING' | 'STOPPED';
    evaluationIntervalMs: number;
    startedAt: string | null;
    lastTickAt: string | null;
    lastSuccessfulTickAt: string | null;
    lastError: string | null;
    lastDecision: {
      at: string;
      profileId: string;
      deviceId: string;
      customer: string | null;
      outcome: string;
      reason: string | null;
      trafficBps: string | null;
      thresholdBps: string | null;
      runtimeState: string | null;
      commandStatus: string | null;
      verified: boolean;
      detail: string | null;
    } | null;
    lastAutoActivateAt: string | null;
    lastAutoActivateProfileId: string | null;
  } | null;
  workerState?: () => MitigationWorkerState;
  maxDevicesPerDiscovery?: number;
  now?: () => Date;
}

interface DiscoveryCacheEntry {
  row: MitigationDiscoveryProfile;
  deviceId: string;
  deviceName: string;
}

function bigintToString(value: bigint | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}

function asRuntimeState(value: string | null): MitigationRuntimeState | null {
  return (value as MitigationRuntimeState | null) ?? null;
}

function asBlockReason(value: string | null): MitigationBlockReason | null {
  return (value as MitigationBlockReason | null) ?? null;
}

export class BgpMitigationService {
  private readonly now: () => Date;
  private readonly maxDevicesPerDiscovery: number;
  private lastDiscoveryAt: Date | null = null;
  private readonly discoveryCache = new Map<string, DiscoveryCacheEntry>();
  private readonly executor = new SimulationCommandExecutor();

  constructor(private readonly deps: BgpMitigationServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.maxDevicesPerDiscovery = deps.maxDevicesPerDiscovery ?? 5;
  }

  private baseConfig(): MitigationEngineConfig {
    return mitigationConfigFromEnv();
  }

  /** O banco pode nao estar migrado: nada aqui pode lancar para o cliente HTTP. */
  private async schemaReady(): Promise<boolean> {
    try {
      const probe = await this.deps.schemaProbe.probe();
      return probe.databaseReady && probe.migrationReady;
    } catch {
      return false;
    }
  }

  private async read<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await operation();
    } catch {
      return fallback;
    }
  }

  async health(): Promise<BgpMitigationHealthDto> {
    const probe = await this.read(
      () => this.deps.schemaProbe.probe(),
      { migrationReady: false, databaseReady: false },
    );
    const lastDiscoveryAt = this.lastDiscoveryAt ?? (await this.derivedLastDiscoveryAt(probe));
    const profiles = await this.read(() => this.deps.repository.listProfiles(), []);
    const auto = this.deps.autoStatus?.() ?? null;
    return {
      mode: this.baseConfig().mode,
      worker: { state: this.deps.workerState?.() ?? 'STOPPED' },
      migrationReady: probe.migrationReady,
      databaseReady: probe.databaseReady,
      repository: this.deps.repositoryKind,
      lastDiscoveryAt: lastDiscoveryAt?.toISOString() ?? null,
      mitigationRt: this.baseConfig().mitigationRt,
      prefixLimit: this.baseConfig().prefixLimit,
      executor: this.deps.execution?.executor ?? 'MOCK',
      liveWriteEnabled: this.deps.execution?.liveWriteEnabled ?? false,
      allowedDeviceCount: this.deps.execution?.allowedDeviceIds.length ?? 0,
      autoEngine: auto,
      profiles: {
        total: profiles.length,
        auto: profiles.filter((profile) => profile.mode === 'AUTO').length,
        alertOnly: profiles.filter((profile) => profile.mode === 'ALERT_ONLY').length,
        disabled: profiles.filter((profile) => profile.mode === 'DISABLED').length,
      },
    };
  }

  private async derivedLastDiscoveryAt(probe: {
    migrationReady: boolean;
  }): Promise<Date | null> {
    if (!probe.migrationReady) return null;
    const profiles = await this.read(() => this.deps.repository.listProfiles(), []);
    if (!profiles.length) return null;
    const newest = profiles.reduce((latest, profile) =>
      profile.updatedAt > latest.updatedAt ? profile : latest,
    );
    return newest.updatedAt;
  }

  async listProfiles(): Promise<BgpMitigationProfileDto[]> {
    const records = await this.read(() => this.deps.repository.listProfiles(), []);
    const rows: BgpMitigationProfileDto[] = [];
    const deviceNames = new Map<string, string>();
    for (const record of records) {
      const peers = await this.read(() => this.deps.repository.listProfilePeers(record.id), []);
      const runtime = await this.read(() => this.deps.repository.getRuntime(record.id), null);
      const deviceName = await this.deviceName(record.deviceId, deviceNames);
      rows.push(this.toProfileDto(record, runtime, peers, deviceName, this.discoveryCache.get(record.id)));
    }
    return rows;
  }

  /**
   * Snapshot READ-ONLY do ultimo discovery deste profile (nodes existentes).
   * Usado pelo preflight de escrita real; `null` = sem snapshot nesta sessao.
   */
  discoverySnapshot(profileId: string): { existingNodes: number[] } | null {
    const cached = this.discoveryCache.get(profileId);
    if (!cached) return null;
    return { existingNodes: [...cached.row.existingNodes] };
  }

  async getProfile(id: string): Promise<BgpMitigationProfileDto | null> {
    const record = await this.read(() => this.deps.repository.getProfile(id), null);
    if (!record) return null;
    const peers = await this.read(() => this.deps.repository.listProfilePeers(record.id), []);
    const runtime = await this.read(() => this.deps.repository.getRuntime(record.id), null);
    const deviceName = await this.deviceName(record.deviceId, new Map());
    return this.toProfileDto(record, runtime, peers, deviceName, this.discoveryCache.get(record.id));
  }

  async discover(deviceIds: string[]): Promise<BgpMitigationDiscoveryResponseDto> {
    const targets = [...new Set(deviceIds)].slice(0, this.maxDevicesPerDiscovery);
    const results: BgpMitigationDiscoveryDeviceDto[] = [];
    const profiles: BgpMitigationProfileDto[] = [];
    const warnings: string[] = [];

    for (const deviceId of targets) {
      const host = await this.deps.hosts.getHost(deviceId);
      if (!host) {
        warnings.push(`dispositivo ${deviceId}: host nao encontrado`);
        continue;
      }
      if (!host.sshEnabled) {
        warnings.push(`${this.hostLabel(host)}: SSH nao esta habilitado`);
        continue;
      }
      try {
        const outcome = await this.discoverForDevice(deviceId, host);
        const deviceName = this.hostLabel(host);
        results.push({
          deviceId,
          deviceName,
          scannedPeers: outcome.scannedPeers,
          candidateInterfaces: outcome.candidateInterfaces,
          ignoredNoBandwidth: outcome.ignoredNoBandwidth,
          createdProfiles: outcome.createdProfiles,
          updatedProfiles: outcome.updatedProfiles,
          blockedProfiles: outcome.blockedProfiles,
          outOfScopeProfiles: outcome.outOfScopeProfiles,
          ambiguousPeers: outcome.ambiguousPeers,
          warnings: outcome.warnings,
        });
        warnings.push(...outcome.warnings);
        for (const row of outcome.profiles) {
          const dto = await this.discoveryRowToDto(row, deviceId, deviceName);
          profiles.push(dto);
          this.discoveryCache.set(dto.id, { row, deviceId, deviceName });
        }
      } catch (error) {
        warnings.push(
          `${this.hostLabel(host)}: falha no discovery (${
            error instanceof Error ? error.message : 'erro desconhecido'
          })`,
        );
      }
    }

    const discoveredAt = this.now();
    this.lastDiscoveryAt = discoveredAt;
    const totals = {
      devices: results.length,
      scannedPeers: sum(results, (item) => item.scannedPeers),
      candidateInterfaces: sum(results, (item) => item.candidateInterfaces),
      ignoredNoBandwidth: sum(results, (item) => item.ignoredNoBandwidth),
      createdProfiles: sum(results, (item) => item.createdProfiles),
      updatedProfiles: sum(results, (item) => item.updatedProfiles),
      blockedProfiles: sum(results, (item) => item.blockedProfiles),
    };
    const single = results.length === 1 ? results[0] : null;

    return {
      results,
      totals,
      profiles,
      warnings,
      discoveredAt: discoveredAt.toISOString(),
      deviceId: single?.deviceId ?? null,
      scannedPeers: single?.scannedPeers ?? totals.scannedPeers,
      candidateInterfaces: single?.candidateInterfaces ?? totals.candidateInterfaces,
      ignoredNoBandwidth: single?.ignoredNoBandwidth ?? totals.ignoredNoBandwidth,
      createdProfiles: single?.createdProfiles ?? totals.createdProfiles,
      updatedProfiles: single?.updatedProfiles ?? totals.updatedProfiles,
      blockedProfiles: single?.blockedProfiles ?? totals.blockedProfiles,
      outOfScopeProfiles: single?.outOfScopeProfiles ?? results.flatMap((item) => item.outOfScopeProfiles),
      ambiguousPeers: single?.ambiguousPeers ?? results.flatMap((item) => item.ambiguousPeers),
    };
  }

  async patchProfile(
    id: string,
    input: BgpMitigationPatchInput,
  ): Promise<BgpMitigationProfileDto | null> {
    const record = await this.deps.repository.getProfile(id);
    if (!record) return null;
    if (input.bandwidthOverrideBps !== undefined) {
      const override = input.bandwidthOverrideBps === null ? null : BigInt(input.bandwidthOverrideBps);
      await this.deps.repository.setProfileBandwidthOverride(id, override);
    }
    if (input.enabled !== undefined) {
      await this.deps.repository.setProfileEnabled(id, input.enabled);
    }
    if (input.mode !== undefined) {
      await this.deps.repository.setProfileMode(id, input.mode);
    }
    return this.getProfile(id);
  }

  /**
   * Exclusao administrativa ("nunca mitigar este peer"), POR TARGET.
   *
   * Nao roda discovery nem escrita Huawei: e apenas configuracao persistida.
   * Desmarcar limpa motivo/observacao.
   */
  async setProfileExclusion(
    id: string,
    input: { excluded: boolean; reason?: MitigationExclusionReason | null; note?: string | null },
  ): Promise<BgpMitigationProfileDto | null> {
    const record = await this.deps.repository.getProfile(id);
    if (!record) return null;
    const normalized = {
      excluded: input.excluded,
      ...(input.excluded
        ? { reason: input.reason ?? ('MANUAL' as MitigationExclusionReason) }
        : {}),
      ...(input.excluded && input.note ? { note: input.note } : {}),
    };
    await this.deps.repository.setProfileExclusion(id, normalized);
    return this.getProfile(id);
  }

  /**
   * Exclusao PREVENTIVA por peer BGP ("nunca mitigar este peer").
   *
   * Nao roda discovery e nao toca equipamento: e configuracao persistida, valida
   * para o peer mesmo sem profile e depois de ele ganhar um.
   */
  async setPeerMitigationExclusion(input: {
    peerId: string;
    deviceId: string;
    peerAddress: string;
    addressFamily: MitigationAddressFamily;
    interfaceId: string | null;
    excluded: boolean;
    reason?: MitigationExclusionReason | null;
    note?: string | null;
  }): Promise<BgpPeerMitigationExclusionDto> {
    const saved = await this.deps.repository.setPeerExclusion({
      peerId: input.peerId,
      deviceId: input.deviceId,
      peerAddress: input.peerAddress,
      addressFamily: input.addressFamily,
      interfaceId: input.interfaceId,
      excluded: input.excluded,
      ...(input.excluded
        ? { reason: input.reason ?? ('MANUAL' as MitigationExclusionReason) }
        : {}),
      ...(input.excluded && input.note ? { note: input.note } : {}),
    });
    return {
      peerId: input.peerId,
      excluded: saved !== null,
      reason: saved?.reason ?? null,
      note: saved?.note ?? null,
      deviceId: input.deviceId,
      peerAddress: input.peerAddress,
      addressFamily: input.addressFamily,
      updatedAt: saved?.updatedAt.toISOString() ?? null,
      persisted: await this.peerExclusionPersisted(),
    };
  }

  async getPeerMitigationExclusion(
    peerId: string,
  ): Promise<BgpPeerMitigationExclusionDto | null> {
    const record = await this.read(() => this.deps.repository.getPeerExclusion(peerId), null);
    if (!record) return null;
    return this.toPeerExclusionDto(record);
  }

  private async toPeerExclusionDto(
    record: MitigationPeerExclusionRecord,
  ): Promise<BgpPeerMitigationExclusionDto> {
    return {
      peerId: record.bgpPeerId,
      excluded: true,
      reason: record.reason,
      note: record.note,
      deviceId: record.deviceId,
      peerAddress: record.peerAddress,
      addressFamily: record.addressFamily,
      updatedAt: record.updatedAt.toISOString(),
      persisted: await this.peerExclusionPersisted(),
    };
  }

  /** `false` enquanto a tabela da exclusao por peer nao estiver migrada. */
  private async peerExclusionPersisted(): Promise<boolean> {
    if (this.deps.repositoryKind !== 'DATABASE' || !this.deps.peerExclusionSchemaReady) {
      return false;
    }
    return this.read(() => this.deps.peerExclusionSchemaReady!(), false);
  }

  async simulate(
    profileId: string,
    input: BgpMitigationSimulateInput,
  ): Promise<BgpMitigationSimulationDto | null> {
    const record = await this.deps.repository.getProfile(profileId);
    if (!record) return null;
    const peers = await this.read(() => this.deps.repository.listProfilePeers(record.id), []);
    const runtime = await this.read(() => this.deps.repository.getRuntime(record.id), null);
    const deviceName = await this.deviceName(record.deviceId, new Map());
    const cached = this.discoveryCache.get(record.id);

    const effectiveBps = effectiveBandwidthBps(record);
    const simulatedTrafficBps = BigInt(input.simulatedTrafficBps);
    const samples = input.samples;
    const prefixCount = input.simulatedPrefixCount ?? cached?.row.prefixCount ?? null;

    const config: MitigationEngineConfig = {
      ...this.baseConfig(),
      triggerPercent: record.triggerPercent,
      recoveryPercent: record.recoveryPercent,
      checkIntervalSeconds: record.checkIntervalSeconds,
      triggerSamples: record.triggerSamples,
      recoverySamples: record.recoverySamples,
      prefixLimit: record.prefixLimit,
      mitigationRt: record.mitigationRt,
    };
    const thresholdBps = effectiveBps === null ? null : mitigationThresholdBps(config, effectiveBps);
    const recoveryBps = effectiveBps === null ? null : recoveryThresholdBps(config, effectiveBps);
    const status = prefixStatus(prefixCount, record.prefixLimit);
    const plannedNode = runtime?.plannedNode ?? null;
    const plannedPair = plannedPairOf(runtime);
    // Exclusao administrativa: a simulacao segue disponivel para VISUALIZACAO,
    // mas nunca vira decisao operacional de mitigacao (nem gera comandos).
    const excluded = record.mitigationExcluded === true;
    // Exclusao PREVENTIVA por peer ("nunca mitigar este peer"): vale mesmo sem
    // exclusao do target e mesmo sem profile proprio para o peer.
    const peerExclusions = await this.read(
      () =>
        this.deps.repository.listPeerExclusions({
          deviceId: record.deviceId,
          peerAddresses: peers.map((peer) => peer.peerAddress),
        }),
      [],
    );
    const peerExcluded = peers.some((peer) =>
      peerExclusions.some((row) => row.peerAddress === peer.peerAddress),
    );
    // O motivo estrutural do discovery (interface ambigua / read-back falhou)
    // continua bloqueando a simulacao: nunca mitigamos sobre dado incerto.
    const structural: MitigationBlockReason | null =
      cached?.row.blockedReason === 'INTERFACE_AMBIGUOUS' ||
      cached?.row.blockedReason === 'READBACK_FAILED'
        ? (cached.row.blockedReason as MitigationBlockReason)
        : null;
    const safety = safetyBlocks({
      bandwidthBps: effectiveBps,
      prefixCount,
      prefixLimit: record.prefixLimit,
      interfaceCorrelation: 'MATCHED',
      policyExists: true,
      peerExists: peers.length > 0,
    });
    let blockedReason: MitigationBlockReason | null = structural;
    if (!blockedReason && excluded) blockedReason = 'MITIGATION_EXCLUDED';
    if (!blockedReason && peerExcluded) blockedReason = 'PEER_MITIGATION_EXCLUDED';
    if (!blockedReason && safety.blocked) blockedReason = safety.reason;
    if (!blockedReason && plannedNode === null) blockedReason = 'NO_SAFE_TEMPORARY_NODE';

    const currentlyMitigated =
      runtime?.state === 'MITIGATING' ||
      runtime?.state === 'MITIGATED' ||
      runtime?.state === 'RECOVERY_PENDING';
    const overThreshold = thresholdBps !== null && simulatedTrafficBps > thresholdBps;
    const belowRecovery = recoveryBps !== null && simulatedTrafficBps < recoveryBps;
    const decision = evaluateTraffic({
      currentlyMitigated,
      consecutiveOverThreshold: overThreshold ? samples : 0,
      consecutiveBelowRecovery: belowRecovery ? samples : 0,
      hysteresis: {
        triggerSamples: record.triggerSamples,
        recoverySamples: record.recoverySamples,
      },
    });
    const result: MitigationSimulationResult = blockedReason
      ? 'BLOCKED'
      : (decision.result as MitigationSimulationResult);

    let commandPreview: string[] = [];
    if (!blockedReason && plannedPair !== null) {
      if (result === 'WOULD_MITIGATE') {
        commandPreview = this.executor.buildMitigation(
          record.policyName,
          plannedPair,
          record.mitigationRt,
          {
            bogonPrefixList: config.bogonPrefixList,
            targetPrefixList: config.targetPrefixList,
          },
        ).commands;
      } else if (result === 'WOULD_RECOVER') {
        commandPreview = this.executor.buildRecovery(record.policyName, plannedPair).commands;
      }
    }

    const utilizationPercent =
      effectiveBps === null || effectiveBps === 0n
        ? null
        : Number((simulatedTrafficBps * 10_000n) / effectiveBps) / 100;

    const createdAt = this.now();
    const affectedPeers = peers.map((peer) => peer.peerAddress).sort();
    const primaryPeerAddress =
      peers.find((peer) => peer.primary)?.peerAddress ?? affectedPeers[0] ?? null;
    // Efeito REAL no equipamento: a policy e unica, entao TODOS os peers que a
    // usam sao atingidos - inclusive os de outros targets/interfaces.
    const policyRows = [...this.discoveryCache.values()].filter(
      (entry) => entry.row.policyName === record.policyName,
    );
    const affectedPolicyPeers = [
      ...new Set([...affectedPeers, ...policyRows.flatMap((entry) => entry.row.peerAddresses)]),
    ].sort();
    const sharedPolicyTargets =
      cached?.row.sharedPolicyTargets.filter(
        (target) => !affectedPeers.includes(target.peerAddress),
      ) ?? [];

    let simulationId: string | null = null;
    let persisted = false;
    if (await this.schemaReady()) {
      try {
        const simulation = await this.deps.repository.createSimulation({
          profileId: record.id,
          simulatedTrafficBps,
          simulatedUtilizationPercent: utilizationPercent,
          simulatedSamples: samples,
          simulatedPrefixCount: prefixCount,
          calculatedThresholdBps: thresholdBps,
          result,
          plannedNode,
          plannedPolicy: record.policyName,
          plannedRt: record.mitigationRt,
          affectedPeers,
          commandPreview,
          notificationPublished: false,
        });
        simulationId = simulation.id;
        persisted = true;
        await this.deps.repository.createEvent({
          profileId: record.id,
          simulationId: simulation.id,
          type: 'SIMULATION',
          previousState: runtime?.state ?? null,
          newState: null,
          trafficBps: simulatedTrafficBps,
          thresholdBps,
          plannedNode,
          policyName: record.policyName,
          success: result !== 'BLOCKED',
          verified: false,
          safeError: blockedReason,
        });
      } catch {
        // Tabela ausente/indisponivel: a simulacao continua valida, apenas nao
        // fica registrada. Nada de erro tecnico bruto para o operador.
        persisted = false;
      }
    }

    return {
      id: simulationId,
      persisted,
      profileId: record.id,
      customer: cached?.row.customer ?? null,
      deviceName,
      interfaceName: cached?.row.interfaceName ?? null,
      policyName: record.policyName,
      result,
      blockedReason,
      simulatedTrafficBps: simulatedTrafficBps.toString(),
      effectiveBandwidthBps: bigintToString(effectiveBps),
      utilizationPercent,
      thresholdBps: bigintToString(thresholdBps),
      thresholdPercent: record.triggerPercent,
      recoveryThresholdBps: bigintToString(recoveryBps),
      recoveryPercent: record.recoveryPercent,
      samples,
      requiredSamples: record.triggerSamples,
      prefixCount,
      prefixLimit: record.prefixLimit,
      prefixStatus: status as MitigationPrefixStatus,
      plannedNode,
      plannedBogonNode: plannedPair?.bogonNode ?? null,
      plannedMitigationNode: plannedPair?.mitigationNode ?? null,
      mitigationRt: record.mitigationRt,
      affectedPeers,
      affectedPolicyPeers,
      affectedPolicyPeerCount: affectedPolicyPeers.length,
      sharedPolicy: (cached?.row.sharedPolicy ?? false) || sharedPolicyTargets.length > 0,
      sharedPolicyTargets,
      primaryPeerAddress,
      commandPreview,
      createdAt: createdAt.toISOString(),
    };
  }

  async listSimulations(limit = 50): Promise<BgpMitigationSimulationRowDto[]> {
    const records = await this.read(() => this.deps.repository.listProfiles(), []);
    const rows: BgpMitigationSimulationRowDto[] = [];
    for (const record of records) {
      const simulations = await this.read(
        () => this.deps.repository.listSimulations(record.id, limit),
        [],
      );
      for (const simulation of simulations) {
        rows.push({
          id: simulation.id,
          profileId: simulation.profileId,
          policyName: record.policyName,
          result: simulation.result as MitigationSimulationResult,
          simulatedTrafficBps: bigintToString(simulation.simulatedTrafficBps),
          simulatedUtilizationPercent: simulation.simulatedUtilizationPercent,
          plannedNode: simulation.plannedNode,
          createdAt: simulation.createdAt.toISOString(),
        });
      }
    }
    return rows
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async listEvents(limit = 50): Promise<BgpMitigationEventDto[]> {
    const records = await this.read(() => this.deps.repository.listProfiles(), []);
    const rows: BgpMitigationEventDto[] = [];
    for (const record of records) {
      const events = await this.read(() => this.deps.repository.listEvents(record.id, limit), []);
      for (const event of events) {
        rows.push({
          id: event.id.toString(),
          profileId: event.profileId,
          simulationId: event.simulationId,
          type: event.type,
          previousState: event.previousState,
          newState: event.newState,
          trafficBps: bigintToString(event.trafficBps),
          thresholdBps: bigintToString(event.thresholdBps),
          plannedNode: event.plannedNode,
          policyName: event.policyName,
          success: event.success,
          verified: event.verified,
          safeError: event.safeError,
          createdAt: event.createdAt.toISOString(),
        });
      }
    }
    return rows
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  // A correlacao peer->interface ja esta persistida (BgpPeer.interfaceId).
  // Reusa-la evita um SSH por peer; o caminho ao vivo e o fallback.
  private async discoverForDevice(
    deviceId: string,
    host: HostRecord,
  ): Promise<Awaited<ReturnType<BgpMitigationDiscoveryService[
    'discoverMitigationProfiles'
  ]>>> {
    const fromPersisted = this.deps.discovery.discoverFromBgpOutcome;
    if (this.deps.persistedPeers && fromPersisted) {
      const peers = await this.read(
        () => this.deps.persistedPeers!.listForDevice(deviceId),
        [],
      );
      const outcome = persistedPeersToBgpOutcome(peers);
      if (outcome) return fromPersisted.call(this.deps.discovery, host, outcome);
    }
    return this.deps.discovery.discoverMitigationProfiles(host);
  }

  private hostLabel(host: HostRecord): string {
    return host.displayName || host.hostname || host.id || host.name;
  }

  private async deviceName(deviceId: string, cache: Map<string, string>): Promise<string> {
    const cached = cache.get(deviceId);
    if (cached) return cached;
    const host = await this.read(() => this.deps.hosts.getHost(deviceId), null);
    const label = host ? this.hostLabel(host) : deviceId;
    cache.set(deviceId, label);
    return label;
  }

  private toProfileDto(
    record: MitigationProfileRecord,
    runtime: MitigationRuntimeRecord | null,
    peers: { peerAddress: string; primary: boolean }[],
    deviceName: string,
    cached: DiscoveryCacheEntry | undefined,
  ): BgpMitigationProfileDto {
    const peerAddresses = peers.map((peer) => peer.peerAddress).sort();
    const row = cached?.row;
    return {
      id: record.id,
      persisted: true,
      customer: row?.customer ?? null,
      deviceId: record.deviceId,
      deviceName,
      interfaceId: record.interfaceId,
      interfaceName: row?.interfaceName ?? null,
      bogonNodes: row?.bogonNodes ?? [],
      bogonPrefixList: row?.bogonPrefixList ?? DEFAULT_BOGON_PREFIX_LIST,
      targetPrefixList: row?.targetPrefixList ?? DEFAULT_TARGET_PREFIX_LIST,
      plannedBogonNode: row?.plannedBogonNode ?? runtime?.plannedBogonNode ?? null,
      plannedMitigationNode:
        row?.plannedMitigationNode ?? runtime?.plannedMitigationNode ?? runtime?.plannedNode ?? null,
      interfaceDescription: row?.interfaceDescriptionRaw ?? null,
      detectedBandwidthBps: bigintToString(record.detectedBandwidthBps),
      bandwidthOverrideBps: bigintToString(record.bandwidthOverrideBps),
      effectiveBandwidthBps: bigintToString(effectiveBandwidthBps(record)),
      policyName: record.policyName,
      addressFamily: record.addressFamily,
      sharedPolicy: row?.sharedPolicy ?? false,
      sharedPolicyTargets: row?.sharedPolicyTargets ?? [],
      autoBlockedReason: asBlockReason(row?.autoBlockedReason ?? null),
      peerAddresses,
      primaryPeerAddress: peers.find((peer) => peer.primary)?.peerAddress ?? peerAddresses[0] ?? null,
      prefixCount: row?.prefixCount ?? null,
      prefixLimit: record.prefixLimit,
      prefixStatus: (row?.prefixStatus ?? 'UNKNOWN') as MitigationPrefixStatus,
      existingNodes: row?.existingNodes ?? [],
      mitigationNodes: row?.mitigationNodes ?? [],
      plannedNode: runtime?.plannedNode ?? null,
      readiness: row?.readiness ?? 'NOT_READY',
      blockedReason: asBlockReason(row?.blockedReason ?? null),
      // Exclusao administrativa: vive no PROFILE (por target), nunca no cache
      // do discovery — por isso nao e sobrescrita pelo discovery.
      mitigationExcluded: record.mitigationExcluded,
      mitigationExclusionReason: record.mitigationExclusionReason,
      mitigationExclusionNote: record.mitigationExclusionNote,
      runtimeState: asRuntimeState(runtime?.state ?? null),
      mode: record.mode as MitigationProfileMode,
      enabled: record.enabled,
      mitigationRt: record.mitigationRt,
      lastDiscoveryAt: this.lastDiscoveryAt?.toISOString() ?? null,
    };
  }

  private async discoveryRowToDto(
    row: MitigationDiscoveryProfile,
    deviceId: string,
    deviceName: string,
  ): Promise<BgpMitigationProfileDto> {
    const id =
      row.profileId ??
      `candidate:${deviceId}:${row.interfaceId ?? row.interfaceName ?? row.peerAddresses[0] ?? 'unknown'}`;
    const record = row.profileId
      ? await this.read(() => this.deps.repository.getProfile(row.profileId as string), null)
      : null;
    return {
      id,
      persisted: record !== null,
      customer: row.customer,
      deviceId,
      deviceName,
      interfaceId: row.interfaceId,
      interfaceName: row.interfaceName,
      interfaceDescription: row.interfaceDescriptionRaw,
      detectedBandwidthBps: bigintToString(row.detectedBandwidthBps),
      bandwidthOverrideBps: bigintToString(record?.bandwidthOverrideBps ?? null),
      effectiveBandwidthBps: bigintToString(
        record ? effectiveBandwidthBps(record) : row.effectiveBandwidthBps,
      ),
      policyName: row.policyName,
      addressFamily: row.addressFamily,
      sharedPolicy: row.sharedPolicy,
      sharedPolicyTargets: row.sharedPolicyTargets,
      autoBlockedReason: asBlockReason(row.autoBlockedReason),
      peerAddresses: [...row.peerAddresses],
      primaryPeerAddress: row.peerAddresses[0] ?? null,
      prefixCount: row.prefixCount,
      prefixLimit: row.prefixLimit,
      prefixStatus: row.prefixStatus as MitigationPrefixStatus,
      existingNodes: [...row.existingNodes],
      mitigationNodes: [...row.mitigationNodes],
      plannedNode: row.plannedNode,
      readiness: row.readiness,
      blockedReason: asBlockReason(row.blockedReason),
      mitigationExcluded: record?.mitigationExcluded ?? false,
      mitigationExclusionReason: record?.mitigationExclusionReason ?? null,
      mitigationExclusionNote: record?.mitigationExclusionNote ?? null,
      runtimeState: null,
      mode: (record?.mode as MitigationProfileMode | undefined) ?? 'ALERT_ONLY',
      enabled: record?.enabled ?? true,
      mitigationRt: record?.mitigationRt ?? DEFAULT_MITIGATION_RT,
      lastDiscoveryAt: this.now().toISOString(),
    };
  }
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}
