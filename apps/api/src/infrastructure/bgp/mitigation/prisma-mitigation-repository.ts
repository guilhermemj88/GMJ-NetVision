import { Prisma, PrismaClient } from '../../../generated/prisma/index.js';
import type {
  MitigationAddressFamily,
  MitigationEventInput,
  MitigationExclusionInput,
  MitigationEventRecord,
  MitigationPeerExclusionFilter,
  MitigationPeerExclusionInput,
  MitigationPeerExclusionRecord,
  MitigationPeerInput,
  MitigationProfileInput,
  MitigationProfileListFilter,
  MitigationProfilePeerRecord,
  MitigationProfileRecord,
  MitigationRepository,
  MitigationRuntimePatch,
  MitigationRuntimeRecord,
  MitigationSimulationInput,
  MitigationSimulationRecord,
} from './mitigation-repository';
import type {
  MitigationExclusionReason,
  MitigationProfileMode,
  MitigationState,
  SimulationResult,
} from './mitigation-types';

type ProfileRow = Prisma.BgpMitigationProfileGetPayload<Record<string, never>>;
type PeerRow = Prisma.BgpMitigationProfilePeerGetPayload<Record<string, never>>;
type RuntimeRow = Prisma.BgpMitigationRuntimeGetPayload<Record<string, never>>;
type SimulationRow = Prisma.BgpMitigationSimulationGetPayload<Record<string, never>>;
type EventRow = Prisma.BgpMitigationEventGetPayload<Record<string, never>>;

type PeerExclusionRow = Prisma.BgpMitigationPeerExclusionGetPayload<Record<string, never>>;

function mapProfile(row: ProfileRow): MitigationProfileRecord {
  return {
    id: row.id,
    deviceId: row.deviceId,
    policyName: row.policyName,
    interfaceId: row.interfaceId,
    addressFamily: row.addressFamily as MitigationAddressFamily,
    detectedBandwidthBps: row.detectedBandwidthBps,
    bandwidthSource: row.bandwidthSource,
    bandwidthOverrideBps: row.bandwidthOverrideBps,
    prefixLimit: row.prefixLimit,
    mode: row.mode as MitigationProfileMode,
    enabled: row.enabled,
    triggerPercent: row.triggerPercent,
    recoveryPercent: row.recoveryPercent,
    triggerSamples: row.triggerSamples,
    recoverySamples: row.recoverySamples,
    checkIntervalSeconds: row.checkIntervalSeconds,
    mitigationRt: row.mitigationRt,
    mitigationExcluded: row.mitigationExcluded,
    mitigationExclusionReason:
      row.mitigationExclusionReason as MitigationProfileRecord['mitigationExclusionReason'],
    mitigationExclusionNote: row.mitigationExclusionNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapPeerExclusion(row: PeerExclusionRow): MitigationPeerExclusionRecord {
  return {
    id: row.id,
    bgpPeerId: row.bgpPeerId,
    deviceId: row.deviceId,
    peerAddress: row.peerAddress,
    addressFamily: row.addressFamily as MitigationAddressFamily,
    interfaceId: row.interfaceId,
    reason: row.reason as MitigationExclusionReason,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapPeer(row: PeerRow): MitigationProfilePeerRecord {  return {
    id: row.id,
    profileId: row.profileId,
    peerId: row.peerId,
    peerAddress: row.peerAddress,
    addressFamily: row.addressFamily as MitigationAddressFamily,
    primary: row.primary,
  };
}

function mapRuntime(row: RuntimeRow): MitigationRuntimeRecord {
  return {
    profileId: row.profileId,
    state: row.state as MitigationState,
    currentTrafficBps: row.currentTrafficBps,
    peakTrafficBps: row.peakTrafficBps,
    triggerCounter: row.triggerCounter,
    recoveryCounter: row.recoveryCounter,
    plannedNode: row.plannedNode,
    plannedBogonNode: row.plannedBogonNode,
    plannedMitigationNode: row.plannedMitigationNode,
    lastSampleAt: row.lastSampleAt,
    lastValidatedAt: row.lastValidatedAt,
    lastReconciledAt: row.lastReconciledAt,
    safeError: row.safeError,
    updatedAt: row.updatedAt,
  };
}

function mapSimulation(row: SimulationRow): MitigationSimulationRecord {
  return {
    id: row.id,
    profileId: row.profileId,
    userId: row.userId,
    simulatedTrafficBps: row.simulatedTrafficBps,
    simulatedUtilizationPercent: row.simulatedUtilizationPercent,
    simulatedSamples: row.simulatedSamples,
    simulatedPrefixCount: row.simulatedPrefixCount,
    calculatedThresholdBps: row.calculatedThresholdBps,
    result: row.result as SimulationResult,
    plannedNode: row.plannedNode,
    plannedPolicy: row.plannedPolicy,
    plannedRt: row.plannedRt,
    affectedPeers: (row.affectedPeers as string[] | null) ?? null,
    commandPreview: (row.commandPreview as string[] | null) ?? null,
    notificationPublished: row.notificationPublished,
    createdAt: row.createdAt,
  };
}

function mapEvent(row: EventRow): MitigationEventRecord {
  return {
    id: row.id,
    profileId: row.profileId,
    simulationId: row.simulationId,
    type: row.type,
    previousState: row.previousState as MitigationState | null,
    newState: row.newState as MitigationState | null,
    trafficBps: row.trafficBps,
    thresholdBps: row.thresholdBps,
    plannedNode: row.plannedNode,
    policyName: row.policyName,
    success: row.success,
    verified: row.verified,
    safeError: row.safeError,
    createdAt: row.createdAt,
  };
}

/**
 * Adaptador Prisma do repositório de mitigação. O worker e a API dependem da
 * interface `MitigationRepository`, não desta classe.
 */
export class PrismaMitigationRepository implements MitigationRepository {
  constructor(private readonly prisma = new PrismaClient()) {}

  async disconnect(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async upsertProfile(input: MitigationProfileInput): Promise<MitigationProfileRecord> {
    const row = await this.prisma.bgpMitigationProfile.upsert({
      where: {
        deviceId_interfaceId_addressFamily_policyName: {
          deviceId: input.deviceId,
          interfaceId: input.interfaceId,
          addressFamily: input.addressFamily ?? 'IPV4',
          policyName: input.policyName,
        },
      },
      create: {
        deviceId: input.deviceId,
        policyName: input.policyName,
        interfaceId: input.interfaceId ?? null,
        detectedBandwidthBps: input.detectedBandwidthBps ?? null,
        bandwidthSource: input.bandwidthSource ?? 'UNKNOWN',
        bandwidthOverrideBps: input.bandwidthOverrideBps ?? null,
        prefixLimit: input.prefixLimit ?? 100,
        mode: input.mode ?? 'ALERT_ONLY',
        enabled: input.enabled ?? true,
        triggerPercent: input.triggerPercent ?? 90,
        recoveryPercent: input.recoveryPercent ?? 70,
        triggerSamples: input.triggerSamples ?? 3,
        recoverySamples: input.recoverySamples ?? 12,
        checkIntervalSeconds: input.checkIntervalSeconds ?? 5,
        mitigationRt: input.mitigationRt ?? '268568:660',
      },
      update: {
        ...(input.interfaceId === undefined ? {} : { interfaceId: input.interfaceId }),
        ...(input.addressFamily === undefined ? {} : { addressFamily: input.addressFamily }),
        ...(input.detectedBandwidthBps === undefined
          ? {}
          : { detectedBandwidthBps: input.detectedBandwidthBps }),
        ...(input.bandwidthSource === undefined ? {} : { bandwidthSource: input.bandwidthSource }),
        ...(input.bandwidthOverrideBps === undefined
          ? {}
          : { bandwidthOverrideBps: input.bandwidthOverrideBps }),
        ...(input.prefixLimit === undefined ? {} : { prefixLimit: input.prefixLimit }),
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.triggerPercent === undefined ? {} : { triggerPercent: input.triggerPercent }),
        ...(input.recoveryPercent === undefined ? {} : { recoveryPercent: input.recoveryPercent }),
        ...(input.triggerSamples === undefined ? {} : { triggerSamples: input.triggerSamples }),
        ...(input.recoverySamples === undefined ? {} : { recoverySamples: input.recoverySamples }),
        ...(input.checkIntervalSeconds === undefined
          ? {}
          : { checkIntervalSeconds: input.checkIntervalSeconds }),
        ...(input.mitigationRt === undefined ? {} : { mitigationRt: input.mitigationRt }),
      },
    });
    return mapProfile(row);
  }

  async getProfile(id: string): Promise<MitigationProfileRecord | null> {
    const row = await this.prisma.bgpMitigationProfile.findUnique({ where: { id } });
    return row ? mapProfile(row) : null;
  }

  async listProfiles(filter: MitigationProfileListFilter = {}): Promise<MitigationProfileRecord[]> {
    const rows = await this.prisma.bgpMitigationProfile.findMany({
      where: {
        ...(filter.deviceId === undefined ? {} : { deviceId: filter.deviceId }),
        ...(filter.enabled === undefined ? {} : { enabled: filter.enabled }),
      },
      orderBy: { policyName: 'asc' },
    });
    return rows.map(mapProfile);
  }

  async setProfileMode(id: string, mode: MitigationProfileMode): Promise<void> {
    await this.prisma.bgpMitigationProfile.update({ where: { id }, data: { mode } });
  }

  async setProfileEnabled(id: string, enabled: boolean): Promise<void> {
    await this.prisma.bgpMitigationProfile.update({ where: { id }, data: { enabled } });
  }

  async setProfileExclusion(id: string, input: MitigationExclusionInput): Promise<void> {
    const excluded = input.excluded;
    await this.prisma.bgpMitigationProfile.update({
      where: { id },
      data: {
        mitigationExcluded: excluded,
        mitigationExclusionReason: excluded ? (input.reason ?? 'MANUAL') : null,
        mitigationExclusionNote: excluded ? (input.note ?? null) : null,
      },
    });
  }

  async setProfileBandwidthOverride(
    id: string,
    bandwidthOverrideBps: bigint | null,
  ): Promise<void> {
    await this.prisma.bgpMitigationProfile.update({
      where: { id },
      data: { bandwidthOverrideBps },
    });
  }

  async setPeerExclusion(
    input: MitigationPeerExclusionInput,
  ): Promise<MitigationPeerExclusionRecord | null> {
    if (!input.excluded) {
      await this.prisma.bgpMitigationPeerExclusion.deleteMany({
        where: { bgpPeerId: input.peerId },
      });
      return null;
    }
    const data = {
      deviceId: input.deviceId,
      peerAddress: input.peerAddress,
      addressFamily: input.addressFamily,
      interfaceId: input.interfaceId,
      reason: (input.reason ?? 'MANUAL') as MitigationExclusionReason,
      note: input.note ?? null,
    };
    const row = await this.prisma.bgpMitigationPeerExclusion.upsert({
      where: { bgpPeerId: input.peerId },
      create: { bgpPeerId: input.peerId, ...data },
      update: data,
    });
    return mapPeerExclusion(row);
  }

  async getPeerExclusion(peerId: string): Promise<MitigationPeerExclusionRecord | null> {
    const row = await this.prisma.bgpMitigationPeerExclusion.findUnique({
      where: { bgpPeerId: peerId },
    });
    return row ? mapPeerExclusion(row) : null;
  }

  async listPeerExclusions(
    filter: MitigationPeerExclusionFilter = {},
  ): Promise<MitigationPeerExclusionRecord[]> {
    const rows = await this.prisma.bgpMitigationPeerExclusion.findMany({
      where: {
        ...(filter.deviceId === undefined ? {} : { deviceId: filter.deviceId }),
        ...(filter.peerAddresses === undefined
          ? {}
          : { peerAddress: { in: filter.peerAddresses } }),
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(mapPeerExclusion);
  }

  async replaceProfilePeers(
    profileId: string,
    peers: MitigationPeerInput[],
  ): Promise<MitigationProfilePeerRecord[]> {
    await this.prisma.$transaction([
      this.prisma.bgpMitigationProfilePeer.deleteMany({ where: { profileId } }),
      this.prisma.bgpMitigationProfilePeer.createMany({
        data: peers.map((peer) => ({
          profileId,
          peerId: peer.peerId ?? null,
          peerAddress: peer.peerAddress,
          addressFamily: peer.addressFamily ?? 'IPV4',
          primary: peer.primary ?? false,
        })),
      }),
    ]);
    return this.listProfilePeers(profileId);
  }

  async listProfilePeers(profileId: string): Promise<MitigationProfilePeerRecord[]> {
    const rows = await this.prisma.bgpMitigationProfilePeer.findMany({
      where: { profileId },
      orderBy: { peerAddress: 'asc' },
    });
    return rows.map(mapPeer);
  }

  async upsertRuntime(
    profileId: string,
    patch: MitigationRuntimePatch,
  ): Promise<MitigationRuntimeRecord> {
    const row = await this.prisma.bgpMitigationRuntime.upsert({
      where: { profileId },
      create: {
        profileId,
        state: patch.state ?? 'NORMAL',
        currentTrafficBps: patch.currentTrafficBps ?? null,
        peakTrafficBps: patch.peakTrafficBps ?? null,
        triggerCounter: patch.triggerCounter ?? 0,
        recoveryCounter: patch.recoveryCounter ?? 0,
        plannedNode: patch.plannedNode ?? null,
        plannedBogonNode: patch.plannedBogonNode ?? null,
        plannedMitigationNode: patch.plannedMitigationNode ?? null,
        lastSampleAt: patch.lastSampleAt ?? null,
        lastValidatedAt: patch.lastValidatedAt ?? null,
        lastReconciledAt: patch.lastReconciledAt ?? null,
        safeError: patch.safeError ?? null,
      },
      update: {
        ...(patch.state === undefined ? {} : { state: patch.state }),
        ...(patch.currentTrafficBps === undefined
          ? {}
          : { currentTrafficBps: patch.currentTrafficBps }),
        ...(patch.peakTrafficBps === undefined ? {} : { peakTrafficBps: patch.peakTrafficBps }),
        ...(patch.triggerCounter === undefined ? {} : { triggerCounter: patch.triggerCounter }),
        ...(patch.recoveryCounter === undefined ? {} : { recoveryCounter: patch.recoveryCounter }),
        ...(patch.plannedNode === undefined ? {} : { plannedNode: patch.plannedNode }),
        ...(patch.plannedBogonNode === undefined ? {} : { plannedBogonNode: patch.plannedBogonNode }),
        ...(patch.plannedMitigationNode === undefined
          ? {}
          : { plannedMitigationNode: patch.plannedMitigationNode }),
        ...(patch.lastSampleAt === undefined ? {} : { lastSampleAt: patch.lastSampleAt }),
        ...(patch.lastValidatedAt === undefined ? {} : { lastValidatedAt: patch.lastValidatedAt }),
        ...(patch.lastReconciledAt === undefined
          ? {}
          : { lastReconciledAt: patch.lastReconciledAt }),
        ...(patch.safeError === undefined ? {} : { safeError: patch.safeError }),
      },
    });
    return mapRuntime(row);
  }

  async getRuntime(profileId: string): Promise<MitigationRuntimeRecord | null> {
    const row = await this.prisma.bgpMitigationRuntime.findUnique({ where: { profileId } });
    return row ? mapRuntime(row) : null;
  }

  async listRuntimeByState(states: MitigationState[]): Promise<MitigationRuntimeRecord[]> {
    const rows = await this.prisma.bgpMitigationRuntime.findMany({
      where: { state: { in: states } },
    });
    return rows.map(mapRuntime);
  }

  async createSimulation(input: MitigationSimulationInput): Promise<MitigationSimulationRecord> {
    const row = await this.prisma.bgpMitigationSimulation.create({
      data: {
        profileId: input.profileId,
        userId: input.userId ?? null,
        simulatedTrafficBps: input.simulatedTrafficBps ?? null,
        simulatedUtilizationPercent: input.simulatedUtilizationPercent ?? null,
        simulatedSamples: input.simulatedSamples ?? null,
        simulatedPrefixCount: input.simulatedPrefixCount ?? null,
        calculatedThresholdBps: input.calculatedThresholdBps ?? null,
        result: input.result,
        plannedNode: input.plannedNode ?? null,
        plannedPolicy: input.plannedPolicy ?? null,
        plannedRt: input.plannedRt ?? null,
        affectedPeers: input.affectedPeers ?? Prisma.JsonNull,
        commandPreview: input.commandPreview ?? Prisma.JsonNull,
        notificationPublished: input.notificationPublished ?? false,
      },
    });
    return mapSimulation(row);
  }

  async listSimulations(profileId: string, limit = 100): Promise<MitigationSimulationRecord[]> {
    const rows = await this.prisma.bgpMitigationSimulation.findMany({
      where: { profileId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(mapSimulation);
  }

  async createEvent(input: MitigationEventInput): Promise<MitigationEventRecord> {
    const row = await this.prisma.bgpMitigationEvent.create({
      data: {
        profileId: input.profileId,
        simulationId: input.simulationId ?? null,
        type: input.type,
        previousState: input.previousState ?? null,
        newState: input.newState ?? null,
        trafficBps: input.trafficBps ?? null,
        thresholdBps: input.thresholdBps ?? null,
        plannedNode: input.plannedNode ?? null,
        policyName: input.policyName ?? null,
        success: input.success ?? false,
        verified: input.verified ?? false,
        safeError: input.safeError ?? null,
      },
    });
    return mapEvent(row);
  }

  async listEvents(profileId: string, limit = 100): Promise<MitigationEventRecord[]> {
    const rows = await this.prisma.bgpMitigationEvent.findMany({
      where: { profileId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(mapEvent);
  }

  async deleteProfile(id: string): Promise<void> {
    await this.prisma.bgpMitigationProfile.delete({ where: { id } });
  }
}
