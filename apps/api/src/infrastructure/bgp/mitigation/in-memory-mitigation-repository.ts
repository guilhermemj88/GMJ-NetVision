import type {
  MitigationEventInput,
  MitigationEventRecord,
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

interface InMemoryStore {
  profiles: Map<string, MitigationProfileRecord>;
  peers: Map<string, MitigationProfilePeerRecord>;
  runtime: Map<string, MitigationRuntimeRecord>;
  simulations: Map<string, MitigationSimulationRecord>;
  events: MitigationEventRecord[];
  nextProfile: number;
  nextPeer: number;
  nextSimulation: number;
  nextEvent: bigint;
}

function createStore(): InMemoryStore {
  return {
    profiles: new Map(),
    peers: new Map(),
    runtime: new Map(),
    simulations: new Map(),
    events: [],
    nextProfile: 1,
    nextPeer: 1,
    nextSimulation: 1,
    nextEvent: 1n,
  };
}

/**
 * Implementação em memória para testes e para o modo SIMULAÇÃO (sem banco).
 *
 * A instância pode compartilhar um mesmo `store` com outra instância — é assim
 * que o teste "recuperar estado após nova instância do repository" valida que o
 * estado vem do repositório, nunca de variável em memória do processo.
 */
export class InMemoryMitigationRepository implements MitigationRepository {
  private readonly store: InMemoryStore;

  constructor(store?: InMemoryStore) {
    this.store = store ?? createStore();
  }

  /** Referência ao store compartilhado (para construir uma "nova instância"). */
  get storeRef(): InMemoryStore {
    return this.store;
  }

  async upsertProfile(input: MitigationProfileInput): Promise<MitigationProfileRecord> {
    const existing = [...this.store.profiles.values()].find(
      (profile) => profile.deviceId === input.deviceId && profile.policyName === input.policyName,
    );
    const now = new Date();
    if (existing) {
      const updated: MitigationProfileRecord = {
        ...existing,
        interfaceId: input.interfaceId ?? existing.interfaceId,
        detectedBandwidthBps: input.detectedBandwidthBps ?? existing.detectedBandwidthBps,
        bandwidthSource: input.bandwidthSource ?? existing.bandwidthSource,
        bandwidthOverrideBps: input.bandwidthOverrideBps ?? existing.bandwidthOverrideBps,
        prefixLimit: input.prefixLimit ?? existing.prefixLimit,
        mode: input.mode ?? existing.mode,
        enabled: input.enabled ?? existing.enabled,
        triggerPercent: input.triggerPercent ?? existing.triggerPercent,
        recoveryPercent: input.recoveryPercent ?? existing.recoveryPercent,
        triggerSamples: input.triggerSamples ?? existing.triggerSamples,
        recoverySamples: input.recoverySamples ?? existing.recoverySamples,
        checkIntervalSeconds: input.checkIntervalSeconds ?? existing.checkIntervalSeconds,
        mitigationRt: input.mitigationRt ?? existing.mitigationRt,
        updatedAt: now,
      };
      this.store.profiles.set(existing.id, updated);
      return updated;
    }

    const record: MitigationProfileRecord = {
      id: `profile-${this.store.nextProfile++}`,
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
      createdAt: now,
      updatedAt: now,
    };
    this.store.profiles.set(record.id, record);
    return record;
  }

  async getProfile(id: string): Promise<MitigationProfileRecord | null> {
    return this.store.profiles.get(id) ?? null;
  }

  async listProfiles(filter: MitigationProfileListFilter = {}): Promise<MitigationProfileRecord[]> {
    return [...this.store.profiles.values()].filter((profile) => {
      if (filter.deviceId !== undefined && profile.deviceId !== filter.deviceId) return false;
      if (filter.enabled !== undefined && profile.enabled !== filter.enabled) return false;
      return true;
    });
  }

  async setProfileMode(id: string, mode: MitigationProfileRecord['mode']): Promise<void> {
    const profile = this.store.profiles.get(id);
    if (profile) profile.mode = mode;
  }

  async setProfileEnabled(id: string, enabled: boolean): Promise<void> {
    const profile = this.store.profiles.get(id);
    if (profile) profile.enabled = enabled;
  }

  async setProfileBandwidthOverride(
    id: string,
    bandwidthOverrideBps: bigint | null,
  ): Promise<void> {
    const profile = this.store.profiles.get(id);
    if (profile) profile.bandwidthOverrideBps = bandwidthOverrideBps;
  }

  async replaceProfilePeers(
    profileId: string,
    peers: MitigationPeerInput[],
  ): Promise<MitigationProfilePeerRecord[]> {
    for (const [peerId, peer] of this.store.peers) {
      if (peer.profileId === profileId) this.store.peers.delete(peerId);
    }
    const records = peers.map<MitigationProfilePeerRecord>((peer) => ({
      id: `peer-${this.store.nextPeer++}`,
      profileId,
      peerId: peer.peerId ?? null,
      peerAddress: peer.peerAddress,
      addressFamily: peer.addressFamily ?? 'IPV4',
      primary: peer.primary ?? false,
    }));
    for (const record of records) this.store.peers.set(record.id, record);
    return records;
  }

  async listProfilePeers(profileId: string): Promise<MitigationProfilePeerRecord[]> {
    return [...this.store.peers.values()].filter((peer) => peer.profileId === profileId);
  }

  async upsertRuntime(
    profileId: string,
    patch: MitigationRuntimePatch,
  ): Promise<MitigationRuntimeRecord> {
    const existing = this.store.runtime.get(profileId);
    if (existing) {
      const updated: MitigationRuntimeRecord = {
        ...existing,
        state: patch.state ?? existing.state,
        currentTrafficBps: patch.currentTrafficBps ?? existing.currentTrafficBps,
        peakTrafficBps: patch.peakTrafficBps ?? existing.peakTrafficBps,
        triggerCounter: patch.triggerCounter ?? existing.triggerCounter,
        recoveryCounter: patch.recoveryCounter ?? existing.recoveryCounter,
        plannedNode: patch.plannedNode ?? existing.plannedNode,
        lastSampleAt: patch.lastSampleAt ?? existing.lastSampleAt,
        lastValidatedAt: patch.lastValidatedAt ?? existing.lastValidatedAt,
        lastReconciledAt: patch.lastReconciledAt ?? existing.lastReconciledAt,
        safeError: patch.safeError ?? existing.safeError,
        updatedAt: new Date(),
      };
      this.store.runtime.set(profileId, updated);
      return updated;
    }
    const record: MitigationRuntimeRecord = {
      profileId,
      state: patch.state ?? 'NORMAL',
      currentTrafficBps: patch.currentTrafficBps ?? null,
      peakTrafficBps: patch.peakTrafficBps ?? null,
      triggerCounter: patch.triggerCounter ?? 0,
      recoveryCounter: patch.recoveryCounter ?? 0,
      plannedNode: patch.plannedNode ?? null,
      lastSampleAt: patch.lastSampleAt ?? null,
      lastValidatedAt: patch.lastValidatedAt ?? null,
      lastReconciledAt: patch.lastReconciledAt ?? null,
      safeError: patch.safeError ?? null,
      updatedAt: new Date(),
    };
    this.store.runtime.set(profileId, record);
    return record;
  }

  async getRuntime(profileId: string): Promise<MitigationRuntimeRecord | null> {
    return this.store.runtime.get(profileId) ?? null;
  }

  async listRuntimeByState(states: MitigationRuntimeRecord['state'][]): Promise<MitigationRuntimeRecord[]> {
    return [...this.store.runtime.values()].filter((runtime) => states.includes(runtime.state));
  }

  async createSimulation(input: MitigationSimulationInput): Promise<MitigationSimulationRecord> {
    const record: MitigationSimulationRecord = {
      id: `simulation-${this.store.nextSimulation++}`,
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
      affectedPeers: input.affectedPeers ?? null,
      commandPreview: input.commandPreview ?? null,
      notificationPublished: input.notificationPublished ?? false,
      createdAt: new Date(),
    };
    this.store.simulations.set(record.id, record);
    return record;
  }

  async listSimulations(profileId: string, limit = 100): Promise<MitigationSimulationRecord[]> {
    return [...this.store.simulations.values()]
      .filter((simulation) => simulation.profileId === profileId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async createEvent(input: MitigationEventInput): Promise<MitigationEventRecord> {
    const record: MitigationEventRecord = {
      id: this.store.nextEvent++,
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
      createdAt: new Date(),
    };
    this.store.events.push(record);
    return record;
  }

  async listEvents(profileId: string, limit = 100): Promise<MitigationEventRecord[]> {
    return this.store.events
      .filter((event) => event.profileId === profileId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async deleteProfile(id: string): Promise<void> {
    this.store.profiles.delete(id);
    for (const [peerId, peer] of this.store.peers) {
      if (peer.profileId === id) this.store.peers.delete(peerId);
    }
    this.store.runtime.delete(id);
    for (const [simulationId, simulation] of this.store.simulations) {
      if (simulation.profileId === id) this.store.simulations.delete(simulationId);
    }
    this.store.events = this.store.events.filter((event) => event.profileId !== id);
  }
}
