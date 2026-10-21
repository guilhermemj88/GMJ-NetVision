import { randomUUID } from 'node:crypto';
import { deriveFastTraffic } from './fast-traffic-rate';
import type {
  FastCounterReading,
  FastTrafficObservation,
  FastTrafficReader,
  FastTrafficStore,
  FastTrafficTarget,
} from './fast-traffic-types';

export interface FastPollerConfig {
  mode: 'OFF' | 'OBSERVE' | 'ENFORCE';
  /** Escopo total de ids observados (união legada + roteados). */
  profileIds: string[];
  /**
   * Subconjunto EXPLÍCITO de telemetria (`MITIGATION_FAST_ROUTED_PROFILE_IDS`).
   * Perfis desta lista são medidos em QUALQUER modo — inclusive ALERT_ONLY —
   * porque coletar não é autorizar. Fora dela vale a regra legada (só AUTO).
   */
  telemetryProfileIds: string[];
  normalIntervalMs: number;
  suspectIntervalMs: number;
  maxGapMs: number;
  timeoutMs: number;
  retries: number;
  concurrency: number;
  /**
   * Teto de interfaces observadas por device. Exceder o teto FALHA o refresh
   * (fail-closed) em vez de truncar a coleta silenciosamente.
   */
  maxInterfacesPerDevice: number;
}

export function fastPollerConfig(
  env: Record<string, string | undefined> = process.env,
): FastPollerConfig {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
    return n;
  };
  const mode = env.MITIGATION_FAST_POLL_MODE ?? 'OFF';
  if (mode !== 'OFF' && mode !== 'OBSERVE' && mode !== 'ENFORCE')
    throw new Error('Invalid MITIGATION_FAST_POLL_MODE');
  const list = (key: string) =>
    (env[key] ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  // `MITIGATION_FAST_ROUTED_PROFILE_IDS` é a fonte de verdade do roteamento de
  // telemetria: o observador coleta a UNIÃO dela com a lista legada, sem exigir
  // que os operadores mantenham duas listas em sincronia.
  const telemetryProfileIds = list('MITIGATION_FAST_ROUTED_PROFILE_IDS');
  const profileIds = [...new Set([...list('MITIGATION_FAST_PROFILE_IDS'), ...telemetryProfileIds])];
  if (mode !== 'OFF' && !profileIds.length)
    throw new Error('MITIGATION_FAST_PROFILE_IDS is required');
  return {
    mode,
    profileIds,
    telemetryProfileIds,
    normalIntervalMs: integer('MITIGATION_FAST_NORMAL_SECONDS', 20, 10, 30) * 1000,
    suspectIntervalMs: 10_000,
    maxGapMs: 45_000,
    timeoutMs: integer('MITIGATION_FAST_TIMEOUT_MS', 1500, 100, 2000),
    retries: integer('MITIGATION_FAST_RETRIES', 0, 0, 1),
    concurrency: integer('MITIGATION_FAST_CONCURRENCY', 2, 1, 4),
    maxInterfacesPerDevice: integer('MITIGATION_FAST_MAX_INTERFACES_PER_DEVICE', 8, 1, 64),
  };
}

interface DeviceSchedule {
  targets: FastTrafficTarget[];
  dueAt: number;
  suspected: boolean;
}
export interface FastPollerHealthEntry {
  deviceId: string;
  interfaceId: string;
  profileIds: string[];
  state: 'NORMAL' | 'SUSPECTED_ATTACK' | 'UNAVAILABLE';
  lastCollectedAt: string | null;
  lastValidAt: string | null;
  quality: string;
  intervalMs: number | null;
  collectionMs: number | null;
  rxBps: number | null;
  txBps: number | null;
  contractedPercent: Record<string, number>;
}

/**
 * One bounded priority scheduler, not pollHost(). One in-flight GET per device;
 * batches <=4 interfaces. Slow devices never hold a global sweep or engine tick.
 * Baselines are PRIVATE to this collector. A conventional poll cannot mutate them.
 */
export class FastTrafficPoller {
  private readonly generation = randomUUID();
  private readonly schedules = new Map<string, DeviceSchedule>();
  private readonly baseline = new Map<string, FastCounterReading>();
  private readonly epochs = new Map<string, string>();
  private readonly entries = new Map<string, FastPollerHealthEntry>();
  private readonly intervals = new Map<string, number[]>();
  private readonly qualityCounts: Record<string, number> = {};
  private readonly active = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;
  private nextRefreshAt = 0;
  private stopped = false;
  private requests = 0;
  private failures = 0;
  private lateStarts = 0;
  private rejectedWrites = 0;
  private lastError: string | null = null;

  constructor(
    private readonly deps: {
      config: FastPollerConfig;
      listTargets(): Promise<FastTrafficTarget[]>;
      reader: FastTrafficReader;
      store: FastTrafficStore;
      now?: () => Date;
      logger?: (message: string, meta: Record<string, unknown>) => void;
    },
  ) {}

  private now(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  start(): void {
    if (this.timer || this.deps.config.mode === 'OFF') return;
    this.stopped = false;
    void this.runDue();
    this.timer = setInterval(() => void this.runDue(), 250);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.refreshing;
    await Promise.allSettled(this.active.values());
  }

  /** Injectable clock + explicit drain make the complete scheduler testable. */
  async runDue(): Promise<void> {
    if (this.stopped || this.deps.config.mode === 'OFF') return;
    if (this.now() >= this.nextRefreshAt && !this.refreshing) {
      this.nextRefreshAt = this.now() + 30_000;
      this.refreshing = this.refreshTargets()
        .catch(() => {
          this.lastError = 'TARGET_REFRESH_FAILED';
          // Never continue polling a cached authorization after a failed refresh.
          this.schedules.clear();
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    await this.refreshing;
    if (this.stopped) return;
    const due = [...this.schedules]
      .filter(([id, s]) => !this.active.has(id) && s.dueAt <= this.now())
      .sort((a, b) => Number(b[1].suspected) - Number(a[1].suspected) || a[1].dueAt - b[1].dueAt);
    for (const [id, schedule] of due) {
      if (this.active.size >= this.deps.config.concurrency) break;
      if (this.now() - schedule.dueAt > 1000) this.lateStarts++;
      const work = this.poll(schedule).finally(() => this.active.delete(id));
      this.active.set(id, work);
    }
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.active.values());
  }

  isAvailable(interfaceId: string): boolean {
    const entry = this.entries.get(interfaceId);
    return (
      !this.stopped &&
      entry?.quality === 'VALID' &&
      entry.lastValidAt !== null &&
      this.schedules.get(entry.deviceId)?.targets.some((t) => t.interfaceId === interfaceId) ===
        true &&
      this.now() - new Date(entry.lastValidAt).getTime() <= this.deps.config.maxGapMs
    );
  }

  status() {
    return {
      mode: this.deps.config.mode,
      running: this.timer !== null,
      generation: this.generation,
      normalIntervalMs: this.deps.config.normalIntervalMs,
      suspectIntervalMs: this.deps.config.suspectIntervalMs,
      activeDevices: this.active.size,
      monitoredDevices: this.schedules.size,
      requests: this.requests,
      failures: this.failures,
      lateStarts: this.lateStarts,
      rejectedWrites: this.rejectedWrites,
      qualityCounts: { ...this.qualityCounts },
      lastError: this.lastError,
      entries: [...this.entries.values()].map((e) => ({
        ...e,
        intervalStatsMs: this.intervalStats(e.interfaceId),
        validAgeMs: e.lastValidAt ? this.now() - new Date(e.lastValidAt).getTime() : null,
        nextMeasurementAt: this.schedules.get(e.deviceId)
          ? new Date(this.schedules.get(e.deviceId)!.dueAt).toISOString()
          : null,
        overdue:
          this.schedules.has(e.deviceId) &&
          this.now() - this.schedules.get(e.deviceId)!.dueAt > 1000,
      })),
    };
  }

  private async refreshTargets(): Promise<void> {
    const targets = await this.deps.listTargets();
    const groups = new Map<string, FastTrafficTarget[]>();
    for (const t of targets) {
      const group = groups.get(t.deviceId) ?? [];
      group.push(t);
      groups.set(t.deviceId, group);
    }
    for (const id of this.schedules.keys()) if (!groups.has(id)) this.schedules.delete(id);
    const ids = new Set(targets.map((t) => t.interfaceId));
    for (const id of this.entries.keys())
      if (!ids.has(id)) {
        this.entries.delete(id);
        this.baseline.delete(id);
        this.epochs.delete(id);
        this.intervals.delete(id);
      }
    for (const [id, ts] of groups) {
      // Reject an excessive scope rather than silently starving protected interfaces.
      if (ts.length > this.deps.config.maxInterfacesPerDevice)
        throw new Error('FAST_DEVICE_INTERFACE_LIMIT');
      const old = this.schedules.get(id);
      this.schedules.set(id, {
        targets: ts,
        dueAt: old?.dueAt ?? this.now(),
        suspected: old?.suspected ?? false,
      });
    }
    this.lastError = null;
  }

  private async poll(schedule: DeviceSchedule): Promise<void> {
    const started = this.now();
    let suspect = false;
    for (let i = 0; i < schedule.targets.length; i += 4) {
      const batch = schedule.targets.slice(i, i + 4);
      this.requests++;
      let stage: 'SNMP' | 'PERSISTENCE' = 'SNMP';
      try {
        const rows = await this.deps.reader.read(batch);
        if (this.stopped) break;
        if (rows.length !== batch.length) throw new Error('INCOMPLETE_RESPONSE');
        for (const t of batch) {
          const current = rows.find((r) => r.interfaceId === t.interfaceId);
          if (!current) throw new Error('INCOMPLETE_RESPONSE');
          const observation = deriveFastTraffic(
            t,
            current,
            this.baseline.get(t.interfaceId),
            this.epochs.get(t.interfaceId) ?? this.generation,
            this.deps.config.maxGapMs,
            this.deps.config.timeoutMs * (1 + this.deps.config.retries) + 500,
          );
          if (observation.quality !== 'VALID') {
            observation.generation = randomUUID();
            this.epochs.set(t.interfaceId, observation.generation);
          }
          if (observation.quality === 'OUT_OF_ORDER') {
            this.invalidate(t, 'OUT_OF_ORDER');
            continue;
          }
          stage = 'PERSISTENCE';
          if (!(await this.deps.store.append(observation))) {
            this.rejectedWrites++;
            this.invalidate(t, 'PERSISTENCE_REJECTED');
            continue;
          }
          if (['IDENTITY_MISMATCH', 'LATE_RESPONSE'].includes(observation.quality))
            this.baseline.delete(t.interfaceId);
          else this.baseline.set(t.interfaceId, current);
          const high =
            observation.quality === 'VALID' &&
            t.profiles.some(
              (p) =>
                (p.direction === 'tx' ? observation.txBps! : observation.rxBps!) >=
                Number(p.thresholdBps),
            );
          suspect ||= high;
          this.updateEntry(t, observation, high);
        }
      } catch (error) {
        this.failures++;
        const message = error instanceof Error ? error.message : '';
        this.lastError =
          stage === 'PERSISTENCE'
            ? 'PERSISTENCE_ERROR'
            : /INCOMPLETE_RESPONSE/.test(message)
              ? 'INCOMPLETE_RESPONSE'
              : /timeout|deadline/i.test(message)
                ? 'SNMP_TIMEOUT'
                : 'SNMP_ERROR';
        for (const t of batch) {
          this.invalidate(t, this.lastError);
        }
        // A failure is NOT a synthetic zero. Preserve faster retry cadence during suspicion.
        suspect ||= schedule.suspected;
      }
    }
    schedule.suspected = suspect;
    // Refresh can replace the schedule while a GET is in flight.
    const live = this.schedules.get(schedule.targets[0]!.deviceId);
    if (live) {
      live.suspected = suspect;
      live.dueAt = Math.max(
        this.now() + 250,
        started +
          (suspect ? this.deps.config.suspectIntervalMs : this.deps.config.normalIntervalMs),
      );
    }
  }

  private emptyEntry(t: FastTrafficTarget): FastPollerHealthEntry {
    return {
      deviceId: t.deviceId,
      interfaceId: t.interfaceId,
      profileIds: t.profiles.map((p) => p.profileId),
      state: 'UNAVAILABLE',
      quality: 'BASELINE',
      lastCollectedAt: null,
      lastValidAt: null,
      intervalMs: null,
      collectionMs: null,
      rxBps: null,
      txBps: null,
      contractedPercent: {},
    };
  }

  private invalidate(t: FastTrafficTarget, quality: string): void {
    this.baseline.delete(t.interfaceId);
    this.epochs.set(t.interfaceId, randomUUID());
    const old = this.entries.get(t.interfaceId);
    if (old?.quality !== quality)
      this.deps.logger?.('fast-poller: transition', {
        interfaceId: t.interfaceId,
        deviceId: t.deviceId,
        state: 'UNAVAILABLE',
        quality,
      });
    this.entries.set(t.interfaceId, {
      ...this.emptyEntry(t),
      ...old,
      state: 'UNAVAILABLE',
      quality,
    });
  }

  private updateEntry(t: FastTrafficTarget, o: FastTrafficObservation, high: boolean): void {
    const old = this.entries.get(t.interfaceId);
    this.qualityCounts[o.quality] = (this.qualityCounts[o.quality] ?? 0) + 1;
    if (old?.lastCollectedAt) {
      const intervals = this.intervals.get(t.interfaceId) ?? [];
      intervals.push(o.collectedAt.getTime() - Date.parse(old.lastCollectedAt));
      if (intervals.length > 360) intervals.shift();
      this.intervals.set(t.interfaceId, intervals);
    }
    const state = o.quality !== 'VALID' ? 'UNAVAILABLE' : high ? 'SUSPECTED_ATTACK' : 'NORMAL';
    const entry: FastPollerHealthEntry = {
      ...this.emptyEntry(t),
      state,
      quality: o.quality,
      lastCollectedAt: o.collectedAt.toISOString(),
      lastValidAt: o.quality === 'VALID' ? o.collectedAt.toISOString() : (old?.lastValidAt ?? null),
      intervalMs: o.intervalMs,
      collectionMs: o.collectedAt.getTime() - o.requestStartedAt.getTime(),
      rxBps: o.rxBps,
      txBps: o.txBps,
      contractedPercent:
        o.quality === 'VALID'
          ? Object.fromEntries(
              t.profiles
                .filter((p) => p.bandwidthBps && p.bandwidthBps > 0n)
                .map((p) => [
                  p.profileId,
                  (Number(p.direction === 'tx' ? o.txBps : o.rxBps) / Number(p.bandwidthBps)) * 100,
                ]),
            )
          : {},
    };
    if (old?.state !== state || old?.quality !== o.quality)
      this.deps.logger?.('fast-poller: transition', {
        deviceId: t.deviceId,
        interfaceId: t.interfaceId,
        state,
        quality: o.quality,
      });
    this.entries.set(t.interfaceId, entry);
  }

  private intervalStats(id: string) {
    const sorted = [...(this.intervals.get(id) ?? [])].sort((a, b) => a - b);
    return {
      count: sorted.length,
      p50: sorted[Math.max(0, Math.ceil(sorted.length * 0.5) - 1)] ?? null,
      p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null,
      max: sorted.at(-1) ?? null,
    };
  }
}
