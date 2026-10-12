import type { MitigationProfileRecord, MitigationRepository } from './mitigation-repository';
import type { MitigationNodePair } from './mitigation-planner';
import type { MitigationState } from './mitigation-types';

// ESCOPO FISICO de execucao de uma route-policy.
//
// A route-policy e um objeto POR EQUIPAMENTO: alterar nodes de
// `PL-FLASH-TELECOM_IPv4-IN` no device A atinge fisicamente TODOS os profiles
// do device A que usam essa policy, e NUNCA um profile de outro device com o
// mesmo nome. O address family nao entra na chave: a policy e a mesma entidade.
export interface PolicyExecutionScope {
  deviceId: string;
  policyName: string;
}

export function policyExecutionScope(
  profile: Pick<MitigationProfileRecord, 'deviceId' | 'policyName'>,
): PolicyExecutionScope {
  return { deviceId: profile.deviceId, policyName: profile.policyName };
}

/** Profiles persistidos que compartilham a MESMA policy fisica. */
export async function profilesForPolicyScope(
  repository: MitigationRepository,
  scope: PolicyExecutionScope,
): Promise<MitigationProfileRecord[]> {
  const profiles = await repository.listProfiles({ deviceId: scope.deviceId });
  return profiles.filter((profile) => profile.policyName === scope.policyName);
}

/**
 * Sincroniza o runtime de TODOS os profiles da policy fisica. Uma alteracao de
 * nodes na policy vale para todos eles: deixar um MITIGATED e outro NORMAL
 * seria um estado que o equipamento nao tem.
 *
 * `activePair`: quando informado (ACTIVATE verificado), o PAR FISICO ATIVO e
 * gravado em todos os profiles do escopo - um profile compartilhado nunca pode
 * exibir um par diferente como se estivesse ativo.
 *
 * Nunca lanca: devolve quantos foram atualizados e quantos falharam, para o
 * chamador reportar (fail-closed).
 */
export async function syncPolicyRuntime(
  repository: MitigationRepository,
  scope: PolicyExecutionScope,
  state: MitigationState,
  lastValidatedAt: Date,
  activePair: MitigationNodePair | null = null,
): Promise<{ updated: number; failed: number }> {
  const profiles = await profilesForPolicyScope(repository, scope);
  let updated = 0;
  let failed = 0;
  for (const profile of profiles) {
    try {
      await repository.upsertRuntime(profile.id, {
        state,
        lastValidatedAt,
        ...(activePair === null
          ? {}
          : {
              plannedBogonNode: activePair.bogonNode,
              plannedMitigationNode: activePair.mitigationNode,
              plannedNode: activePair.mitigationNode,
            }),
      });
      updated += 1;
    } catch {
      failed += 1;
    }
  }
  return { updated, failed };
}
