import { describe, it, expect, vi } from 'vitest';
import { FastGrowthNotifications } from './fast-growth-notifications';
import { fastGrowthEnabled, fastGrowthProfile } from '../infrastructure/snmp/fast-growth-profile';
import type {
  FastTrafficObservation,
  FastTrafficTarget,
} from '../infrastructure/snmp/fast-traffic-types';
import { deriveFastTraffic } from '../infrastructure/snmp/fast-traffic-rate';
import type { MitigationNotification } from '../infrastructure/bgp/mitigation/notification-publisher';
import type { GrowthWebhookBlock } from '../infrastructure/bgp/mitigation/mitigation-webhook';
import {
  MitigationAutoEngine,
  type MitigationAutoTargetState,
} from '../worker/mitigation/mitigation-auto-engine';
import {
  DurableMitigationOutbox,
  type OutboxEntry,
} from '../worker/mitigation/durable-mitigation-outbox';
import { MemoryAutomationStore } from '../worker/mitigation/automation-store';

const T = Date.parse('2026-11-05T12:00:00Z'),
  BW = 1000000000n;
function target(id = 'a', triggerPercent = 95, recoveryPercent = 70): FastTrafficTarget {
  const growth = fastGrowthProfile({
    profileId: id,
    direction: 'tx',
    bandwidthBps: BW,
    triggerPercent,
    recoveryPercent,
    recoverySamples: 3,
  });
  return {
    deviceId: 'offline',
    interfaceId: id,
    interfaceName: id,
    ifIndex: 1,
    speedBps: 10n * BW,
    profiles: [
      growth ?? {
        profileId: id,
        direction: 'tx',
        bandwidthBps: BW,
        thresholdBps: 950000000n,
        triggerPercent,
        growthEligible: false,
      },
    ],
  };
}
function row(t: FastTrafficTarget, at: number, tx: number, rx = 10): FastTrafficObservation {
  return {
    deviceId: t.deviceId,
    interfaceId: t.interfaceId,
    interfaceName: t.interfaceName,
    ifIndex: 1,
    speedBps: t.speedBps,
    id: String(at),
    generation: 'one',
    quality: 'VALID',
    requestStartedAt: new Date(at),
    collectedAt: new Date(at),
    previousCollectedAt: new Date(at - 5000),
    intervalMs: 5000,
    uptimeTicks: BigInt(at),
    discontinuityTicks: 0n,
    lastChangeTicks: 0n,
    adminStatus: 1,
    operStatus: 1,
    inOctets: 100000n,
    outOctets: 100000n,
    rxBps: (Number(BW) * rx) / 100,
    txBps: (Number(BW) * tx) / 100,
  };
}
function n(at: number, id = 'a'): MitigationNotification {
  return {
    event: 'MITIGATION_DETECTION_BLOCKED',
    eventId: 'unchanged-' + id,
    profileId: id,
    occurredAt: new Date(at).toISOString(),
    simulation: true,
    verified: false,
    customer: 'OFFLINE',
    device: 'OFFLINE',
    interfaceName: id,
    peer: null,
    affectedPeers: [],
    detectedBandwidthBps: null,
    bandwidthOverrideBps: null,
    effectiveBandwidthBps: BW,
    trafficBps: BW,
    thresholdBps: 950000000n,
    policy: 'OFFLINE',
    node: 2,
    rt: '64500:660',
  };
}
const growth = (value: MitigationNotification) => value.growth as GrowthWebhookBlock | undefined;
function sudden(g: FastGrowthNotifications, t = target(), start = T) {
  for (let i = 0; i < 12; i++) g.record(t, row(t, start + i * 5000, 20));
  g.record(t, row(t, start + 60000, 95));
  return start + 60000;
}

describe('F1: reference validity and delayed confirmation are separate', () => {
  it('no new measurement after the continuity limit cannot advertise the old BRUSCO', () => {
    const g = new FastGrowthNotifications(15000),
      at = sudden(g);
    expect(growth(g.enrich(n(at)))?.growthClassification).toBe('BRUSCO');
    expect(growth(g.enrich(n(at + 15001)))).toMatchObject({
      growthClassification: 'INDETERMINADO',
      baselineAverage5mPct: null,
      currentUtilizationPct: null,
      thresholdReachedAt: null,
    });
  });
  it.each([false, true])(
    'ten-minute gap, explicit failure=%s: no invented crossing or recent jump',
    (failure) => {
      const g = new FastGrowthNotifications(15000),
        t = target(),
        at = sudden(g, t);
      if (failure) g.unavailable(t);
      g.record(t, row(t, at + 600000, 96));
      expect(growth(g.enrich(n(at + 600000)))).toMatchObject({
        growthClassification: 'INDETERMINADO',
        currentUtilizationPct: 96,
        baselineAverage5mPct: null,
        deltaPercentagePoints: null,
        thresholdReachedAt: null,
      });
      // The same old confirmation is historical evidence, not a new crossing.
      expect(growth(g.enrich(n(at + 600000), 'tx', at))).toMatchObject({
        growthClassification: 'BRUSCO',
        thresholdReachedAt: new Date(at).toISOString(),
        currentUtilizationPct: 95,
      });
    },
  );
  it('a continuous but older-than-five-minute reference also becomes indeterminate', () => {
    const g = new FastGrowthNotifications(15000),
      t = target(),
      at = sudden(g, t);
    for (let i = 1; i <= 62; i++) g.record(t, row(t, at + i * 5000, 98));
    expect(growth(g.enrich(n(at + 310000)))).toMatchObject({
      growthClassification: 'INDETERMINADO',
      thresholdReachedAt: null,
    });
  });
  it('initial high sample has measured utilization but no known crossing time', () => {
    const g = new FastGrowthNotifications(15000),
      t = target();
    g.record(t, row(t, T, 95));
    expect(growth(g.enrich(n(T)))).toMatchObject({
      growthClassification: 'INDETERMINADO',
      currentUtilizationPct: 95,
      thresholdReachedAt: null,
    });
  });
  it('new observed crossing after recovery is independent from an interrupted one', () => {
    const g = new FastGrowthNotifications(15000),
      t = target(),
      at = sudden(g, t);
    g.unavailable(t);
    for (let i = 1; i <= 12; i++) g.record(t, row(t, at + 600000 + i * 5000, 20));
    const second = at + 665000;
    g.record(t, row(t, second, 95));
    expect(growth(g.enrich(n(second)))).toMatchObject({
      growthClassification: 'BRUSCO',
      thresholdReachedAt: new Date(second).toISOString(),
    });
  });
});

describe('F2/F6: integer AUTO contract, Float storage, no silent rounding', () => {
  it.each([
    [95.5, 70],
    [95, 70.5],
    [95.5, 70.5],
    [NaN, 70],
    [95, Infinity],
  ])(
    'unsupported trigger=%s recovery=%s omits Growth without throwing',
    (triggerPercent, recoveryPercent) => {
      expect(() =>
        fastGrowthProfile({
          profileId: 'bad',
          direction: 'tx',
          bandwidthBps: BW,
          triggerPercent,
          recoveryPercent,
          recoverySamples: 3,
        }),
      ).not.toThrow();
      expect(
        fastGrowthProfile({
          profileId: 'bad',
          direction: 'tx',
          bandwidthBps: BW,
          triggerPercent,
          recoveryPercent,
          recoverySamples: 3,
        }),
      ).toBeUndefined();
      const g = new FastGrowthNotifications(15000),
        t = target('bad', triggerPercent, recoveryPercent);
      g.record(t, row(t, T, 95));
      expect(g.enrich(n(T, 'bad'))).toEqual(n(T, 'bad'));
    },
  );
  it('fractional reconfiguration drops the previous freeze; corrected profile can recover and rearm', () => {
    const g = new FastGrowthNotifications(15000),
      at = sudden(g);
    const invalid = target('a', 95, 70.5);
    g.refresh([invalid]);
    g.record(invalid, row(invalid, at + 5000, 60));
    expect(g.enrich(n(at + 5000))).toEqual(n(at + 5000));
    const valid = target();
    for (let i = 1; i <= 12; i++) g.record(valid, row(valid, at + 5000 + i * 5000, 20));
    const second = at + 70000;
    g.record(valid, row(valid, second, 95));
    expect(growth(g.enrich(n(second)))?.thresholdReachedAt).toBe(new Date(second).toISOString());
  });
  it('coexisting invalid profiles never abort the target list or change the valid AUTO decision', async () => {
    const commands = {
      execute: vi.fn(async () => {
        throw Error('No BGP allowed');
      }),
    };
    const base: MitigationAutoTargetState = {
      profileId: 'valid',
      deviceId: 'offline',
      interfaceId: 'a',
      customer: 'OFFLINE',
      mode: 'AUTO',
      direction: 'tx',
      snapshotAvailable: true,
      readiness: 'READY',
      prefixStatus: 'SAFE',
      blockedReason: null,
      mitigationExcluded: false,
      runtimeState: 'NORMAL',
      effectiveBandwidthBps: BW,
      bogonNode: 1,
      mitigationNode: 2,
      sharedPolicy: false,
      peerAddresses: [],
      triggerPercent: 95,
      recoveryPercent: 70,
      triggerSamples: 3,
      recoverySamples: 3,
    };
    const targets = [
      base,
      { ...base, profileId: 'bad-trigger', triggerPercent: 95.5 },
      { ...base, profileId: 'bad-recovery', recoveryPercent: 70.5 },
    ];
    function engine(enrich: boolean) {
      return new MitigationAutoEngine({
        globalMode: 'AUTO',
        execution: { executor: 'HUAWEI', liveWrite: false, allowedDeviceIds: [] },
        targets: {
          list: async () =>
            targets.map((t) => {
              if (enrich)
                fastGrowthProfile({
                  profileId: t.profileId,
                  direction: 'tx',
                  bandwidthBps: BW,
                  triggerPercent: t.triggerPercent,
                  recoveryPercent: t.recoveryPercent,
                  recoverySamples: 3,
                });
              return t;
            }),
        },
        traffic: {
          sample: async () => 200000000n,
          sampleWithId: async () => ({
            bps: 200000000n,
            sampleKey: 'one',
            occurredAt: new Date(T),
          }),
        },
        exclusions: { listPeerExclusions: async () => [] },
        runtime: {
          get: async () => ({ state: 'NORMAL', triggerCounter: 0, recoveryCounter: 0 }),
          save: async () => {},
        },
        commands,
        sampling: { maxAgeMs: 15000, maxGapMs: null },
        now: () => new Date(T),
      });
    }
    const off = await engine(false).tick(),
      on = await engine(true).tick();
    expect(on).toEqual(off);
    expect(on[0]!.outcome).toBe('NO_ACTION');
    expect(on.slice(1).every((d) => d.outcome === 'FAILED' && !d.verified)).toBe(true);
    expect(commands.execute).not.toHaveBeenCalled();
  });
});

describe('F3/F4, disable switch and adversarial lifecycle', () => {
  it('poller refresh does not erase an independent bridge client', () => {
    const g = new FastGrowthNotifications(15000),
      a = target('a'),
      b = target('b');
    const at = sudden(g, a);
    for (let i = 0; i < 12; i++)
      g.recordBridge({ profileId: 'b', growth: b.profiles[0]! }, row(b, T + i * 5000, 80));
    g.recordBridge({ profileId: 'b', growth: b.profiles[0]! }, row(b, at, 95));
    g.refresh([a]);
    expect(growth(g.enrich(n(at, 'a')))?.growthClassification).toBe('BRUSCO');
    expect(growth(g.enrich(n(at, 'b')))?.growthClassification).toBe('MODERADO');
    g.refresh([]);
    expect(g.enrich(n(at, 'a'))).toEqual(n(at, 'a'));
    expect(growth(g.enrich(n(at, 'b')))).toBeDefined();
    g.recordBridge({ profileId: 'b' }, null);
    expect(g.enrich(n(at, 'b'))).toEqual(n(at, 'b'));
  });
  it('RX invalidation cannot contaminate TX and vice versa', () => {
    const g = new FastGrowthNotifications(15000),
      t = target(),
      at = sudden(g, t);
    g.record(t, { ...row(t, at + 5000, 96), rxBps: NaN });
    expect(growth(g.enrich(n(at + 5000)))?.growthClassification).toBe('BRUSCO');
    expect(g.enrich({ ...n(at + 5000), direction: 'rx' }).growth).toBeUndefined();
    g.record(t, { ...row(t, at + 10000, 0, 95), txBps: NaN });
    expect(growth(g.enrich(n(at + 10000)))?.growthClassification).toBe('INDETERMINADO');
    expect(growth(g.enrich({ ...n(at + 10000), direction: 'rx' }))?.thresholdReachedAt).toBeNull();
  });
  it('actual Counter64 reset is rejected by the rate calculator and invalidates the current reference', () => {
    const g = new FastGrowthNotifications(15000),
      t = target(),
      at = sudden(g, t);
    const previous = row(t, at, 95),
      current = row(t, at + 5000, 95);
    previous.outOctets = 1000000000000n;
    current.outOctets = 1n;
    const invalid = deriveFastTraffic(t, current, previous, 'one');
    expect(invalid.quality).not.toBe('VALID');
    g.record(t, invalid);
    expect(growth(g.enrich(n(at + 5000)))).toMatchObject({
      growthClassification: 'INDETERMINADO',
      thresholdReachedAt: null,
      currentUtilizationPct: null,
    });
  });
  it('runtime switch clears live data only; already-enqueued retries remain identical after restart', async () => {
    let enabled = true;
    const g = new FastGrowthNotifications(
        15000,
        () => true,
        () => enabled,
      ),
      t = target(),
      at = sudden(g, t);
    const snapshot = g.enrich(n(at));
    const store = new MemoryAutomationStore();
    let sent = false;
    const received: MitigationNotification[] = [];
    const transport = {
      publish: async (value: MitigationNotification) => {
        received.push(value);
        return { published: sent, skipped: false };
      },
    };
    let now = at;
    await new DurableMitigationOutbox(store, transport, () => now).publish(snapshot);
    await new DurableMitigationOutbox(store, transport, () => now).drain();
    enabled = false;
    expect(g.enrich(n(at + 1))).toEqual(n(at + 1));
    g.record(t, row(t, at + 5000, 99));
    enabled = true;
    g.record(t, row(t, at + 10000, 99));
    expect(growth(g.enrich(n(at + 10000)))?.thresholdReachedAt).toBeNull();
    const restarted = new FastGrowthNotifications(15000);
    expect(restarted.enrich(n(at))).toEqual(n(at));
    now += 30000;
    sent = true;
    await new DurableMitigationOutbox(store, transport, () => now).drain();
    expect(received).toEqual([snapshot, snapshot]);
    expect((await store.transaction((tx) => tx.list<OutboxEntry>('outbox')))[0]!.state).toBe(
      'SENT',
    );
  });
  it.each([undefined, '1', 'true', 'on', '0', 'false', 'invalid'])(
    'flag %s affects only Growth',
    (value) => {
      const env: Record<string, string | undefined> = { MITIGATION_FAST_GROWTH_ENABLED: value };
      expect(fastGrowthEnabled(env)).toBe(
        value === undefined || ['1', 'true', 'on'].includes(value),
      );
    },
  );
});
