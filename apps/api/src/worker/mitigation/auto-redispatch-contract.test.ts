/**
 * Contract of the AUTO re-dispatch after a failure that happens BEFORE the durable reservation
 * (e.g. AUTO_PHYSICAL_READ_FAILED: the equipment could not be read, nothing was reserved, nothing written).
 *
 * Observed on the first real AUTO attempt (12/11/2026, FAST cadence 5 s, threshold already exceeded):
 *   23:39:35 dispatch #1 (request ...a65e) -> AUTO_PHYSICAL_READ_FAILED
 *   23:39:54 dispatch #2 (request ...31bb) -> AUTO_PHYSICAL_READ_FAILED   (16.5 s after #1 ended)
 *   23:40:29 dispatch #3 (request ...4e11) -> reserved, preflight, AUTO_TELEMETRY_UNAVAILABLE (31.5 s after #2 ended)
 *
 * Investigation result (documented here as executable contract; NO engine code was changed):
 *  - the re-dispatches are the DESIGNED failure back-off of the FAST path (15 s x 2^(n-1), capped at 120 s, measured
 *    from the END of the failed execution), on a NEW sample each time (distinct requestId = sample identity);
 *  - they are never concurrent (in-flight guard) and never repeat the same sample beyond maxRetriesPerSample;
 *  - a failure before the reservation leaves no durable block ON PURPOSE: the next legitimate attempt must be possible
 *    as soon as the equipment is readable again; a failure AFTER the reservation quarantines the scope (UNCERTAIN) and
 *    stops every further dispatch (see auto-evidence-revalidation.test.ts).
 * So the behaviour is within the existing contract: no defect in the dispatch logic, only the (separate) read/evidence
 * defects that made each attempt fail.
 */
import { describe, expect, it } from 'vitest';
import { BASE_TIME, Runner, type Step } from '../../testing/mitigation-engine-harness';

const over = 9_500_000_000n;
const FAST = { maxAgeMs: 15_000, maxGapMs: 15_000 as number | null };
const at = (s: number) => BASE_TIME + s * 1_000;
const sampleEvery5s = (seconds: number): Step => ({
  at: at(seconds),
  sample: { bps: over, atMs: at(seconds), rateStartAtMs: at(seconds - 5) },
});
const failure = { ok: false, status: 'AUTO_PHYSICAL_READ_FAILED', verified: false } as const;

describe('AUTO re-dispatch after failures before the reservation', () => {
  it('re-dispatches only after the failure back-off (15 s, 30 s, 60 s, 120 s cap), always on a NEW sample', async () => {
    const steps: Step[] = [];
    for (let s = 0; s <= 300; s += 5) steps.push(sampleEvery5s(s));
    const result = await new Runner(
      { sampling: () => FAST, commandResults: Array.from({ length: 12 }, () => failure) },
      false,
    ).run(steps);
    const dispatchedAt = result.decisions
      .map((d, i) => ({ d, second: i * 5 }))
      .filter(({ d }) => d.outcome === 'FAILED' && d.reason === 'ACTIVATE_FAILED')
      .map(({ second }) => second);
    // trigger confirmed at t=10 s (3 samples). Back-off is counted from the end of the failed execution.
    expect(dispatchedAt.slice(0, 5)).toEqual([10, 25, 55, 115, 235]);
    expect(result.commandCalls).toHaveLength(dispatchedAt.length);
    // between dispatches the engine stays quiet (no SSH cost) and says why
    const between = result.decisions.filter((d) => d.reason === 'ACTIVATION_COOLDOWN');
    expect(between.length).toBeGreaterThan(10);
    // every dispatch is a different sample => a different requestId (idempotent per sample, never reused)
    const ids = result.commandCalls.map((c) => c.requestId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^auto-activate-.*-[0-9a-f]{12}$/);
  });

  it('never two dispatches inside the back-off window, whatever the tick pace', async () => {
    const steps: Step[] = [];
    for (let s = 0; s <= 120; s += 1)
      steps.push({ at: at(s), sample: { bps: over, atMs: at(s), rateStartAtMs: at(s - 1) } });
    const result = await new Runner(
      {
        sampling: () => ({ maxAgeMs: 15_000, maxGapMs: 15_000 }),
        commandResults: Array.from({ length: 30 }, () => failure),
      },
      false,
    ).run(steps);
    const times = result.decisions
      .map((d, i) => ({ d, second: i }))
      .filter(({ d }) => d.outcome === 'FAILED' && d.reason === 'ACTIVATE_FAILED')
      .map(({ second }) => second);
    for (let i = 1; i < times.length; i += 1) {
      const need = Math.min(15 * 2 ** Math.min(i - 1, 3), 120);
      expect(times[i]! - times[i - 1]!, `dispatch ${i}`).toBeGreaterThanOrEqual(need);
    }
  });

  it('the SAME sample is never re-dispatched beyond maxRetriesPerSample (idempotency of the sample identity)', async () => {
    const steps: Step[] = [sampleEvery5s(0), sampleEvery5s(5), sampleEvery5s(10)];
    for (let s = 11; s <= 14; s += 1) steps.push({ at: at(s) }); // same sample again and again
    const result = await new Runner(
      {
        sampling: () => FAST,
        failureBackoffMs: 1_000,
        maxRetriesPerSample: 1,
        commandResults: Array.from({ length: 10 }, () => failure),
      },
      false,
    ).run(steps);
    expect(result.commandCalls.length).toBeLessThanOrEqual(2);
    if (result.commandCalls.length === 2)
      expect(result.commandCalls[0]!.requestId).toBe(result.commandCalls[1]!.requestId); // same sample => same id
  });

  it('a legitimate attempt after the failures succeeds once and the success cooldown (30 s) prevents an immediate repetition', async () => {
    const steps: Step[] = [];
    for (let s = 0; s <= 80; s += 5) steps.push(sampleEvery5s(s)); // failures at 10 s and 25 s, success at 55 s
    const result = await new Runner(
      {
        sampling: () => FAST,
        commandResults: [
          failure,
          failure,
          { ok: true, status: 'ACTIVATED_VERIFIED', verified: true },
          { ok: true, status: 'ACTIVATED_VERIFIED', verified: true },
        ],
      },
      false,
    ).run(steps);
    const activated = result.decisions.filter((d) => d.outcome === 'ACTIVATED');
    expect(activated).toHaveLength(1);
    expect(result.commandCalls).toHaveLength(3); // 2 failures + 1 success; no 4th inside the 30 s success cooldown
  });
});
