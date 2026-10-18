import type { FastTrafficStore } from '../../infrastructure/snmp/fast-traffic-types';
import type { FastPollerConfig } from '../../infrastructure/snmp/fast-traffic-poller';
import type {
  MitigationTrafficSource,
  MitigationTrafficTarget,
  MitigationTrafficSample,
  MitigationDirectionsSample,
} from './mitigation-traffic-source';

/** Explicit per-profile routing. ENFORCE never falls back to the slow stream. */
export class PriorityTrafficSource implements MitigationTrafficSource {
  constructor(
    private readonly deps: {
      config: FastPollerConfig;
      store: FastTrafficStore;
      legacy: MitigationTrafficSource;
      direction(profileId: string): 'rx' | 'tx' | null;
      available(interfaceId: string): boolean;
      now?: () => Date;
    },
  ) {}

  private priority(target: MitigationTrafficTarget): boolean {
    return (
      this.deps.config.mode === 'ENFORCE' && this.deps.config.profileIds.includes(target.profileId)
    );
  }

  private async directions(
    target: MitigationTrafficTarget,
  ): Promise<MitigationDirectionsSample | null> {
    if (!target.interfaceId || !this.deps.available(target.interfaceId)) return null;
    const row = await this.deps.store.latest(target.interfaceId);
    const now = (this.deps.now?.() ?? new Date()).getTime();
    if (
      !row ||
      row.quality !== 'VALID' ||
      row.deviceId !== target.deviceId ||
      row.adminStatus !== 1 ||
      row.operStatus !== 1 ||
      row.intervalMs === null ||
      row.intervalMs <= 0 ||
      row.intervalMs > this.deps.config.maxGapMs ||
      now < row.collectedAt.getTime() ||
      now - row.collectedAt.getTime() > this.deps.config.maxGapMs
    )
      return null;
    const sample = (
      direction: 'rx' | 'tx',
      value: number | null,
    ): MitigationTrafficSample | null => {
      if (value === null || !Number.isFinite(value) || value < 0) return null;
      return {
        bps: BigInt(Math.round(value)),
        sampleKey: `${row.deviceId}:${row.interfaceId}:${direction}:${row.id}`,
        occurredAt: row.collectedAt,
        rateStartAt: row.previousCollectedAt,
        continuityKey: `${row.generation}:${row.deviceId}:${row.interfaceId}:${row.ifIndex}:${direction}`,
      };
    };
    return {
      sampleKey: row.id,
      occurredAt: row.collectedAt,
      rx: sample('rx', row.rxBps),
      tx: sample('tx', row.txBps),
    };
  }

  async sampleWithId(target: MitigationTrafficTarget): Promise<MitigationTrafficSample | null> {
    if (!this.priority(target)) return this.deps.legacy.sampleWithId(target);
    const direction = this.deps.direction(target.profileId);
    if (!direction) return null;
    return (await this.directions(target))?.[direction] ?? null;
  }

  async sampleDirectionsWithId(
    target: MitigationTrafficTarget,
  ): Promise<MitigationDirectionsSample | null> {
    if (!this.priority(target)) return this.deps.legacy.sampleDirectionsWithId?.(target) ?? null;
    return this.directions(target);
  }

  async sample(target: MitigationTrafficTarget): Promise<bigint | null> {
    return (await this.sampleWithId(target))?.bps ?? null;
  }
}
