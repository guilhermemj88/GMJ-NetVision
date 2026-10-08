import { genericProfile } from './generic';
import { huaweiGenericProfile } from './huawei/generic';
import { huaweiNe8000Profile } from './huawei/ne8000';
import { huaweiS6730Profile } from './huawei/s6730';
import { huaweiS6750Profile } from './huawei/s6750';
import { mikrotikProfile } from './mikrotik';
import type { SnmpProfile, SnmpProfileIdentity } from './types';
import type {
  HuaweiOpticalLaneEncoding,
  HuaweiOpticalScalarEncoding,
  HuaweiOpticalWarningEncoding,
} from '../../topology/huawei-optical';

export const SNMP_PROFILES: SnmpProfile[] = [
  huaweiNe8000Profile,
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
 * Encoding do RAW .8/.9 conforme o profile selecionado. `UNKNOWN` = o coletor
 * NAO decodifica o scalar (nunca adivinha por sinal do valor); as lanes
 * .32/.33 e o fallback SSH seguem valendo normalmente.
 */
/**
 * Encoding dos WARNING (.20-.23) conforme o profile. Default `CENTI_DBM` (VRP
 * classico, unica familia comprovada em campo); `ABSTRACT` explicito no profile
 * do YunShan evita 4 walks inuteis por interface.
 */
export function selectOpticalWarningEncoding(
  identity: SnmpProfileIdentity,
): HuaweiOpticalWarningEncoding {
  return selectSnmpProfile(identity).opticalWarningEncoding ?? 'CENTI_DBM';
}

export function selectOpticalScalarEncoding(
  identity: SnmpProfileIdentity,
): HuaweiOpticalScalarEncoding {
  return selectSnmpProfile(identity).opticalScalarEncoding ?? 'UNKNOWN';
}

/**
 * Encoding do CSV de potencia POR LANE (.32/.33) conforme o profile. `UNKNOWN`
 * explicito = nao decodifica potencia de lane (o bias continua valido); um
 * profile que NAO declara o campo cai no comportamento historico `DBM` (lanes
 * ja em dBm) — nunca em CENTI_DBM, que exige evidencia de campo.
 */
export function selectOpticalLaneEncoding(
  identity: SnmpProfileIdentity,
): HuaweiOpticalLaneEncoding {
  return selectSnmpProfile(identity).opticalLaneEncoding ?? 'DBM';
}
