import type { BgpMitigationProfileDto } from '@gmj/shared';

/**
 * Classificacao de ESCOPO de policy IN (AUTO-ALL-PREDEPLOY-2).
 *
 * O discovery calcula `sharedPolicy`/`autoBlockedReason`, mas esse metadata pode
 * simplesmente NAO EXISTIR (cache vazio apos restart, discovery nunca executado,
 * perfil recem-descoberto). Sem ele, um segundo target da MESMA policy era aceito
 * em AUTO sem confirmacao ? a decisao de "policy compartilhada" nao pode depender
 * de um flag derivado de uma varredura que pode estar ausente.
 *
 * A fonte de verdade aqui sao os PERFIS PERSISTIDOS: dois targets que apontam
 * para o mesmo `deviceId` + `policyName` compartilham a policy fisica no
 * equipamento, independentemente de discovery.
 *
 *   EXCLUSIVE      -> nenhum outro target no mesmo escopo
 *   SAME_CUSTOMER  -> compartilha com outro(s) target(s) do MESMO cliente
 *                     (varias interfaces do mesmo cliente)
 *   CROSS_CUSTOMER -> compartilha com target de OUTRO cliente (escopo sensivel:
 *                     mitigar um afeta o trafego do vizinho)
 *
 * Nao classifica "pronto para AUTO": apenas descreve o compartilhamento.
 */
export type SharedPolicyClass = 'EXCLUSIVE' | 'SAME_CUSTOMER' | 'CROSS_CUSTOMER';

export interface SharedPolicyScope {
  profileId: string;
  /** Chave estavel do escopo fisico (`deviceId` + `policyName`). */
  scopeKey: string;
  /** Outros targets persistidos que usam a mesma policy IN. */
  otherProfileIds: string[];
  /** Interfaces distintas envolvidas (inclui a propria). */
  interfaceIds: string[];
  /** Clientes distintos no escopo. */
  customers: string[];
  shared: boolean;
  sameCustomerInterfaces: boolean;
  crossCustomer: boolean;
  classification: SharedPolicyClass;
}

const UNKNOWN = '\u0000unknown';

function customerKey(customer: string | null | undefined): string {
  const value = (customer ?? '').trim();
  return value === '' ? UNKNOWN : value;
}

function scopeKeyOf(profile: BgpMitigationProfileDto): string | null {
  const policy = (profile.policyName ?? '').trim();
  if (!profile.persisted || policy === '') return null;
  return `${profile.deviceId}\u0000${policy}`;
}

/**
 * Mapa `profileId -> escopo` para TODOS os targets persistidos com policy.
 * Somente leitura: nao altera nada e nao consulta banco (recebe os DTOs).
 */
export function sharedPolicyScopes(
  profiles: readonly BgpMitigationProfileDto[],
): Map<string, SharedPolicyScope> {
  const groups = new Map<string, BgpMitigationProfileDto[]>();
  for (const profile of profiles) {
    const key = scopeKeyOf(profile);
    if (key === null) continue;
    const group = groups.get(key) ?? [];
    group.push(profile);
    groups.set(key, group);
  }
  const scopes = new Map<string, SharedPolicyScope>();
  for (const [scopeKey, group] of groups) {
    for (const profile of group) {
      const others = group.filter((candidate) => candidate.id !== profile.id);
      const customers = [
        ...new Set(group.map((candidate) => (candidate.customer ?? '').trim()).filter((c) => c !== '')),
      ];
      const self = customerKey(profile.customer);
      const crossCustomer = others.some((other) => customerKey(other.customer) !== self);
      const sameCustomerInterfaces = others.some(
        (other) => customerKey(other.customer) === self && other.interfaceId !== profile.interfaceId,
      );
      const classification: SharedPolicyClass =
        others.length === 0 ? 'EXCLUSIVE' : crossCustomer ? 'CROSS_CUSTOMER' : 'SAME_CUSTOMER';
      scopes.set(profile.id, {
        profileId: profile.id,
        scopeKey,
        otherProfileIds: others.map((other) => other.id).sort(),
        interfaceIds: [
          ...new Set(group.map((candidate) => candidate.interfaceId ?? '').filter((id) => id !== '')),
        ].sort(),
        customers: customers.sort(),
        shared: others.length > 0,
        sameCustomerInterfaces,
        crossCustomer,
        classification,
      });
    }
  }
  return scopes;
}

/** Escopo de um perfil; `null` = perfil sem policy persistida (nunca compartilha). */
export function sharedPolicyScopeOf(
  profiles: readonly BgpMitigationProfileDto[],
  profileId: string,
): SharedPolicyScope | null {
  return sharedPolicyScopes(profiles).get(profileId) ?? null;
}

/**
 * Decisao de automacao: o bloqueio vale se o metadata do discovery apontar
 * SHARED_POLICY **ou** se os perfis persistidos mostrarem qualquer
 * compartilhamento no mesmo escopo. `unknown` nunca autoriza.
 */
export function sharedPolicyAutomationBlocked(
  profile: BgpMitigationProfileDto,
  scope: SharedPolicyScope | null,
): boolean {
  return profile.autoBlockedReason === 'SHARED_POLICY' || scope?.shared === true;
}
