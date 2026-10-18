import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fastResponseScenario } from '../../testing/fast-response-scenario';
import { performance as nodePerformance } from 'node:perf_hooks';
const realNow = nodePerformance.now.bind(nodePerformance);

afterEach(() => vi.useRealTimers());
const stats = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  return {
    count: s.length,
    p50: s[Math.max(0, Math.ceil(s.length * 0.5) - 1)] ?? null,
    p95: s[Math.max(0, Math.ceil(s.length * 0.95) - 1)] ?? null,
    max: s.at(-1) ?? null,
  };
};

describe('complete controlled pipeline (synthetic SNMP and Huawei)', () => {
  it.each([1, 4])(
    '18 hosts / 2379 interfaces / %i simultaneous protected profiles: verified within 60s',
    async (protectedProfiles) => {
      vi.useFakeTimers();
      const start = Date.parse('2026-10-17T20:31:00Z');
      vi.setSystemTime(start);
      const cpu = process.cpuUsage();
      const wall = realNow();
      const memoryStart = process.memoryUsage().heapUsed;
      let peakHeap = memoryStart;
      const h = await fastResponseScenario({
        startAt: start,
        attackAt: start + 55000,
        protectedProfiles,
        databaseDelayMs: 25,
      });
      h.start();
      for (let i = 0; i < 30; i++) {
        await vi.advanceTimersByTimeAsync(10000);
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      }
      const activations = h.decisions.filter((d) => d.outcome === 'ACTIVATED');
      expect(activations).toHaveLength(protectedProfiles);
      for (const d of activations) {
        expect(d.totalResponseMs).toBeLessThanOrEqual(60000);
        expect(d.responseDeadlineExceeded).toBe(false);
      }
      const gaps = h.observations.filter((o) => o.quality === 'VALID').map((o) => o.intervalMs!);
      const collection = h.observations.map(
        (o) => o.collectedAt.getTime() - o.requestStartedAt.getTime(),
      );
      expect(stats(gaps).max).toBeLessThanOrEqual(21000);
      expect(h.counts.every((n) => n <= 33)).toBe(true);
      expect(h.conventionalCalls()).toBeLessThan(18); // global sweep is still running, fast stream is independent
      const response = stats(activations.map((d) => d.totalResponseMs!));
      const report = {
        synthetic: true,
        clock: 'Vitest virtual timers, real scheduler/engine/command/verification code',
        inventory: {
          hosts: h.hosts.length,
          interfaces: h.interfaces.length,
          protectedProfiles,
          unconfiguredProfiles: 32,
        },
        durationMs: 300000,
        sampleIntervalMs: stats(gaps),
        collectionMs: stats(collection),
        detectionMs: stats(
          h.profiles.map(
            (p) =>
              h.observations
                .find((o) => o.interfaceId === p.interfaceId && o.txBps !== null && o.txBps >= 9e9)!
                .collectedAt.getTime() -
              (start + 55000),
          ),
        ),
        confirmationMs: stats(activations.map((d) => d.confirmationMs!)),
        commandMs: stats(activations.map((d) => d.commandMs!)),
        totalResponseMs: response,
        stageTimings: h.commandResults.map((r) => r.timings),
        snmpCallsPerDevice: Object.fromEntries(h.calls),
        varbindCount: stats(h.counts),
        conventionalCalls: h.conventionalCalls(),
        snmpFailures: h.poller.status().failures,
        resourceMeasurement: {
          scope: 'local test process with synthetic transport; not a production capacity estimate',
          wallMs: realNow() - wall,
          cpuMicros: process.cpuUsage(cpu),
          heapStartBytes: memoryStart,
          peakHeapBytes: peakHeap,
        },
      };
      const dir = resolve(process.cwd(), '../../.artifacts');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        resolve(dir, `fast-benchmark-${protectedProfiles}.json`),
        JSON.stringify(report, null, 2),
      );
      const stopped = h.stop();
      await vi.advanceTimersByTimeAsync(5000);
      await stopped;
    },
  );

  it.each(['preflight', 'readback', 'snmp', 'brief', 'down', 'frozen'] as const)(
    '%s failure/regression produces no verified activation',
    async (kind) => {
      vi.useFakeTimers();
      const start = 1000000;
      vi.setSystemTime(start);
      const h = await fastResponseScenario({
        startAt: start,
        attackAt: start + 55000,
        ...(kind === 'preflight' ? { preflightFails: true } : {}),
        ...(kind === 'readback' ? { readbackFails: true } : {}),
        ...(kind === 'snmp' ? { unavailableHost: 0 } : {}),
        ...(kind === 'brief' ? { attackEndsAt: start + 56000 } : {}),
        ...(kind === 'down' ? { downAt: start + 65000 } : {}),
        ...(kind === 'frozen' ? { frozenAt: start + 61000 } : {}),
      });
      h.start();
      await vi.advanceTimersByTimeAsync(160000);
      expect(h.decisions.filter((d) => d.outcome === 'ACTIVATED')).toHaveLength(0);
      if (kind !== 'readback')
        expect(
          h.hardware.calls.filter((c) => c.includes('route-policy') && !c.startsWith('display')),
        ).toHaveLength(0);
      if (kind === 'readback')
        expect((await h.repository.getRuntime(h.profiles[0]!.id))?.state).toBe(
          'RECONCILIATION_REQUIRED',
        );
      const stopped = h.stop();
      await vi.advanceTimersByTimeAsync(5000);
      await stopped;
    },
  );
  it('does not hide a readback exceeding the response budget', async () => {
    vi.useFakeTimers();
    const start = 1000000;
    vi.setSystemTime(start);
    const h = await fastResponseScenario({
      startAt: start,
      attackAt: start + 55000,
      readbackMs: 45000,
    });
    h.start();
    await vi.advanceTimersByTimeAsync(180000);
    const activated = h.decisions.find((d) => d.outcome === 'ACTIVATED')!;
    expect(activated.totalResponseMs).toBeGreaterThan(60000);
    expect(activated.responseDeadlineExceeded).toBe(true);
    const stopped = h.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await stopped;
  });
  it('DOWN during preflight cancels before hardware write', async () => {
    vi.useFakeTimers();
    const start = 1000000;
    vi.setSystemTime(start);
    const h = await fastResponseScenario({
      startAt: start,
      attackAt: start + 55000,
      preflightMs: 15000,
      downAt: start + 86000,
    });
    h.start();
    await vi.advanceTimersByTimeAsync(180000);
    expect(
      h.decisions.some((d) => d.reason === 'TELEMETRY_UNAVAILABLE' && d.outcome === 'FAILED'),
    ).toBe(true);
    expect(h.hardware.calls.filter((c) => c.startsWith('route-policy'))).toHaveLength(0);
    const stopped = h.stop();
    await vi.advanceTimersByTimeAsync(5000);
    await stopped;
  });
});
