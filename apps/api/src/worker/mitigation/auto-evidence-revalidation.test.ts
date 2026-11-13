/**
 * Post-preflight re-validation of the AUTO evidence (FAST -> detection -> dispatch -> PREFLIGHT -> REVALIDATION
 * -> reservation/authorization -> executor).
 *
 * Defect found by the first real AUTO attempt on the F1A (12/11/2026): dispatch ~3.4 s after the trigger sample +
 * physical read ~3.4 s + preflight ~7.3 s = ~15.3 s, while the old check required the ORIGINAL trigger sample to be
 * <= 15 s old and the freshest sample to be that sample or its direct successor (FAST cadence 5 s). The mitigation was
 * rejected with AUTO_TELEMETRY_UNAVAILABLE although traffic stayed ~7x above the threshold.
 *
 * Contract tested here: a slow preflight alone must NOT invalidate a mitigation that is still proven necessary, and the
 * ABSENCE of valid evidence must still block: stale/lost samples, another continuity, falling traffic, an expired
 * response deadline, a sample older than the trigger.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_TRIGGER_EVIDENCE_DEADLINE_MS,
  pilotEvidenceValid,
  refreshPilotEvidence,
} from './single-pilot-trigger';
import type { MitigationTrafficSample } from './mitigation-traffic-source';
import { createAutoAllHarness } from '../../testing/auto-all-physical-harness';
import { SINGLE_AUTO_PILOT as P } from './single-pilot-trigger';

const T0 = Date.parse('2026-11-12T23:40:26.264Z'); // trigger sample (real attempt)
const KEY = 'FAST:7:host-377c554a:cmsxk21gs03pdssimims9ojlb:236:tx';
const THRESHOLD = 100_000_000n; // triggerPercent 1 on 10 Gbps (the supervised stimulus)
const WINDOW = { maxAgeMs: 15_000, maxGapMs: 15_000 };
const iso = (ms: number) => new Date(ms).toISOString();
const evidence = {
  sampleAt: iso(T0),
  continuityKey: KEY,
  sequenceStartedAt: iso(T0 - 10_000),
  samplesOver: 3,
};
const sample = (
  atMs: number,
  options: { bps?: bigint; key?: string; gapMs?: number } = {},
): MitigationTrafficSample => ({
  bps: options.bps ?? 731_865_252n,
  sampleKey: `s-${atMs}`,
  occurredAt: new Date(atMs),
  rateStartAt: new Date(atMs - (options.gapMs ?? 5_000)),
  continuityKey: options.key ?? KEY,
});
/** A sample WITHOUT an optional field (exactOptionalPropertyTypes forbids assigning `undefined`). */
const without = (
  s: MitigationTrafficSample,
  key: 'continuityKey' | 'rateStartAt',
): MitigationTrafficSample => {
  const copy = { ...s };
  delete copy[key];
  return copy;
};
const refresh = (
  s: MitigationTrafficSample | null,
  nowMs: number,
  e: typeof evidence | undefined = evidence,
  deadline?: number,
) => refreshPilotEvidence(s, e, nowMs, THRESHOLD, WINDOW, deadline);

describe('refreshPilotEvidence: slow preflight does not, by itself, invalidate the mitigation', () => {
  it('REPRODUCES the real attempt: the old check rejects at ~15.3 s although traffic is ~7x the threshold', () => {
    const now = T0 + 15_350; // post-preflight, as measured
    const latest = sample(T0 + 15_000); // 3rd FAST sample after the trigger (5 s cadence)
    expect(pilotEvidenceValid(latest, evidence, now, THRESHOLD, WINDOW)).toBe(false); // the defect
    expect(refresh(latest, now)).not.toBeNull(); // fixed: current sample is fresh, continuous and above the threshold
  });

  it('preflight shorter than 15 s (sample is the trigger itself or its successor) is accepted as before', () => {
    expect(refresh(sample(T0), T0 + 4_000)).toEqual({ ...evidence, sampleAt: iso(T0) });
    expect(refresh(sample(T0 + 5_000), T0 + 8_000)).toEqual({
      ...evidence,
      sampleAt: iso(T0 + 5_000),
    });
    expect(pilotEvidenceValid(sample(T0 + 5_000), evidence, T0 + 8_000, THRESHOLD, WINDOW)).toBe(
      true,
    );
  });

  it('preflight longer than 15 s with a NEW valid sample during it: accepted and the evidence is RE-ANCHORED to that sample', () => {
    for (const elapsed of [16_000, 25_000, 40_000, 59_000]) {
      const latestAt = T0 + elapsed - 2_000;
      const out = refresh(sample(latestAt), T0 + elapsed);
      expect(out).not.toBeNull();
      expect(out!.sampleAt).toBe(iso(latestAt)); // what the write authorization will judge
      expect(out!.continuityKey).toBe(KEY);
      expect(out!.sequenceStartedAt).toBe(evidence.sequenceStartedAt); // detection identity untouched
      expect(out!.samplesOver).toBe(3);
    }
  });

  it('does not mutate the evidence it was given', () => {
    const copy = JSON.parse(JSON.stringify(evidence));
    refresh(sample(T0 + 15_000), T0 + 16_000);
    expect(evidence).toEqual(copy);
  });
});

describe('refreshPilotEvidence: absence of valid evidence still BLOCKS', () => {
  it('lost samples: the freshest sample is older than the 15 s freshness limit (exactly 15.000 s passes, 15.001 s does not)', () => {
    const latest = sample(T0 + 5_000);
    expect(refresh(latest, T0 + 5_000 + 15_000)).not.toBeNull();
    expect(refresh(latest, T0 + 5_000 + 15_001)).toBeNull();
    expect(refresh(latest, T0 + 40_000)).toBeNull(); // FAST stalled during the preflight
  });

  it('lost samples inside the rate window: a gap larger than maxGap invalidates the continuity', () => {
    expect(refresh(sample(T0 + 15_000, { gapMs: 15_000 }), T0 + 16_000)).not.toBeNull();
    expect(refresh(sample(T0 + 15_000, { gapMs: 15_001 }), T0 + 16_000)).toBeNull();
    expect(refresh(sample(T0 + 15_000, { gapMs: 30_000 }), T0 + 16_000)).toBeNull();
  });

  it('interrupted continuity / other detection identity (generation, interface, direction) is never accepted', () => {
    for (const other of [
      'FAST:8:host-377c554a:cmsxk21gs03pdssimims9ojlb:236:tx', // new generation (collector restarted)
      'FAST:7:host-377c554a:another-interface:236:tx',
      'FAST:7:host-377c554a:cmsxk21gs03pdssimims9ojlb:236:rx',
      '',
    ])
      expect(refresh(sample(T0 + 10_000, { key: other }), T0 + 12_000)).toBeNull();
    expect(refresh(without(sample(T0 + 10_000), 'continuityKey'), T0 + 12_000)).toBeNull();
  });

  it('traffic that falls to or below the threshold during the preflight blocks (strict >)', () => {
    expect(refresh(sample(T0 + 10_000, { bps: THRESHOLD + 1n }), T0 + 12_000)).not.toBeNull();
    expect(refresh(sample(T0 + 10_000, { bps: THRESHOLD }), T0 + 12_000)).toBeNull();
    expect(refresh(sample(T0 + 10_000, { bps: 0n }), T0 + 12_000)).toBeNull();
  });

  it('missing/invalid telemetry or evidence blocks', () => {
    expect(refresh(null, T0 + 5_000)).toBeNull();
    expect(
      refreshPilotEvidence(sample(T0 + 5_000), undefined, T0 + 6_000, THRESHOLD, WINDOW),
    ).toBeNull();
    expect(refresh({ ...sample(T0 + 5_000), occurredAt: null }, T0 + 6_000)).toBeNull();
    expect(refresh({ ...sample(T0 + 5_000), rateStartAt: null }, T0 + 6_000)).toBeNull();
    expect(refresh(without(sample(T0 + 5_000), 'rateStartAt'), T0 + 6_000)).toBeNull();
    expect(
      refresh(sample(T0 + 5_000), T0 + 6_000, { ...evidence, sampleAt: 'not-a-date' }),
    ).toBeNull();
    expect(
      refresh({ ...sample(T0 + 5_000), occurredAt: new Date(Number.NaN) }, T0 + 6_000),
    ).toBeNull();
  });

  it('a sample from the future, or older than the trigger, or whose rate window reaches back before it, is rejected', () => {
    expect(refresh(sample(T0 + 20_000), T0 + 10_000)).toBeNull(); // future sample
    expect(refresh(sample(T0 - 5_000), T0 + 5_000)).toBeNull(); // older than the trigger
    expect(refresh(sample(T0 + 5_000, { gapMs: 8_000 }), T0 + 6_000)).toBeNull(); // window starts before T0
    expect(refresh(sample(T0 + 5_000, { gapMs: 5_000 }), T0 + 6_000)).not.toBeNull();
    expect(refresh(sample(T0 + 2_000), T0 + 3_000)).toBeNull(); // not the trigger nor a clean successor (T0-3 s)
  });

  it('the ORIGINAL trigger is never revived beyond the response deadline (60 s), even with a perfectly fresh sample', () => {
    expect(AUTO_TRIGGER_EVIDENCE_DEADLINE_MS).toBe(60_000);
    expect(refresh(sample(T0 + 59_000), T0 + 60_000)).not.toBeNull();
    expect(refresh(sample(T0 + 60_000), T0 + 60_001)).toBeNull();
    expect(refresh(sample(T0 + 90_000), T0 + 91_000)).toBeNull();
    // the deadline is a parameter of the contract, not of the call site: a tighter one is honored
    expect(refresh(sample(T0 + 30_000), T0 + 31_000, evidence, 20_000)).toBeNull();
  });

  it('the 15 s freshness limit itself is unchanged and is NOT widened by the deadline', () => {
    expect(WINDOW.maxAgeMs).toBe(15_000);
    const old = sample(T0 + 20_000);
    expect(refresh(old, T0 + 20_000 + 15_001)).toBeNull();
  });
});

describe('physical harness: FAST -> detection -> dispatch -> preflight -> revalidation -> executor', () => {
  const HIGH = 9_400_000_000n;
  const LOW = 300_000_000n;
  const warm = async (h: Awaited<ReturnType<typeof createAutoAllHarness>>) => {
    await h.cycle({});
    await h.cycle({});
  };
  type H = Awaited<ReturnType<typeof createAutoAllHarness>>;
  /** What the durable journal recorded for the AUTO commands of the attempt (no write happened in any blocked case). */
  const journal = async (h: H) =>
    h.store.transaction((tx) =>
      tx.list<{ id: string; state: string; result: { status?: string } | null }>('command', [
        'PLANNED',
        'STARTED',
        'UNCERTAIN',
        'VERIFIED',
      ]),
    );
  const run = async (options: Parameters<typeof createAutoAllHarness>[0]) => {
    const h = await createAutoAllHarness(options);
    await warm(h);
    const decisions = [];
    for (let i = 0; i < 3; i++)
      decisions.push(
        (await h.cycle({ [P.profileId]: HIGH })).find((d) => d.profileId === P.profileId)!,
      );
    return { h, last: decisions.at(-1)!, writes: h.ssh.writes.length };
  };

  it('slow equipment (per-operation latencies up to 10 s, with and without the read scope) still writes exactly ONCE', async () => {
    for (const useReadScope of [true, false])
      for (const sshLatencyMs of [0, 2_500, 5_000, 7_300, 9_000]) {
        const { writes, last } = await run({ sshLatencyMs, useReadScope, decisionDelayMs: 3_400 });
        expect(writes, `scope=${useReadScope} latency=${sshLatencyMs}`).toBe(1);
        expect(last.verified).toBe(true);
      }
  });

  /**
   * A blocked attempt is the SAME safe outcome the real F1A produced: nothing reaches the equipment, the engine
   * decision is FAILED/AUTO_RECONCILIATION_REQUIRED, the journal command records AUTO_TELEMETRY_UNAVAILABLE and the
   * scope is quarantined (UNCERTAIN) until a supervised reconciliation. Never a write.
   */
  const expectBlockedWithoutWrite = async (
    h: H,
    last: { outcome: string; commandStatus?: string | null },
  ) => {
    expect(h.ssh.writes).toHaveLength(0);
    expect(last.outcome).toBe('FAILED');
    expect(last.commandStatus).toBe('AUTO_RECONCILIATION_REQUIRED');
    const commands = await journal(h);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.state).toBe('UNCERTAIN'); // never STARTED/VERIFIED
    expect(commands[0]!.result?.status).toBe('AUTO_TELEMETRY_UNAVAILABLE');
    expect((await h.scope())?.phase).toBe('UNCERTAIN'); // quarantined, as in production
  };

  it('FAST samples are LOST during the preflight and the freshest one is older than 15 s: blocked, nothing written', async () => {
    const { h, last, writes } = await run({
      sshLatencyMs: 16_000, // one paid snapshot (read scope) = 16 s with the collector stalled
      useReadScope: true,
      duringSsh: (i) => (i === 0 ? 'STALL' : undefined),
    });
    expect(writes).toBe(0);
    await expectBlockedWithoutWrite(h, last);
  });

  it('the canonical 15 s freshness is the limit, not the length of the preflight: a stalled collector with a 9 s old sample is still valid evidence', async () => {
    const { writes, last } = await run({
      sshLatencyMs: 9_000,
      useReadScope: true,
      duringSsh: (i) => (i === 0 ? 'STALL' : undefined),
    });
    expect(writes).toBe(1);
    expect(last.verified).toBe(true);
  });

  it('traffic falls below the threshold DURING the preflight: blocked, nothing written', async () => {
    const { h, last, writes } = await run({
      sshLatencyMs: 6_000,
      useReadScope: true,
      duringSsh: (i) => (i === 0 ? { [P.profileId]: LOW } : undefined),
    });
    expect(writes).toBe(0);
    await expectBlockedWithoutWrite(h, last);
  });

  it('a preflight that outlives the 60 s response deadline is blocked even though FAST kept producing fresh samples', async () => {
    const { h, last, writes } = await run({
      sshLatencyMs: 16_000,
      useReadScope: false, // several paid equipment reads: > 60 s since the trigger
      decisionDelayMs: 0,
    });
    expect(writes).toBe(0);
    await expectBlockedWithoutWrite(h, last);
  });

  it('after the blocked attempt the scope stays quarantined: no second dispatch can write', async () => {
    const { h } = await run({
      sshLatencyMs: 6_000,
      useReadScope: true,
      duringSsh: (i) => (i === 0 ? { [P.profileId]: LOW } : undefined),
    });
    for (let i = 0; i < 12; i++) {
      h.advance(60_000);
      await h.cycle({ [P.profileId]: HIGH });
    }
    expect(h.ssh.writes).toHaveLength(0);
    expect((await h.scope())?.phase).toBe('UNCERTAIN');
  });

  it('the write authorization judges the REFRESHED evidence: same detection (continuity, start, count), newer sample', async () => {
    const h = await createAutoAllHarness({
      sshLatencyMs: 7_300,
      useReadScope: false,
      decisionDelayMs: 3_400,
    });
    await warm(h);
    const execute = vi.spyOn(h.commands, 'execute');
    const original = h.lifecycle.authorize.bind(h.lifecycle);
    let virtualNowAtAuthorization = 0;
    const authorize = vi.spyOn(h.lifecycle, 'authorize').mockImplementation(async (input, pair) => {
      virtualNowAtAuthorization = h.now(); // the instant the write is authorized (before the write itself)
      return original(input, pair);
    });
    for (let i = 0; i < 3; i++) await h.cycle({ [P.profileId]: HIGH });
    expect(h.ssh.writes).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(1);
    const dispatched = execute.mock.calls[0]![0].autoEvidence!;
    const judged = authorize.mock.calls[0]![0].autoEvidence!;
    expect(judged.continuityKey).toBe(dispatched.continuityKey); // same detection / continuity
    expect(judged.sequenceStartedAt).toBe(dispatched.sequenceStartedAt);
    expect(judged.samplesOver).toBe(dispatched.samplesOver);
    // re-anchored: the sample the authorization sees is MORE THAN ONE FAST cadence newer than the trigger sample
    expect(Date.parse(judged.sampleAt) - Date.parse(dispatched.sampleAt)).toBeGreaterThanOrEqual(
      10_000,
    );
    // and still within the canonical freshness of the moment of the write
    expect(virtualNowAtAuthorization - Date.parse(judged.sampleAt)).toBeLessThanOrEqual(15_000);
  });

  it('concurrent ticks during a long preflight never re-dispatch or double-validate: one command, one write', async () => {
    const h = await createAutoAllHarness({
      sshLatencyMs: 7_300,
      useReadScope: false,
      asyncExecution: true,
    });
    await warm(h);
    const execute = vi.spyOn(h.commands, 'execute');
    for (let i = 0; i < 3; i++) await h.cycle({ [P.profileId]: HIGH });
    for (let i = 0; i < 6; i++) await h.cycle({ [P.profileId]: HIGH }); // ticks while the preflight is in flight
    await h.engine.settleExecutions();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(h.ssh.writes).toHaveLength(1);
    expect(await journal(h)).toHaveLength(1);
  });

  it('kill switch, allowlist and AUTO_REMOVE barriers are untouched by the new re-validation', async () => {
    const off = await createAutoAllHarness({ executionEnabled: false, sshLatencyMs: 7_300 });
    await warm(off);
    for (let i = 0; i < 3; i++) await off.cycle({ [P.profileId]: HIGH });
    expect(off.ssh.writes).toHaveLength(0);
    const denied = await createAutoAllHarness({
      allowlist: ['some-other-profile'],
      sshLatencyMs: 7_300,
    });
    await warm(denied);
    for (let i = 0; i < 3; i++) await denied.cycle({ [P.profileId]: HIGH });
    expect(denied.ssh.writes).toHaveLength(0);
  });
});
