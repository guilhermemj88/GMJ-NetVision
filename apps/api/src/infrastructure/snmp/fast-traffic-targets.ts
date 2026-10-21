import type { MitigationProfileRecord } from '../bgp/mitigation/mitigation-repository';
import type { FastSnmpHostPort } from './fast-snmp-reader';
import type { FastTrafficTarget } from './fast-traffic-types';

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
 */
export async function listFastTrafficTargets(deps: {
  profileIds: readonly string[];
  /** Perfis com telemetria autorizada explicitamente, em qualquer modo. */
  telemetryProfileIds?: readonly string[];
  allowedDeviceIds: readonly string[];
  listProfiles(): Promise<MitigationProfileRecord[]>;
  hosts: Pick<FastSnmpHostPort, 'getHost'>;
  direction(profile: MitigationProfileRecord): 'rx' | 'tx' | null;
}): Promise<FastTrafficTarget[]> {
  const telemetrySelected = new Set(deps.telemetryProfileIds ?? []);
  const grouped = new Map<string, FastTrafficTarget>();
  const profiles = (await deps.listProfiles()).filter(
    (p) =>
      deps.profileIds.includes(p.id) &&
      p.enabled &&
      (p.mode === 'AUTO' || telemetrySelected.has(p.id)) &&
      p.addressFamily === 'IPV4' &&
      !p.mitigationExcluded &&
      deps.allowedDeviceIds.includes(p.deviceId),
  );
  const hosts = new Map(
    await Promise.all(
      [...new Set(profiles.map((p) => p.deviceId))].map(
        async (id) => [id, await deps.hosts.getHost(id)] as const,
      ),
    ),
  );
  for (const p of profiles) {
    const direction = deps.direction(p);
    const host = hosts.get(p.deviceId);
    const networkInterface = host?.interfaces.find((i) => i.id === p.interfaceId);
    const bandwidthBps = p.bandwidthOverrideBps ?? p.detectedBandwidthBps;
    if (
      !direction ||
      !networkInterface ||
      !host?.snmpEnabled ||
      host.snmp?.version !== 'SNMP_V2C' ||
      !bandwidthBps ||
      bandwidthBps <= 0n
    )
      continue;
    const t = grouped.get(networkInterface.id) ?? {
      deviceId: p.deviceId,
      interfaceId: networkInterface.id,
      ifIndex: networkInterface.ifIndex,
      interfaceName: networkInterface.name,
      speedBps: networkInterface.speedBps ? BigInt(networkInterface.speedBps) : null,
      profiles: [],
    };
    t.profiles.push({
      profileId: p.id,
      direction,
      bandwidthBps,
      thresholdBps: (bandwidthBps * BigInt(p.triggerPercent)) / 100n,
    });
    grouped.set(t.interfaceId, t);
  }
  return [...grouped.values()];
}
