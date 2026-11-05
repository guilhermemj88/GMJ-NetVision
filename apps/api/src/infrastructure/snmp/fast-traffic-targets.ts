import type { MitigationProfileRecord } from '../bgp/mitigation/mitigation-repository';
import type { FastSnmpHostPort } from './fast-snmp-reader';
import type { FastTrafficTarget } from './fast-traffic-types';
import { fastGrowthProfile } from './fast-growth-profile';

/**
 * Seleção de TELEMETRIA: conceder observação não autoriza nada.
 *
 * `telemetryProfileIds` é a lista EXPLÍCITA de perfis observados independentemente
 * do modo (`MITIGATION_FAST_ROUTED_PROFILE_IDS`). Ela existe porque coletar,
 * rotear telemetria e autorizar mitigação são decisões SEPARADAS: um perfil
 * ALERT_ONLY pode ser medido a cada 10 s sem ganhar qualquer capacidade de
 * ACTIVATE/REMOVE (o motor para os gates de escrita antes de qualquer comando).
 *
 * Sem a lista — ou para um perfil fora dela — vale exatamente a regra anterior:
 * só `mode = AUTO` é coletado.
 *
 * AUTO-ALL ENFORCE (`autoAllEnforce`): o escopo deixa de ser a lista estática de
 * pilotos e passa a ser DESCOBERTO a cada refresh — todos os perfis que já são
 * `mode = AUTO` e passam pelos mesmos gates de elegibilidade. A descoberta não
 * promove ninguém: MANUAL/HOLD continuam fora, e um perfil só entra se tiver
 * interface SNMP identificada, banda contratada válida e direção resolvida.
 * Perfil sem direção NÃO entra no ENFORCE (ao contrário do modo observação, que
 * aceita direção nula).
 */

/** Motivo estável de bloqueio — o painel mostra este código, nunca texto livre. */
export type AutoAllBlockReason =
  | 'PROFILE_DISABLED'
  | 'MODE_NOT_AUTO'
  | 'NOT_IPV4'
  | 'MITIGATION_EXCLUDED'
  | 'DEVICE_NOT_ALLOWED'
  | 'INTERFACE_UNKNOWN'
  | 'SNMP_DISABLED'
  | 'SNMP_NOT_V2C'
  | 'BANDWIDTH_UNKNOWN'
  | 'DIRECTION_UNRESOLVED';

export interface AutoAllEligibility {
  profileId: string;
  deviceId: string;
  mode: string;
  eligible: boolean;
  reasons: AutoAllBlockReason[];
  bandwidthBps: string | null;
  ifIndex: number | null;
  interfaceId: string | null;
  direction: 'rx' | 'tx' | null;
  triggerPercent: number;
}

export interface FastTrafficSelectionDeps {
  profileIds: readonly string[];
  observeAllIpv4?: boolean;
  /** AUTO-ALL no caminho ENFORCE: escopo descoberto, nunca promovido. */
  autoAllEnforce?: boolean;
  /** Perfis com telemetria autorizada explicitamente, em qualquer modo. */
  telemetryProfileIds?: readonly string[];
  allowedDeviceIds: readonly string[];
  listProfiles(): Promise<MitigationProfileRecord[]>;
  hosts: Pick<FastSnmpHostPort, 'getHost'>;
  direction(profile: MitigationProfileRecord): 'rx' | 'tx' | null;
}

interface HostLike {
  snmpEnabled?: boolean;
  snmp?: { version?: string } | null;
  interfaces: Array<{ id: string; ifIndex: number; name: string; speedBps?: string | null }>;
}

interface Evaluated {
  profile: MitigationProfileRecord;
  reasons: AutoAllBlockReason[];
  networkInterface: { id: string; ifIndex: number; name: string; speedBps?: string | null } | null;
  direction: 'rx' | 'tx' | null;
  bandwidthBps: bigint | null;
}

/** Uma avaliação por perfil, usada tanto pelo coletor quanto pela API. */
async function evaluate(deps: FastTrafficSelectionDeps): Promise<Evaluated[]> {
  const telemetrySelected = new Set(deps.telemetryProfileIds ?? []);
  const inScope = (p: MitigationProfileRecord): boolean => {
    if (deps.observeAllIpv4 === true) return true;
    if (deps.autoAllEnforce === true) return p.mode === 'AUTO';
    return deps.profileIds.includes(p.id) && (p.mode === 'AUTO' || telemetrySelected.has(p.id));
  };
  const profiles = (await deps.listProfiles()).filter(inScope);
  const hostIds = [...new Set(profiles.map((p) => p.deviceId))];
  const hosts = new Map<string, HostLike | undefined>(
    await Promise.all(
      hostIds.map(async (id) => [id, (await deps.hosts.getHost(id)) as HostLike | undefined] as const),
    ),
  );
  return profiles.map((p) => {
    const reasons: AutoAllBlockReason[] = [];
    if (!p.enabled) reasons.push('PROFILE_DISABLED');
    // Em AUTO-ALL o escopo já é `mode === AUTO`; o motivo existe para a lista
    // explícita (onde ALERT_ONLY só entra por telemetria) e para o painel.
    // Observação total é, por definição, independente do modo.
    if (
      deps.observeAllIpv4 !== true &&
      deps.autoAllEnforce !== true &&
      p.mode !== 'AUTO' &&
      !telemetrySelected.has(p.id)
    )
      reasons.push('MODE_NOT_AUTO');
    if (p.addressFamily !== 'IPV4') reasons.push('NOT_IPV4');
    if (p.mitigationExcluded) reasons.push('MITIGATION_EXCLUDED');
    if (!deps.allowedDeviceIds.includes(p.deviceId)) reasons.push('DEVICE_NOT_ALLOWED');
    const host = hosts.get(p.deviceId);
    const networkInterface = host?.interfaces.find((i) => i.id === p.interfaceId) ?? null;
    if (!networkInterface) reasons.push('INTERFACE_UNKNOWN');
    if (!host?.snmpEnabled) reasons.push('SNMP_DISABLED');
    else if (host.snmp?.version !== 'SNMP_V2C') reasons.push('SNMP_NOT_V2C');
    const bandwidthBps = p.bandwidthOverrideBps ?? p.detectedBandwidthBps;
    if (!bandwidthBps || bandwidthBps <= 0n) reasons.push('BANDWIDTH_UNKNOWN');
    const direction = deps.direction(p);
    // Observação aceita direção nula; ENFORCE nunca — sem direção não há limiar.
    if (!direction && deps.observeAllIpv4 !== true) reasons.push('DIRECTION_UNRESOLVED');
    return { profile: p, reasons, networkInterface, direction, bandwidthBps };
  });
}

/**
 * Elegibilidade por cliente para a API. Mesma regra do coletor: o que aparece
 * aqui é exatamente o que ele avalia — nada é elegível só por estar no banco.
 */
export async function describeAutoAllEligibility(
  deps: FastTrafficSelectionDeps,
): Promise<AutoAllEligibility[]> {
  const evaluated = await evaluate(deps);
  return evaluated.map((e) => ({
    profileId: e.profile.id,
    deviceId: e.profile.deviceId,
    mode: e.profile.mode,
    eligible: e.reasons.length === 0,
    reasons: e.reasons,
    bandwidthBps: e.bandwidthBps?.toString() ?? null,
    ifIndex: e.networkInterface?.ifIndex ?? null,
    interfaceId: e.networkInterface?.id ?? null,
    direction: e.direction,
    triggerPercent: e.profile.triggerPercent,
  }));
}

export async function listFastTrafficTargets(
  deps: FastTrafficSelectionDeps,
): Promise<FastTrafficTarget[]> {
  const grouped = new Map<string, FastTrafficTarget>();
  for (const e of await evaluate(deps)) {
    if (e.reasons.length > 0) continue;
    // Invalid trigger configuration stays fail-closed for this profile only.
    // A Float in the database must not abort collection for every other client.
    if (!Number.isInteger(e.profile.triggerPercent) || e.profile.triggerPercent <= 0 || e.profile.triggerPercent > 100) continue;
    const networkInterface = e.networkInterface!;
    const t = grouped.get(networkInterface.id) ?? {
      deviceId: e.profile.deviceId,
      interfaceId: networkInterface.id,
      ifIndex: networkInterface.ifIndex,
      interfaceName: networkInterface.name,
      speedBps: networkInterface.speedBps ? BigInt(networkInterface.speedBps) : null,
      profiles: [],
    };
    const growth = fastGrowthProfile({ profileId: e.profile.id, direction: e.direction,
      bandwidthBps: e.bandwidthBps, triggerPercent: e.profile.triggerPercent,
      recoveryPercent: e.profile.recoveryPercent, recoverySamples: e.profile.recoverySamples });
    t.profiles.push(growth ?? {
      profileId: e.profile.id,
      direction: e.direction,
      bandwidthBps: e.bandwidthBps!,
      thresholdBps: (e.bandwidthBps! * BigInt(e.profile.triggerPercent)) / 100n,
      triggerPercent: e.profile.triggerPercent,
      growthEligible: false,
    });
    grouped.set(t.interfaceId, t);
  }
  return [...grouped.values()];
}
