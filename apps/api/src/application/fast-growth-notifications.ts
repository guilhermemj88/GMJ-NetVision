import {
  FastGrowthTracker,
  emptyAnalysis,
  GROWTH_WINDOW_MS,
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
  crossingKnown: Record<Direction, boolean>;
  lastRate: Record<Direction, number | null>;
  interrupted: Record<Direction, boolean>;
  closed: Record<
    Direction,
    Array<{
      analysis: GrowthAnalysis;
      thresholdAt: number;
      validUntil: number;
      crossingKnown: boolean;
      cause: 'RECOVERY' | 'INTERRUPTION' | 'AGE';
    }>
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
  private pollerProfiles = new Set<string>();
  private readonly bridgeProfiles = new Set<string>();

  constructor(
    private readonly maxGapMs: number,
    private readonly isFastRouted: (profileId: string) => boolean = () => true,
    private readonly isEnabled: () => boolean = () => true,
    private readonly now: () => number = Date.now,
  ) {}

  private enabled(): boolean {
    if (this.isEnabled()) return true;
    this.tracker.reset();
    this.contexts.clear();
    this.pollerProfiles.clear();
    this.bridgeProfiles.clear();
    return false;
  }

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
    if (!this.enabled()) return;
    const current = new Set(targets.flatMap((t) => t.profiles.map((p) => p.profileId)));
    for (const id of this.pollerProfiles) {
      const c = this.contexts.get(id);
      if (c && !current.has(id) && !this.bridgeProfiles.has(id)) this.remove(c);
    }
    this.pollerProfiles = current;
    for (const target of targets) {
      for (const profile of target.profiles) this.upsert(target, profile);
    }
  }

  private upsert(target: FastTrafficTarget, profile: Profile): void {
    if (
      profile.growthEligible === false ||
      (profile.triggerPercent !== undefined && !Number.isInteger(profile.triggerPercent)) ||
      typeof profile.recoveryThresholdBps !== 'bigint' ||
      !Number.isInteger(profile.recoverySamples) ||
      profile.recoverySamples! <= 0
    ) {
      const old = this.contexts.get(profile.profileId);
      if (old) this.remove(old);
      return;
    }
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
    if (old?.revision === revision) return;
    if (old) this.remove(old);
    this.contexts.set(profile.profileId, {
      revision,
      target,
      profile,
      lastAt: null,
      generation: null,
      below: { rx: 0, tx: 0 },
      thresholdAt: {},
      crossingKnown: { rx: false, tx: false },
      lastRate: { rx: null, tx: null },
      interrupted: { rx: false, tx: false },
      closed: { rx: [], tx: [] },
    });
  }

  /** External observer mode: reuse the row already validated/read by the bridge. */
  recordBridge(
    profile: { profileId: string; growth?: Profile },
    row: FastTrafficObservation | null,
  ): void {
    if (!this.enabled()) return;
    if (!row || !profile.growth) {
      if (!profile.growth) this.bridgeProfiles.delete(profile.profileId);
      const c = this.contexts.get(profile.profileId);
      if (c) {
        if (!profile.growth) this.remove(c);
        else this.breakContinuity(c);
      }
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
    this.bridgeProfiles.add(profile.profileId);
    this.upsert(target, profile.growth);
    this.consume(target, row);
  }

  private archive(
    c: Context,
    direction: Direction,
    validUntil: number,
    cause: 'RECOVERY' | 'INTERRUPTION' | 'AGE',
  ): void {
    const key = this.key(c, direction),
      analysis = this.tracker.frozenAnalysis(key);
    const thresholdAt = c.thresholdAt[direction];
    if (analysis && thresholdAt !== undefined) {
      c.closed[direction].push({
        analysis,
        thresholdAt,
        validUntil: Math.min(validUntil, thresholdAt + GROWTH_WINDOW_MS + 1),
        crossingKnown: c.crossingKnown[direction],
        cause,
      });
      if (c.closed[direction].length > 8) c.closed[direction].shift();
      c.interrupted[direction] = cause !== 'RECOVERY';
    }
    this.tracker.clearFreeze(key);
    delete c.thresholdAt[direction];
    c.crossingKnown[direction] = false;
  }

  private breakContinuity(c: Context): void {
    for (const direction of directions) {
      this.archive(c, direction, (c.lastAt ?? 0) + 1, 'INTERRUPTION');
      this.tracker.clearSamples(this.key(c, direction));
    }
    c.below = { rx: 0, tx: 0 };
    c.lastRate = { rx: null, tx: null };
  }

  unavailable(target: FastTrafficTarget): void {
    if (!this.enabled()) return;
    for (const p of target.profiles) {
      const c = this.contexts.get(p.profileId);
      if (c) this.breakContinuity(c); // Invalidates the reference, never confirms recovery.
    }
  }

  record(target: FastTrafficTarget, observation: FastTrafficObservation): void {
    if (!this.enabled()) return;
    for (const profile of target.profiles) {
      this.pollerProfiles.add(profile.profileId);
      this.upsert(target, profile);
    }
    this.consume(target, observation);
  }

  private consume(target: FastTrafficTarget, observation: FastTrafficObservation): void {
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
      const c = this.contexts.get(profile.profileId);
      if (!c) continue;
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
        const thresholdAt = c.thresholdAt[direction];
        if (thresholdAt !== undefined && at - thresholdAt > GROWTH_WINDOW_MS)
          this.archive(c, direction, thresholdAt + GROWTH_WINDOW_MS + 1, 'AGE');
        if (rate === null || !Number.isFinite(rate) || rate < 0) {
          this.archive(c, direction, at, 'INTERRUPTION');
          this.tracker.clearSamples(key);
          c.below[direction] = 0;
          c.lastRate[direction] = null;
          continue;
        }
        this.tracker.record(key, at, (rate / bandwidth) * 100);
        if (rate >= Number(profile.thresholdBps)) {
          if (c.thresholdAt[direction] === undefined) {
            c.thresholdAt[direction] = at;
            c.crossingKnown[direction] =
              c.lastRate[direction] !== null &&
              c.lastRate[direction]! < Number(profile.thresholdBps);
            c.interrupted[direction] = false;
          }
          this.tracker.freezeAtThreshold(key, undefined, at, c.crossingKnown[direction]);
        }
        c.lastRate[direction] = rate;
        const low =
          profile.recoveryThresholdBps !== undefined && rate < Number(profile.recoveryThresholdBps);
        c.below[direction] = low ? c.below[direction] + 1 : 0;
        if (
          Number.isInteger(profile.recoverySamples) &&
          profile.recoverySamples! > 0 &&
          c.below[direction] >= profile.recoverySamples!
        ) {
          this.archive(c, direction, at, 'RECOVERY');
          c.interrupted[direction] = false;
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
      if (!this.enabled()) return notification;
      if (!notification.profileId || notification.growth != null || !events.has(notification.event))
        return notification;
      if (!this.isFastRouted(notification.profileId)) return notification;
      const c = this.contexts.get(notification.profileId);
      if (!c) return notification; // Legacy/non-FAST notifications remain byte-for-byte compatible.
      const direction = notification.direction ?? eventDirection ?? c.profile.direction;
      if (!direction) return notification;
      const eventAt =
        confirmedAtMs ??
        (notification.occurredAt == null ? this.now() : Date.parse(notification.occurredAt));
      if (!Number.isFinite(eventAt)) return notification;
      const prior =
        eventAt === null
          ? undefined
          : [...c.closed[direction]]
              .reverse()
              .find((s) => s.thresholdAt <= eventAt && eventAt < s.validUntil);
      const frozen = this.tracker.frozenAnalysis(this.key(c, direction));
      const thresholdAt = prior?.thresholdAt ?? c.thresholdAt[direction];
      if (!prior && !frozen && !c.interrupted[direction]) return notification;
      if (thresholdAt !== undefined && eventAt < thresholdAt) return notification;
      const fresh = c.lastAt !== null && eventAt - c.lastAt <= this.maxGapMs;
      const supported =
        prior || (fresh && thresholdAt !== undefined && eventAt - thresholdAt <= GROWTH_WINDOW_MS);
      const analysis = supported
        ? (prior?.analysis ?? frozen!)
        : {
            ...emptyAnalysis(),
            currentUtilizationPct:
              fresh && c.lastRate[direction] !== null && c.profile.bandwidthBps
                ? Math.round((c.lastRate[direction]! / Number(c.profile.bandwidthBps)) * 1000) / 10
                : null,
          };
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
        thresholdReachedAt:
          supported &&
          thresholdAt !== undefined &&
          (prior?.crossingKnown ?? c.crossingKnown[direction])
            ? new Date(thresholdAt).toISOString()
            : null,
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
