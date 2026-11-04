import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  COUNTER64_BASE,
  fastLifecycleScenario,
  offeredOctets,
} from '../../testing/fast-lifecycle-scenario';
import { fastPollerConfig } from './fast-traffic-poller';

const stats = (values: Array<number | null>) => {
  const sorted = values.filter((n): n is number => n !== null).sort((a, b) => a - b);
  const p = (q: number) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? null;
  return { n: sorted.length, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: sorted.at(-1) ?? null };
};

describe('F3: actual poller, persisted FAST quality, source, lifecycle and fake canonical Huawei', () => {
  it('Counter64 integrates only actual attack time, including missed GET intervals', () => {
    const at0 = offeredOctets(0, 8000),
      at10 = offeredOctets(10000, 8000),
      at30 = offeredOctets(30000, 8000);
    expect(at0).toBe(COUNTER64_BASE);
    expect(((at10 - at0) * 8000n) / 10000n).toBe(4_400_000_000n);
    expect(((at30 - at10) * 8000n) / 20000n).toBe(10_000_000_000n);
    expect(at30).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });
  it('measures attack and benign cohorts using the actual scheduler and three-sample lifecycle', async () => {
    const matrix = [];
    for (const [cadenceSeconds, timeoutRate] of [
      [10, 0],
      [10, 0.03],
      [15, 0],
      [30, 0],
    ] as const) {
      const attacks = [],
        benign = [];
      for (let i = 0; i < 40; i++) {
        attacks.push(
          await fastLifecycleScenario({
            cadenceSeconds: cadenceSeconds!,
            timeoutRate,
            seed: 1234 + i * 7919,
          }),
        );
        benign.push(
          await fastLifecycleScenario({
            cadenceSeconds: cadenceSeconds!,
            timeoutRate,
            seed: 5123 + i * 7919,
            attack: false,
          }),
        );
      }
      for (const run of attacks) {
        expect(run.commands).toHaveLength(1);
        expect(run.commands[0]!.result.verified).toBe(true);
        expect(run.confirmationSamples).toBeGreaterThanOrEqual(3);
        expect(
          run.observations.every(
            (o) => o.inOctets >= COUNTER64_BASE && o.outOctets >= COUNTER64_BASE,
          ),
        ).toBe(true);
        const command = run.commands[0]!;
        const start = Date.parse(command.input.autoEvidence!.sequenceStartedAt!),
          last = Date.parse(command.input.autoEvidence!.sampleAt);
        const counted = run.observations.filter(
          (o) => +o.collectedAt >= start && +o.collectedAt <= last,
        );
        expect(counted.length).toBeGreaterThanOrEqual(3);
        expect(new Set(counted.map((o) => o.id)).size).toBe(counted.length);
        for (let i = 0; i < counted.length; i++) {
          expect(counted[i]!.quality).toBe('VALID');
          expect(counted[i]!.txBps!).toBeGreaterThan(9_000_000_000);
          if (i) expect(counted[i]!.previousCollectedAt).toEqual(counted[i - 1]!.collectedAt);
        }
        expect(run.scope?.phase).toBe('ACTIVE');
      }
      for (const run of benign) {
        expect(run.commands).toHaveLength(0);
        expect(run.falsePositive).toBe(false);
      }
      const row = {
        synthetic: true,
        physicalHuawei: false,
        cadenceSeconds,
        timeoutRate,
        attackTrials: attacks.length,
        benignTrials: benign.length,
        confirmed: attacks.filter((a) => a.commands.some((c) => c.result.verified)).length,
        falsePositives: benign.filter((b) => b.falsePositive).length,
        firstAbnormalMs: stats(attacks.map((a) => a.firstAbnormalMs)),
        confirmationMs: stats(attacks.map((a) => a.confirmationMs)),
        decisionDelayMs: stats(attacks.map((a) => a.decisionDelayMs)),
        commandMs: stats(attacks.map((a) => a.commandMs)),
        readbackMs: stats(attacks.map((a) => a.timingsMs?.readback ?? null)),
        totalVerifiedSinceAttackMs: stats(attacks.map((a) => a.totalVerifiedSinceAttackMs)),
        timeouts: attacks.reduce((n, a) => n + a.timeouts.length, 0),
        gapsOver15Seconds: attacks.reduce((n, a) => n + a.pollerStatus.gapsOver15Seconds, 0),
        perTrial: attacks.map((a) => ({
          attackAtMs: a.attackAtMs,
          firstAbnormalMs: a.firstAbnormalMs,
          confirmationMs: a.confirmationMs,
          decisionDelayMs: a.decisionDelayMs,
          commandMs: a.commandMs,
          timingsMs: a.timingsMs,
          totalVerifiedSinceAttackMs: a.totalVerifiedSinceAttackMs,
          observations: a.observations.length,
        })),
      };
      matrix.push(row);
      console.log('FAST_SIM_CORRECTED ' + JSON.stringify({ ...row, perTrial: undefined }));
    }
    const dir = resolve(process.cwd(), '../../.artifacts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'fast-corrected-simulator.json'),
      JSON.stringify(
        {
          synthetic: true,
          statistics: 'N=40 per cohort, nearest-rank p99 is sample maximum, no physical SLA',
          matrix,
        },
        null,
        2,
      ),
    );
  }, 120000);
  it('scheduler honors an eventual faster suspect cadence without a duplicated scheduling model', async () => {
    const run = await fastLifecycleScenario({
      cadenceSeconds: 30,
      suspectIntervalMs: 10000,
      seed: 1234,
    });
    expect(run.pollerStatus.normalIntervalMs).toBe(30000);
    expect(run.pollerStatus.suspectIntervalMs).toBe(10000);
    expect(run.observations.some((o) => o.intervalMs !== null && o.intervalMs >= 30000)).toBe(true);
    expect(
      run.observations.some(
        (o) => o.intervalMs !== null && o.intervalMs >= 10000 && o.intervalMs < 15000,
      ),
    ).toBe(true);
    expect(run.commands).toHaveLength(1);
  });
  it('RX is measured without a TX mitigation, and execution OFF never dispatches ACTIVATE', async () => {
    const rx = await fastLifecycleScenario({
      cadenceSeconds: 10,
      seed: 1234,
      attackDirection: 'rx',
    });
    expect(rx.observations.some((o) => (o.rxBps ?? 0) > 9_000_000_000)).toBe(true);
    expect(rx.commands).toHaveLength(0);
    const off = await fastLifecycleScenario({
      cadenceSeconds: 10,
      seed: 1234,
      executionEnabled: false,
    });
    expect(off.commands).toHaveLength(0);
  });
  it('database delay invalidates stale evidence and normalization never dispatches REMOVE', async () => {
    const late = await fastLifecycleScenario({
      cadenceSeconds: 10,
      seed: 1234,
      databaseDelayMs: 20000,
    });
    expect(late.commands).toHaveLength(0);
    const recovered = await fastLifecycleScenario({
      cadenceSeconds: 10,
      seed: 1234,
      attackDurationMs: 60000,
    });
    expect(recovered.commands).toHaveLength(1);
    expect(recovered.commands[0]!.input.action).toBe('ACTIVATE');
    expect(recovered.scope?.phase).toBe('ACTIVE');
  });
  it('5 seconds remains rejected by the actual poller configuration', () => {
    expect(() => fastPollerConfig({ MITIGATION_FAST_NORMAL_SECONDS: '5' })).toThrow(
      'Invalid MITIGATION_FAST_NORMAL_SECONDS',
    );
  });
});
