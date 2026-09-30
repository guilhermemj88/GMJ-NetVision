import type {
  MitigationEventInput,
  MitigationExclusionInput,
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
import type { MitigationProfileMode, MitigationState } from './mitigation-types';

// A migration da mitigacao ainda NAO esta aplicada em producao.
//
// Sem tabela, qualquer escrita no Prisma estoura ("relation does not exist") e a
// descoberta morreria junto. Este roteador escolhe o destino em tempo de chamada:
//   - schema pronto  -> repositorio real (Postgres)
//   - schema ausente -> espelho em memoria do processo
//
// Efeito pratico: DESCOBRIR CLIENTES funciona HOJE (analisa e mostra os clientes,
// guardando em memoria) e passa a persistir de forma duravel no dia em que a
// migration for aplicada. O health continua dizendo que o banco nao esta migrado.
export class RoutingMitigationRepository implements MitigationRepository {
  constructor(
    private readonly primary: MitigationRepository,
    private readonly fallback: MitigationRepository,
    private readonly usePrimary: () => Promise<boolean>,
  ) {}

  private async target(): Promise<MitigationRepository> {
    try {
      return (await this.usePrimary()) ? this.primary : this.fallback;
    } catch {
      return this.fallback;
    }
  }

  async upsertProfile(input: MitigationProfileInput): Promise<MitigationProfileRecord> {
    return (await this.target()).upsertProfile(input);
  }

  async getProfile(id: string): Promise<MitigationProfileRecord | null> {
    return (await this.target()).getProfile(id);
  }

  async listProfiles(filter?: MitigationProfileListFilter): Promise<MitigationProfileRecord[]> {
    return (await this.target()).listProfiles(filter);
  }

  async setProfileMode(id: string, mode: MitigationProfileMode): Promise<void> {
    return (await this.target()).setProfileMode(id, mode);
  }

  async setProfileEnabled(id: string, enabled: boolean): Promise<void> {
    return (await this.target()).setProfileEnabled(id, enabled);
  }

  async setProfileExclusion(id: string, input: MitigationExclusionInput): Promise<void> {
    return (await this.target()).setProfileExclusion(id, input);
  }

  async setProfileBandwidthOverride(
    id: string,
    bandwidthOverrideBps: bigint | null,
  ): Promise<void> {
    return (await this.target()).setProfileBandwidthOverride(id, bandwidthOverrideBps);
  }

  async replaceProfilePeers(
    profileId: string,
    peers: MitigationPeerInput[],
  ): Promise<MitigationProfilePeerRecord[]> {
    return (await this.target()).replaceProfilePeers(profileId, peers);
  }

  async listProfilePeers(profileId: string): Promise<MitigationProfilePeerRecord[]> {
    return (await this.target()).listProfilePeers(profileId);
  }

  async upsertRuntime(
    profileId: string,
    patch: MitigationRuntimePatch,
  ): Promise<MitigationRuntimeRecord> {
    return (await this.target()).upsertRuntime(profileId, patch);
  }

  async getRuntime(profileId: string): Promise<MitigationRuntimeRecord | null> {
    return (await this.target()).getRuntime(profileId);
  }

  async listRuntimeByState(states: MitigationState[]): Promise<MitigationRuntimeRecord[]> {
    return (await this.target()).listRuntimeByState(states);
  }

  async createSimulation(input: MitigationSimulationInput): Promise<MitigationSimulationRecord> {
    return (await this.target()).createSimulation(input);
  }

  async listSimulations(profileId: string, limit?: number): Promise<MitigationSimulationRecord[]> {
    return (await this.target()).listSimulations(profileId, limit);
  }

  async createEvent(input: MitigationEventInput): Promise<MitigationEventRecord> {
    return (await this.target()).createEvent(input);
  }

  async listEvents(profileId: string, limit?: number): Promise<MitigationEventRecord[]> {
    return (await this.target()).listEvents(profileId, limit);
  }

  async deleteProfile(id: string): Promise<void> {
    return (await this.target()).deleteProfile(id);
  }
}

/** Cache curto do probe: evita bater no banco a cada chamada do repositorio. */
export function createCachedSchemaCheck(
  probe: () => Promise<{ migrationReady: boolean; databaseReady: boolean }>,
  ttlMs = 15_000,
  now: () => number = () => Date.now(),
): () => Promise<boolean> {
  let cached: { value: boolean; at: number } | null = null;
  return async () => {
    const current = now();
    if (cached && current - cached.at < ttlMs) return cached.value;
    let value = false;
    try {
      const result = await probe();
      value = result.databaseReady && result.migrationReady;
    } catch {
      value = false;
    }
    cached = { value, at: current };
    return value;
  };
}
