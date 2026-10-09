import { genericProfile } from './generic';
import { huaweiGenericProfile } from './huawei/generic';
import { huaweiMa5800Profile } from './huawei/ma5800';
import { huaweiNe8000Profile } from './huawei/ne8000';
import { huaweiS6730Profile } from './huawei/s6730';
import { huaweiS6750Profile } from './huawei/s6750';
import { mikrotikProfile } from './mikrotik';
import type { SnmpProfile, SnmpProfileIdentity } from './types';
import {
  UNSUPPORTED_HUAWEI_OPTICAL_CAPABILITY,
  type HuaweiOpticalCapability,
  type HuaweiOpticalScalarSemantics,
} from '../../topology/huawei-optical';

export const SNMP_PROFILES: SnmpProfile[] = [
  huaweiNe8000Profile,
  huaweiMa5800Profile,
  huaweiS6750Profile,
  huaweiS6730Profile,
  mikrotikProfile,
  huaweiGenericProfile,
  genericProfile,
];

function matchesAny(value: string | undefined, patterns: RegExp[] | undefined): boolean {
  return Boolean(value && patterns?.some((pattern) => pattern.test(value)));
}

function score(profile: SnmpProfile, identity: SnmpProfileIdentity): number {
  if (profile.id === 'generic') return 1;
  const modelMatch = matchesAny(identity.model, profile.modelPatterns);
  const modelInDescription = matchesAny(identity.sysDescr, profile.modelPatterns);
  const descriptionMatch = matchesAny(identity.sysDescr, profile.sysDescrPatterns);
  const objectIdMatch = matchesAny(identity.sysObjectId, profile.sysObjectIdPatterns);
  if (profile.modelPatterns?.length
    && !modelMatch
    && !modelInDescription
    && !descriptionMatch
    && !objectIdMatch) return 0;
  let result = 0;
  if (modelMatch) result += 10_000;
  if (modelInDescription) result += 9_000;
  if (descriptionMatch) result += 3_000;
  if (objectIdMatch) result += 1_000;
  if (matchesAny(identity.vendor, profile.vendorPatterns)) result += 500;
  return result > 0 ? result + profile.priority : 0;
}

export function selectSnmpProfile(identity: SnmpProfileIdentity): SnmpProfile {
  return SNMP_PROFILES
    .map((profile) => ({ profile, score: score(profile, identity) }))
    .sort((left, right) => right.score - left.score)[0]?.profile ?? genericProfile;
}

/**
 * Resolves the PPP online OID for a device based on its selected profile.
 * Returns `null` when the profile does not declare a PPP OID (e.g. Juniper or
 * Datacom, which are prepared in the architecture but not populated yet).
 */
export function selectPppOnlineOid(identity: SnmpProfileIdentity): string | null {
  return selectSnmpProfile(identity).pppOnlineOid ?? null;
}

/**
 * Capability optica do profile selecionado. Sem declaracao explicita NAO ha
 * leitura optica por HUAWEI-ENTITY-EXTENT: nenhum walk e feito e nenhum valor e
 * decodificado (nunca se assume o encoding de outra familia).
 */
export function selectOpticalCapability(identity: SnmpProfileIdentity): HuaweiOpticalCapability {
  return selectSnmpProfile(identity).optical ?? UNSUPPORTED_HUAWEI_OPTICAL_CAPABILITY;
}

/**
 * Semantica do scalar .8/.9 do profile. `AGGREGATED_LANES` (F1A) impede o motor
 * optico de comparar o valor agregado com thresholds POR LANE; qualquer outra
 * plataforma preserva o comportamento legado.
 */
export function selectOpticalScalarSemantics(
  identity: SnmpProfileIdentity,
): HuaweiOpticalScalarSemantics {
  return selectOpticalCapability(identity).scalarSemantics;
}