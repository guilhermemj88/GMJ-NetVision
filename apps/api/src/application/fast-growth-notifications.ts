import {
  FastGrowthTracker,
  type GrowthAnalysis,
} from '../infrastructure/snmp/fast-growth-analysis';
import type { GrowthWebhookBlock } from '../infrastructure/bgp/mitigation/mitigation-webhook';
import type { MitigationNotification } from '../infrastructure/bgp/mitigation/notification-publisher';
import type {
  FastTrafficObserver,
  FastTrafficObservation,
  FastTrafficTarget,
} from '../infrastructure/snmp/fast-traffic-types';

type Direction = 'rx' | 'tx';
type Profile = FastTrafficTarget['profiles'][number];
interface Context {
  revision: string;
  target: FastTrafficTarget;
  profile: Profile;
  lastAt: number | null;
  generation: string | null;
  below: Record<Direction, number>;
  thresholdAt: Partial<Record<Direction, number>>;
  closed: Record<
    Direction,
    Array<{ analysis: GrowthAnalysis; thresholdAt: number; recoveredAt: number }>
  >;
}
const directions: Direction[] = ['rx', 'tx'];
const events = new Set<MitigationNotification['event']>([
  'MITIGATION_TRIGGERED',
  'MITIGATION_VERIFIED',
  'MITIGATION_FAILED',
  'MITIGATION_SIMULATION_TRIGGERED',
  'MITIGATION_DETECTION_BLOCKED',
]);

/** Sidecar only: consumes rates already accepted by FAST and decorates existing events.
 * Does not create events or participate in engine gates/counters/lease/BGP.
 */
export class FastGrowthNotifications implements FastTrafficObserver {
  private readonly tracker = new FastGrowthTracker();
  private readonly contexts = new Map<string, Context>();

  constructor(
    private readonly maxGapMs: number,
    private readonly isFastRouted: (profileId: string) => boolean = () => true,
  ) {}

  private key(c: Context, direction: Direction): string {
    return JSON.stringify([
      c.profile.profileId,
      c.target.deviceId,
      c.target.interfaceId,
      direction,
    ]);
  }

  private remove(c: Context): void {
    for (const direction of directions) this.tracker.reset(this.key(c, direction));
    this.contexts.delete(c.profile.profileId);
  }

  refresh(targets: FastTrafficTarget[]): void {
    const current = new Set(targets.flatMap((t) => t.profiles.map((p) => p.profileId)));
    for (const c of this.contexts.values()) if (!current.has(c.profile.profileId)) this.remove(c);
    for (const target of targets) {
      for (const profile of target.profiles) {
        const revision = JSON.stringify([
          target.deviceId,
          target.interfaceId,
          target.ifIndex,
          profile.direction,
          profile.bandwidthBps?.toString(),
          profile.thresholdBps.toString(),
          profile.triggerPercent,
          profile.recoveryThresholdBps?.toString(),
          profile.recoverySamples,
        ]);
        const old = this.contexts.get(profile.profileId);
        if (old?.revision === revision) continue;
        if (old) this.remove(old);
        this.contexts.set(profile.profileId, {
          revision,
          target,
          profile,
          lastAt: null,
          generation: null,
          below: { rx: 0, tx: 0 },
          thresholdAt: {},
          closed: { rx: [], tx: [] },
        });
      }
    }
  }

  /** External observer mode: reuse the row already validated/read by the bridge. */
  recordBridge(
    profile: { profileId: string; growth?: Profile },
    row: FastTrafficObservation | null,
  ): void {
    if (!row || !profile.growth) {
      const c = this.contexts.get(profile.profileId);
      if (c) this.breakContinuity(c);
      return;
    }
    const target: FastTrafficTarget = {
      deviceId: row.deviceId,
      interfaceId: row.interfaceId,
      ifIndex: row.ifIndex,
      interfaceName: row.interfaceName,
      speedBps: row.speedBps,
      profiles: [profile.growth],
    };
    const others = [...this.contexts.values()]
      .filter((c) => c.profile.profileId !== profile.profileId)
      .map((c) => ({ ...c.target, profiles: [c.profile] }));
    this.refresh([...others, target]);
    this.record(target, row);
  }

  private breakContinuity(c: Context): void {
    for (const direction of directions) this.tracker.clearSamples(this.key(c, direction));
    c.below = { rx: 0, tx: 0 };
  }

  unavailable(target: FastTrafficTarget): void {
    for (const p of target.profiles) {
      const c = this.contexts.get(p.profileId);
      if (c) this.breakContinuity(c); // Frozen episode survives missing SNMP, never a synthetic zero.
    }
  }

  record(target: FastTrafficTarget, observation: FastTrafficObservation): void {
    // refresh() normally precedes collection; callers can feed one target directly too.
    if (target.profiles.some((p) => !this.contexts.has(p.profileId))) {
      const active = [...this.contexts.values()].map((c) => c.target);
      this.refresh([...active, target]);
    }
    const at = observation.collectedAt.getTime();
    if (
      observation.quality !== 'VALID' ||
      !Number.isFinite(at) ||
      observation.deviceId !== target.deviceId ||
      observation.interfaceId !== target.interfaceId ||
      observation.ifIndex !== target.ifIndex
    ) {
      this.unavailable(target);
      return;
    }
    for (const profile of target.profiles) {
      const c = this.contexts.get(profile.profileId)!;
      if (c.lastAt !== null && at <= c.lastAt) continue;
      if (
        c.generation !== observation.generation ||
        (c.lastAt !== null && at - c.lastAt > this.maxGapMs)
      )
        this.breakContinuity(c);
      c.lastAt = at;
      c.generation = observation.generation;
      const bandwidth = Number(profile.bandwidthBps);
      if (!Number.isFinite(bandwidth) || bandwidth <= 0) continue;
      for (const direction of directions) {
        const rate = direction === 'rx' ? observation.rxBps : observation.txBps;
        const key = this.key(c, direction);
        if (rate === null || !Number.isFinite(rate) || rate < 0) {
          this.tracker.clearSamples(key);
          c.below[direction] = 0;
          continue;
        }
        this.tracker.record(key, at, (rate / bandwidth) * 100);
        if (rate >= Number(profile.thresholdBps)) {
          if (c.thresholdAt[direction] === undefined) c.thresholdAt[direction] = at;
          this.tracker.freezeAtThreshold(key, undefined, at);
        }
        const low =
          profile.recoveryThresholdBps !== undefined && rate < Number(profile.recoveryThresholdBps);
        c.below[direction] = low ? c.below[direction] + 1 : 0;
        if (
          Number.isInteger(profile.recoverySamples) &&
          profile.recoverySamples! > 0 &&
          c.below[direction] >= profile.recoverySamples!
        ) {
          const analysis = this.tracker.frozenAnalysis(key);
          const thresholdAt = c.thresholdAt[direction];
          if (analysis && thresholdAt !== undefined) {
            c.closed[direction].push({ analysis, thresholdAt, recoveredAt: at });
            // Only correlation for notifications already confirmed before recovery.
            // This archive never participates in a new episode or traffic baseline.
            if (c.closed[direction].length > 8) c.closed[direction].shift();
          }
          this.tracker.clearFreeze(key);
          delete c.thresholdAt[direction];
        }
      }
    }
  }

  /** Called BEFORE durable enqueue. Retries therefore carry the original episode snapshot. */
  enrich(
    notification: MitigationNotification,
    eventDirection?: Direction | null,
    confirmedAtMs?: number | null,
  ): MitigationNotification {
    try {
      if (!notification.profileId || notification.growth != null || !events.has(notification.event))
        return notification;
      if (!this.isFastRouted(notification.profileId)) return notification;
      const c = this.contexts.get(notification.profileId);
      if (!c) return notification; // Legacy/non-FAST notifications remain byte-for-byte compatible.
      const direction = notification.direction ?? eventDirection ?? c.profile.direction;
      if (!direction) return notification;
      const eventAt =
        confirmedAtMs ??
        (notification.occurredAt == null ? null : Date.parse(notification.occurredAt));
      const prior =
        eventAt === null
          ? undefined
          : [...c.closed[direction]]
              .reverse()
              .find((s) => s.thresholdAt <= eventAt && eventAt < s.recoveredAt);
      const analysis = prior?.analysis ?? this.tracker.frozenAnalysis(this.key(c, direction));
      const thresholdAt = prior?.thresholdAt ?? c.thresholdAt[direction];
      if (!analysis || thresholdAt === undefined) return notification;
      if (eventAt !== null && eventAt < thresholdAt) return notification;
      const mitigationStatus =
        notification.event === 'MITIGATION_VERIFIED' &&
        notification.verified === true &&
        notification.simulation === false
          ? 'APLICADA'
          : notification.simulation
            ? 'SIMULACAO'
            : 'DESCONHECIDA';
      const { frozen: _, ...metrics } = analysis;
      const growth: GrowthWebhookBlock = {
        ...metrics,
        thresholdPct:
          c.profile.triggerPercent ??
          (Number(c.profile.thresholdBps) / Number(c.profile.bandwidthBps)) * 100,
        thresholdReachedAt: new Date(thresholdAt).toISOString(),
        trafficDirection: direction,
        mitigationStatus,
        mitigationReason: notification.blockedReason ?? null,
        // No attack or mitigation claim is inferred from utilization.
        message: `Crescimento informativo: ${analysis.growthClassification}.`,
      };
      return { ...notification, growth };
    } catch {
      return notification; // A presentation failure cannot block the real notification.
    }
  }
}
