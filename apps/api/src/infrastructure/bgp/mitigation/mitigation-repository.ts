import type {
  BandwidthSource,
  MitigationProfileMode,
  MitigationState,
  SimulationResult,
} from './mitigation-types';

export type MitigationAddressFamily = 'IPV4' | 'IPV6';

export interface MitigationProfileRecord {
  id: string;
  deviceId: string;
  policyName: string;
  interfaceId: string | null;
  /** Familia do alvo: IPv4 e IPv6 sao targets independentes. */
  addressFamily: MitigationAddressFamily;
  detectedBandwidthBps: bigint | null;
  bandwidthSource: BandwidthSource;
  bandwidthOverrideBps: bigint | null;
  prefixLimit: number;
  mode: MitigationProfileMode;
  enabled: boolean;
  triggerPercent: number;
  recoveryPercent: number;
  triggerSamples: number;
  recoverySamples: number;
  checkIntervalSeconds: number;
  mitigationRt: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MitigationProfileInput {
  deviceId: string;
  policyName: string;
  /** O alvo sempre tem interface: e a chave do target junto com a familia. */
  interfaceId: string;
  addressFamily?: MitigationAddressFamily;
  detectedBandwidthBps?: bigint | null;
  bandwidthSource?: BandwidthSource;
  bandwidthOverrideBps?: bigint | null;
  prefixLimit?: number;
  mode?: MitigationProfileMode;
  enabled?: boolean;
  triggerPercent?: number;
  recoveryPercent?: number;
  triggerSamples?: number;
  recoverySamples?: number;
  checkIntervalSeconds?: number;
  mitigationRt?: string;
}

export interface MitigationProfilePeerRecord {
  id: string;
  profileId: string;
  peerId: string | null;
  peerAddress: string;
  addressFamily: MitigationAddressFamily;
  primary: boolean;
}

export interface MitigationPeerInput {
  peerId?: string | null;
  peerAddress: string;
  addressFamily?: MitigationAddressFamily;
  primary?: boolean;
}

export interface MitigationRuntimeRecord {
  profileId: string;
  state: MitigationState;
  currentTrafficBps: bigint | null;
  peakTrafficBps: bigint | null;
  triggerCounter: number;
  recoveryCounter: number;
  /** Node de PERMIT que aplica a RT (compatibilidade). */
  plannedNode: number | null;
  /** Node de DENY (BOGONS) do par planejado. */
  plannedBogonNode: number | null;
  /** Node de PERMIT (PREFIX8to24 + RT) do par planejado. */
  plannedMitigationNode: number | null;
  lastSampleAt: Date | null;
  lastValidatedAt: Date | null;
  lastReconciledAt: Date | null;
  safeError: string | null;
  updatedAt: Date;
}

export interface MitigationRuntimePatch {
  state?: MitigationState;
  currentTrafficBps?: bigint | null;
  peakTrafficBps?: bigint | null;
  triggerCounter?: number;
  recoveryCounter?: number;
  plannedNode?: number | null;
  plannedBogonNode?: number | null;
  plannedMitigationNode?: number | null;
  lastSampleAt?: Date | null;
  lastValidatedAt?: Date | null;
  lastReconciledAt?: Date | null;
  safeError?: string | null;
}

export interface MitigationSimulationRecord {
  id: string;
  profileId: string;
  userId: string | null;
  simulatedTrafficBps: bigint | null;
  simulatedUtilizationPercent: number | null;
  simulatedSamples: number | null;
  simulatedPrefixCount: number | null;
  calculatedThresholdBps: bigint | null;
  result: SimulationResult;
  plannedNode: number | null;
  plannedPolicy: string | null;
  plannedRt: string | null;
  affectedPeers: string[] | null;
  commandPreview: string[] | null;
  notificationPublished: boolean;
  createdAt: Date;
}

export interface MitigationSimulationInput {
  profileId: string;
  userId?: string | null;
  simulatedTrafficBps?: bigint | null;
  simulatedUtilizationPercent?: number | null;
  simulatedSamples?: number | null;
  simulatedPrefixCount?: number | null;
  calculatedThresholdBps?: bigint | null;
  result: SimulationResult;
  plannedNode?: number | null;
  plannedPolicy?: string | null;
  plannedRt?: string | null;
  affectedPeers?: string[] | null;
  commandPreview?: string[] | null;
  notificationPublished?: boolean;
}

export interface MitigationEventRecord {
  id: bigint;
  profileId: string;
  simulationId: string | null;
  type: string;
  previousState: MitigationState | null;
  newState: MitigationState | null;
  trafficBps: bigint | null;
  thresholdBps: bigint | null;
  plannedNode: number | null;
  policyName: string | null;
  success: boolean;
  verified: boolean;
  safeError: string | null;
  createdAt: Date;
}

export interface MitigationEventInput {
  profileId: string;
  simulationId?: string | null;
  type: string;
  previousState?: MitigationState | null;
  newState?: MitigationState | null;
  trafficBps?: bigint | null;
  thresholdBps?: bigint | null;
  plannedNode?: number | null;
  policyName?: string | null;
  success?: boolean;
  verified?: boolean;
  safeError?: string | null;
}

export interface MitigationProfileListFilter {
  deviceId?: string;
  enabled?: boolean;
}

/**
 * Porta de persistência do motor de mitigação. O worker e a API dependem desta
 * interface — nunca do Prisma diretamente.
 */
export interface MitigationRepository {
  upsertProfile(input: MitigationProfileInput): Promise<MitigationProfileRecord>;
  getProfile(id: string): Promise<MitigationProfileRecord | null>;
  listProfiles(filter?: MitigationProfileListFilter): Promise<MitigationProfileRecord[]>;
  setProfileMode(id: string, mode: MitigationProfileMode): Promise<void>;
  setProfileEnabled(id: string, enabled: boolean): Promise<void>;
  setProfileBandwidthOverride(id: string, bandwidthOverrideBps: bigint | null): Promise<void>;
  replaceProfilePeers(
    profileId: string,
    peers: MitigationPeerInput[],
  ): Promise<MitigationProfilePeerRecord[]>;
  listProfilePeers(profileId: string): Promise<MitigationProfilePeerRecord[]>;
  upsertRuntime(profileId: string, patch: MitigationRuntimePatch): Promise<MitigationRuntimeRecord>;
  getRuntime(profileId: string): Promise<MitigationRuntimeRecord | null>;
  listRuntimeByState(states: MitigationState[]): Promise<MitigationRuntimeRecord[]>;
  createSimulation(input: MitigationSimulationInput): Promise<MitigationSimulationRecord>;
  listSimulations(profileId: string, limit?: number): Promise<MitigationSimulationRecord[]>;
  createEvent(input: MitigationEventInput): Promise<MitigationEventRecord>;
  listEvents(profileId: string, limit?: number): Promise<MitigationEventRecord[]>;
  deleteProfile(id: string): Promise<void>;
}
