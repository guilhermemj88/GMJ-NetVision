import type {
  BgpMitigationProfileDto,
  MitigationTelemetryEntryDto,
  MitigationTelemetryReason,
  MitigationAutoTrafficDirection,
} from '@gmj/shared';

export interface DiagnosticInterface {
  id: string;
  deviceId: string;
  name: string;
  ifIndex: number;
  adminStatus: string;
  operStatus: string;
  sample: {
    id: string;
    at: Date;
    rx: number;
    tx: number;
    usable: boolean;
    operStatus: string;
  } | null;
}

/** Configuration and measurement are independent. This module has no command or SNMP port. */
export function resolveTelemetryDirection(
  profileId: string,
  stored: MitigationAutoTrafficDirection | null | undefined,
  env: Record<string, 'rx' | 'tx'>,
  interfaceStored?: MitigationAutoTrafficDirection | null,
) {
  // Precedencia: override do PERFIL > ENV legado (override explicito dos 4
  // perfis atuais) > direcao HERDADA da interface > indefinida (fail-closed).
  if (stored === 'RX' || stored === 'TX') return { direction: stored, source: 'PROFILE' as const };
  const legacy = env[profileId];
  if (legacy)
    return { direction: legacy.toUpperCase() as MitigationAutoTrafficDirection, source: 'ENV' as const };
  if (interfaceStored === 'RX' || interfaceStored === 'TX')
    return { direction: interfaceStored, source: 'INTERFACE' as const };
  return { direction: null, source: null };
}

export interface TelemetryDiagnosticDeps {
  readInterface(id: string): Promise<DiagnosticInterface | null>;
  envDirections: Record<string, 'rx' | 'tx'>;
  maxAgeMs: number;
  now?: () => Date;
  authorization(
    profile: BgpMitigationProfileDto,
    scope?: SharedPolicyScope | null,
  ): string[];
}

import type { SharedPolicyScope } from './mitigation-shared-policy';
import { sharedPolicyScopes } from './mitigation-shared-policy';

export async function diagnoseMitigationTelemetry(
  profiles: BgpMitigationProfileDto[],
  deps: TelemetryDiagnosticDeps,
) {
  const now = (deps.now ?? (() => new Date()))();
  // Escopo fisico (deviceId+policyName) derivado dos perfis PERSISTIDOS:
  // a autorizacao nunca depende so do metadata do discovery.
  const sharedScopes = sharedPolicyScopes(profiles);
  // IPv4/IPv6 share exactly one inventory/sample read, never summed.
  const byInterface = new Map<string, Promise<DiagnosticInterface | null>>();
  const entries: MitigationTelemetryEntryDto[] = [];
  for (const p of profiles) {
    const { direction, source } = resolveTelemetryDirection(
      p.id,
      p.autoTrafficDirection,
      deps.envDirections,
      p.interfaceTrafficDirection,
    );
    const reasons: MitigationTelemetryReason[] = [];
    if (!direction) reasons.push('DIRECTION_NOT_CONFIGURED');
    let iface: DiagnosticInterface | null = null;
    let unavailable = false;
    if (!p.interfaceId) reasons.push('INTERFACE_NOT_LINKED');
    else {
      if (!byInterface.has(p.interfaceId))
        byInterface.set(p.interfaceId, deps.readInterface(p.interfaceId));
      try {
        iface = await byInterface.get(p.interfaceId)!;
      } catch {
        unavailable = true;
        reasons.push('COLLECTION_UNAVAILABLE');
      }
      if (!iface && !unavailable) reasons.push('INTERFACE_NOT_FOUND');
    }
    const sample = iface?.sample ?? null;
    const age = sample ? now.getTime() - sample.at.getTime() : null;
    const validRate = (value: number | undefined) =>
      value !== undefined && Number.isFinite(value) && value >= 0;
    if (iface) {
      if (
        iface.id !== p.interfaceId ||
        iface.deviceId !== p.deviceId ||
        !Number.isInteger(iface.ifIndex) ||
        iface.ifIndex <= 0
      )
        reasons.push('INVALID_SAMPLE');
      if (iface.adminStatus === 'DOWN') reasons.push('INTERFACE_ADMIN_DOWN');
      else if (iface.adminStatus !== 'UP' || iface.operStatus !== 'UP')
        reasons.push('INTERFACE_NOT_UP');
      if (!sample) reasons.push('SAMPLE_NOT_FOUND');
      else {
        if (
          !Number.isFinite(age) ||
          age! < 0 ||
          !sample.usable ||
          sample.operStatus !== 'UP' ||
          !validRate(sample.rx) ||
          !validRate(sample.tx)
        )
          reasons.push('INVALID_SAMPLE');
        if (age! > deps.maxAgeMs) reasons.push('SAMPLE_STALE');
      }
    }
    const measurementReasons = reasons.filter((r) => r !== 'DIRECTION_NOT_CONFIGURED');
    const available = iface !== null && sample !== null && measurementReasons.length === 0;
    const gates = [
      ...new Set([...deps.authorization(p, sharedScopes.get(p.id) ?? null), ...reasons]),
    ];
    entries.push({
      profileId: p.id,
      interfaceId: p.interfaceId,
      interfaceName: iface?.name ?? p.interfaceName,
      ifIndex: iface?.ifIndex ?? null,
      adminStatus: iface?.adminStatus ?? 'UNKNOWN',
      operStatus: iface?.operStatus ?? 'UNKNOWN',
      source: 'LEGACY',
      sampleId: sample?.id ?? null,
      sampleAt: sample && Number.isFinite(sample.at.getTime()) ? sample.at.toISOString() : null,
      sampleAgeMs: age !== null && Number.isFinite(age) ? Math.max(0, age) : null,
      maxAgeMs: deps.maxAgeMs,
      rxBps: sample && validRate(sample.rx) ? Math.round(sample.rx).toString() : null,
      txBps: sample && validRate(sample.tx) ? Math.round(sample.tx).toString() : null,
      direction,
      directionSource: source,
      telemetryAvailable: available,
      reasons: [...new Set(reasons)],
      blockedReason: reasons[0] ?? null,
      mode: p.mode,
      promotedBySweep: p.autoPromotedBySweep === true,
      executionAuthorized: gates.length === 0,
      executionBlocks: gates,
      sharedCounterProfileIds: profiles
        .filter(
          (other) =>
            other.interfaceId &&
            other.interfaceId === p.interfaceId &&
            other.deviceId === p.deviceId,
        )
        .map((other) => other.id),
    });
  }
  return { generatedAt: now.toISOString(), entries };
}
