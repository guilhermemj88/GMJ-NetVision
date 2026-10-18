import { createHash } from 'node:crypto';
import type { FastTrafficObservation } from '../../infrastructure/snmp/fast-traffic-types';
import { deriveFastTraffic } from '../../infrastructure/snmp/fast-traffic-rate';
import type {
  MitigationTrafficSample,
  MitigationTrafficSource,
  MitigationTrafficTarget,
} from './mitigation-traffic-source';

export interface FastBridgeConfig {
  mode: 'OFF' | 'SHADOW' | 'ENFORCE';
  profileIds: string[];
  enforceProfileIds: string[];
  maxAgeMs: number;
  maxGapMs: number;
}
export function fastBridgeConfig(
  env: Record<string, string | undefined> = process.env,
): FastBridgeConfig {
  const mode = env.MITIGATION_FAST_BRIDGE_MODE ?? 'OFF';
  if (!['OFF', 'SHADOW', 'ENFORCE'].includes(mode))
    throw Error('Invalid MITIGATION_FAST_BRIDGE_MODE');
  const ids = (key: string) => [
    ...new Set(
      (env[key] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  const profileIds = ids('MITIGATION_FAST_BRIDGE_PROFILE_IDS'),
    enforceProfileIds = ids('MITIGATION_FAST_ENFORCE_PROFILE_IDS');
  if (mode !== 'OFF' && !profileIds.length) throw Error('Explicit fast bridge profiles required');
  if (
    mode === 'ENFORCE' &&
    (env.MITIGATION_FAST_BRIDGE_WRITES_ENABLED !== 'true' ||
      !enforceProfileIds.length ||
      enforceProfileIds.some((id) => !profileIds.includes(id)))
  )
    throw Error('Explicit per-profile fast execution authorization required');
  if (mode !== 'OFF' && (env.MITIGATION_FAST_POLL_MODE ?? 'OFF') !== 'OFF')
    throw Error('External observer and in-process poller cannot be enabled together');
  return {
    mode: mode as FastBridgeConfig['mode'],
    profileIds,
    enforceProfileIds,
    maxAgeMs: 30_000,
    maxGapMs: 45_000,
  };
}
export interface FastBridgeMapping {
  id: string;
  deviceId: string;
  name: string;
  ifIndex: number;
  adminStatus: string;
  operStatus: string;
  speedBps: bigint | null;
}
export interface FastBridgeSnapshot {
  mapping: FastBridgeMapping | null;
  current: FastTrafficObservation | null;
  previous: FastTrafficObservation | null;
  collectorAvailable: boolean;
  collectorReason?: string | null;
  healthRechecked?: boolean;
}
export interface FastBridgeReader {
  snapshot(interfaceId: string, profileId: string): Promise<FastBridgeSnapshot>;
}
export interface FastBridgeProfile {
  profileId: string;
  deviceId: string;
  interfaceId: string | null;
  direction: 'rx' | 'tx' | null;
  revision: string;
}
export interface FastBridgeStatusEntry {
  profileId: string;
  source: 'FAST';
  available: boolean;
  reason: string | null;
  sampleId: string | null;
  sampleAt: string | null;
  generation: string | null;
  rxBps: string | null;
  txBps: string | null;
  intervalMs: number | null;
  readMs: number;
  collectorReason?: string | null;
  healthRechecked?: boolean;
}

/** Read-only bridge. No SNMP, credential vault, command, executor, or baseline mutation. */
export class FastObservationSource implements MitigationTrafficSource {
  private readonly entries = new Map<string, FastBridgeStatusEntry>();
  constructor(
    private readonly deps: {
      config: FastBridgeConfig;
      reader: FastBridgeReader;
      profile(id: string): FastBridgeProfile | null;
      now?: () => Date;
    },
  ) {}
  status() {
    return [...this.entries.values()].map((e) => ({ ...e }));
  }
  async sampleWithId(target: MitigationTrafficTarget): Promise<MitigationTrafficSample | null> {
    const start = (this.deps.now?.() ?? new Date()).getTime();
    let row: FastTrafficObservation | null = null;
    let collectorReason: string | null = null;
    let healthRechecked = false;
    const finish = (reason: string | null): MitigationTrafficSample | null => {
      this.entries.set(target.profileId, {
        profileId: target.profileId,
        source: 'FAST',
        available: reason === null,
        reason,
        sampleId: row?.id ?? null,
        sampleAt: row?.collectedAt.toISOString() ?? null,
        generation: row?.generation ?? null,
        rxBps: row?.rxBps == null ? null : Math.round(row.rxBps).toString(),
        txBps: row?.txBps == null ? null : Math.round(row.txBps).toString(),
        intervalMs: row?.intervalMs ?? null,
        readMs: (this.deps.now?.() ?? new Date()).getTime() - start,
        collectorReason,
        healthRechecked,
      });
      if (reason || !row || !profile?.direction) return null;
      const raw = profile.direction === 'tx' ? row.txBps : row.rxBps;
      return {
        bps: BigInt(Math.round(raw!)),
        sampleKey: `FAST:${row.deviceId}:${row.interfaceId}:${profile.direction}:${row.id}`,
        occurredAt: row.collectedAt,
        rateStartAt: row.previousCollectedAt,
        continuityKey: `FAST:${row.generation}:${row.deviceId}:${row.interfaceId}:${row.ifIndex}:${profile.direction}:${profile.revision}`,
      };
    };
    const profile = this.deps.profile(target.profileId);
    if (this.deps.config.mode === 'OFF') return finish('FAST_DISABLED');
    if (!this.deps.config.profileIds.includes(target.profileId))
      return finish('FAST_PROFILE_NOT_SELECTED');
    if (!profile || !profile.direction) return finish('DIRECTION_NOT_CONFIGURED');
    if (target.configurationKey !== undefined && target.configurationKey !== profile.revision)
      return finish('CONFIGURATION_CHANGED');
    if (
      !target.interfaceId ||
      target.interfaceId !== profile.interfaceId ||
      target.deviceId !== profile.deviceId
    )
      return finish('INTERFACE_NOT_LINKED');
    try {
      const s = await this.deps.reader.snapshot(target.interfaceId, target.profileId);
      row = s.current;
      collectorReason = s.collectorReason ?? null;
      healthRechecked = s.healthRechecked ?? false;
      if (!s.collectorAvailable) return finish('COLLECTION_UNAVAILABLE');
      const m = s.mapping;
      if (!m) return finish('INTERFACE_NOT_FOUND');
      if (m.adminStatus !== 'UP' || m.operStatus !== 'UP') return finish('INTERFACE_NOT_UP');
      if (!row || !s.previous) return finish('SAMPLE_NOT_FOUND');
      const uint64 = (v: bigint) => v >= 0n && v <= 18446744073709551615n;
      if (![row.inOctets, row.outOctets, s.previous.inOctets, s.previous.outOctets].every(uint64))
        return finish('INVALID_SAMPLE');
      if (
        m.id !== target.interfaceId ||
        m.deviceId !== target.deviceId ||
        m.ifIndex !== row.ifIndex ||
        m.name !== row.interfaceName
      )
        return finish('IDENTITY_MISMATCH');
      const now = (this.deps.now?.() ?? new Date()).getTime(),
        age = now - row.collectedAt.getTime();
      if (!Number.isFinite(age) || age < 0 || age > this.deps.config.maxAgeMs)
        return finish('SAMPLE_STALE');
      if (
        row.quality !== 'VALID' ||
        !row.generation ||
        row.generation !== s.previous.generation ||
        s.previous.deviceId !== row.deviceId ||
        s.previous.interfaceId !== row.interfaceId ||
        !row.previousCollectedAt ||
        +row.previousCollectedAt !== +s.previous.collectedAt
      )
        return finish('DISCONTINUITY');
      const recomputed = deriveFastTraffic(
        {
          deviceId: m.deviceId,
          interfaceId: m.id,
          ifIndex: m.ifIndex,
          interfaceName: m.name,
          speedBps: m.speedBps,
          profiles: [],
        },
        { ...row, speedBps: m.speedBps },
        s.previous,
        row.generation,
        this.deps.config.maxGapMs,
        2500,
      );
      const equal = (a: number | null, b: number | null) =>
        a !== null &&
        b !== null &&
        Number.isFinite(a) &&
        Number.isFinite(b) &&
        a >= 0 &&
        Math.abs(a - b) <= Math.max(1, Math.abs(b) * 1e-9);
      if (
        recomputed.quality !== 'VALID' ||
        recomputed.intervalMs !== row.intervalMs ||
        !equal(row.rxBps, recomputed.rxBps) ||
        !equal(row.txBps, recomputed.txBps)
      )
        return finish('INVALID_SAMPLE');
      return finish(null);
    } catch {
      return finish('FAST_SOURCE_UNAVAILABLE');
    }
  }
  async sample(target: MitigationTrafficTarget) {
    return (await this.sampleWithId(target))?.bps ?? null;
  }
  async sampleDirectionsWithId(target: MitigationTrafficTarget) {
    const sample = await this.sampleWithId(target),
      entry = this.entries.get(target.profileId);
    if (!sample || !entry?.available) return null;
    const continuity = sample.continuityKey;
    if (!continuity) return null;
    const value = (direction: 'rx' | 'tx', raw: string | null) =>
      raw === null
        ? null
        : {
            ...sample,
            bps: BigInt(raw),
            sampleKey:
              direction === this.deps.profile(target.profileId)?.direction
                ? sample.sampleKey
                : sample.sampleKey + ':' + direction,
            continuityKey:
              direction === this.deps.profile(target.profileId)?.direction
                ? continuity
                : continuity + ':' + direction,
          };
    return {
      sampleKey: sample.sampleKey,
      occurredAt: sample.occurredAt,
      rx: value('rx', entry.rxBps),
      tx: value('tx', entry.txBps),
    };
  }
}

/** Config revision changes invalidate a suspicion, including direction/mode/threshold edits. */
export function fastProfileRevision(value: object): string {
  return createHash('sha256')
    .update(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
    .digest('hex');
}

/** Exactly one selected source per evaluation; a FAST failure never falls back to LEGACY. */
export class FastBridgeRoutingSource implements MitigationTrafficSource {
  constructor(
    private readonly config: FastBridgeConfig,
    private readonly fast: MitigationTrafficSource,
    private readonly legacy: MitigationTrafficSource,
  ) {}
  private selected(id: string) {
    return this.config.mode === 'ENFORCE' && this.config.enforceProfileIds.includes(id);
  }
  sampleWithId(t: MitigationTrafficTarget) {
    return (this.selected(t.profileId) ? this.fast : this.legacy).sampleWithId(t);
  }
  async sample(t: MitigationTrafficTarget) {
    return (await this.sampleWithId(t))?.bps ?? null;
  }
  async sampleDirectionsWithId(t: MitigationTrafficTarget) {
    if (!this.selected(t.profileId)) return this.legacy.sampleDirectionsWithId?.(t) ?? null;
    // Explicit direction remains mandatory even when legacy DUAL is enabled.
    return this.fast.sampleDirectionsWithId?.(t) ?? null;
  }
}
