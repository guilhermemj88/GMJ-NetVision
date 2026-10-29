import type { InterfaceTrafficReader } from '../../infrastructure/bgp/mitigation/prisma-interface-traffic-reader';
import type { LifecycleTarget } from './auto-lifecycle';
import type { MitigationTrafficSample } from './mitigation-traffic-source';

/** Operator must homologate that this dedicated counter sees offered traffic
 * even while BGP diversion is active. A low client TX is NOT such a proof. */
export function recoveryMappings(
  raw: string | undefined,
): Map<string, { interfaceId: string; direction: 'rx' | 'tx'; key: string }> {
  const rows = new Map<string, { interfaceId: string; direction: 'rx' | 'tx'; key: string }>();
  if (!raw) return rows;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw Error('AUTO_RECOVERY_MAPPING_INVALID');
  for (const value of parsed) {
    const r = value as Record<string, unknown>;
    if (
      typeof r.profileId !== 'string' ||
      typeof r.interfaceId !== 'string' ||
      !r.profileId ||
      !r.interfaceId ||
      (r.direction !== 'rx' && r.direction !== 'tx') ||
      rows.has(r.profileId)
    )
      throw Error('AUTO_RECOVERY_MAPPING_INVALID');
    rows.set(r.profileId, {
      interfaceId: r.interfaceId,
      direction: r.direction,
      key: JSON.stringify([r.interfaceId, r.direction]),
    });
  }
  return rows;
}
export async function independentRecoveryProof(
  t: LifecycleTarget,
  mappings: ReturnType<typeof recoveryMappings>,
  reader: InterfaceTrafficReader,
  now = Date.now(),
): Promise<MitigationTrafficSample | null> {
  const m = mappings.get(t.profileId);
  if (!m || m.key !== t.recoveryProofKey || m.interfaceId === t.interfaceId) return null;
  const row = await reader.latestTraffic(m.interfaceId);
  if (
    !row ||
    row.deviceId !== t.deviceId ||
    row.usable !== true ||
    row.adminStatus !== 'UP' ||
    row.operStatus !== 'UP' ||
    row.currentOperStatus !== 'UP' ||
    !row.rateStartAt
  )
    return null;
  const at = row.timestamp.getTime(),
    start = row.rateStartAt.getTime();
  const rate = m.direction === 'tx' ? row.txBps : row.rxBps;
  if (
    !Number.isFinite(rate) ||
    rate < 0 ||
    at > now ||
    now - at > 15000 ||
    at <= start ||
    at - start > 15000
  )
    return null;
  // rxBps/txBps are bits/second in InterfaceMetricSample, not bytes/second.
  return {
    bps: BigInt(Math.floor(rate)),
    occurredAt: row.timestamp,
    rateStartAt: row.rateStartAt,
    sampleKey: row.sampleId ?? row.timestamp.toISOString(),
    continuityKey: m.key,
  };
}
