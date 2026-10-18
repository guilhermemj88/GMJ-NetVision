import { describe, expect, it, vi } from 'vitest';
import { PrismaFastBridgeReader } from '../../infrastructure/snmp/prisma-fast-bridge-reader';
import { MitigationAutoEngine } from './mitigation-auto-engine';
import { defaultTarget } from '../../testing/mitigation-engine-harness';
import type { MitigationTrafficSample } from './mitigation-traffic-source';

const epoch = Date.parse('2026-10-18T23:00:00Z');
const row = (n: number) => ({
  id: String(n),
  generation: 'g',
  deviceId: 'd',
  interfaceId: 'i',
  ifIndex: 200,
  interfaceName: 'Eth-Trunk1.3043',
  collectedAt: new Date(epoch + n * 10000),
  inOctets: 1n,
  outOctets: 2n,
  quality: 'VALID',
});
const proof = (n: number, healthy = true) => ({
  observationOnly: true,
  executionAvailable: false,
  running: true,
  mode: 'OBSERVE',
  healthy,
  entries: [
    {
      deviceId: 'd',
      interfaceId: 'i',
      profileIds: ['p'],
      quality: 'VALID',
      lastCollectedAt: row(n).collectedAt.toISOString(),
      lastValidAt: row(n).collectedAt.toISOString(),
    },
  ],
});
function reader(health: ReturnType<typeof vi.fn>, quality = 'VALID') {
  const operational = {
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        $queryRaw: async () => [
          {
            id: 'i',
            deviceId: 'd',
            ifIndex: 200,
            name: 'Eth-Trunk1.3043',
            adminStatus: 'UP',
            operStatus: 'UP',
            speedBps: 300_000_000_000n,
          },
        ],
      }),
  };
  const observation = {
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        $queryRaw: async () => [{ transaction_read_only: 'on' }],
        mitigationTrafficObservation: { findMany: async () => [{ ...row(2), quality }, row(1)] },
      }),
  };
  return new PrismaFastBridgeReader(operational as never, observation as never, health);
}

describe('health/database publication race', () => {
  it('rechecks health once when the collector committed a newer sample between the two reads', async () => {
    const health = vi.fn().mockResolvedValueOnce(proof(1)).mockResolvedValue(proof(2));
    expect((await reader(health).snapshot('i', 'p')).collectorAvailable).toBe(true);
    expect(health).toHaveBeenCalledTimes(2);
  });
  it('makes one health call when both timestamps already agree', async () => {
    const health = vi.fn().mockResolvedValue(proof(2));
    expect((await reader(health).snapshot('i', 'p')).collectorAvailable).toBe(true);
    expect(health).toHaveBeenCalledTimes(1);
  });
  it('never retries away an unhealthy collector or an invalid newest row', async () => {
    const unhealthy = vi.fn().mockResolvedValue(proof(1, false));
    expect((await reader(unhealthy).snapshot('i', 'p')).collectorAvailable).toBe(false);
    expect(unhealthy).toHaveBeenCalledTimes(1);
    const invalid = vi.fn().mockResolvedValue(proof(1));
    expect((await reader(invalid, 'BASELINE').snapshot('i', 'p')).collectorAvailable).toBe(false);
    expect(invalid).toHaveBeenCalledTimes(1);
  });
  it('remains fail-closed if the bounded recheck disagrees or reports failure', async () => {
    for (const next of [proof(1), proof(2, false), proof(3)]) {
      const health = vi.fn().mockResolvedValueOnce(proof(1)).mockResolvedValue(next);
      expect((await reader(health).snapshot('i', 'p')).collectorAvailable).toBe(false);
      expect(health).toHaveBeenCalledTimes(2);
    }
  });
});

describe('sample arrives during an asynchronous FAST read', () => {
  it.each([false, true])('uses the clock after the read; dual=%s', async (dual) => {
    let now = epoch;
    const commands = vi.fn(async () => ({
      ok: true,
      status: 'ACTIVATED_VERIFIED',
      verified: true,
    }));
    const read = async (): Promise<MitigationTrafficSample> => {
      const collected = now + 20;
      await Promise.resolve();
      now += 80;
      return {
        bps: 9_500_000_000n,
        occurredAt: new Date(collected),
        rateStartAt: new Date(collected - 10000),
        sampleKey: String(collected),
        continuityKey: 'g:tx',
      };
    };
    const engine = new MitigationAutoEngine({
      sampling: { maxAgeMs: 30000, maxGapMs: 45000 },
      globalMode: 'AUTO',
      execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: ['ne8000'] },
      targets: { list: async () => [defaultTarget()] },
      traffic: {
        sample: async () => null,
        sampleWithId: read,
        sampleDirectionsWithId: async () => {
          const s = await read();
          return { sampleKey: s.sampleKey, occurredAt: s.occurredAt, rx: { ...s, bps: 0n }, tx: s };
        },
      },
      runtime: {
        get: async () => ({ state: 'NORMAL', triggerCounter: 0, recoveryCounter: 0 }),
        save: async () => undefined,
      },
      exclusions: { listPeerExclusions: async () => [] },
      commands: { execute: commands },
      dualDirections: { enabled: dual },
      now: () => new Date(now),
    });
    for (let n = 0; n < 3; n++) {
      const [d] = await engine.tick();
      expect(d!.samplesOver).toBe(n + 1);
      expect(Date.parse(d!.at)).toBe(now);
      expect(d!.confirmationMs ?? 0).toBeGreaterThanOrEqual(0);
      now += 10000;
    }
    expect(commands).toHaveBeenCalledTimes(1);
  });
  it('still rejects a sample that is in the future after the read', async () => {
    const commands = vi.fn();
    const engine = new MitigationAutoEngine({
      sampling: { maxAgeMs: 30000, maxGapMs: 45000 },
      globalMode: 'AUTO',
      execution: { executor: 'HUAWEI', liveWrite: true, allowedDeviceIds: ['ne8000'] },
      targets: { list: async () => [defaultTarget()] },
      traffic: {
        sample: async () => null,
        sampleWithId: async () => ({
          bps: 9_500_000_000n,
          occurredAt: new Date(epoch + 1),
          sampleKey: 'future',
        }),
      },
      runtime: {
        get: async () => ({ state: 'NORMAL', triggerCounter: 0, recoveryCounter: 0 }),
        save: async () => undefined,
      },
      exclusions: { listPeerExclusions: async () => [] },
      commands: { execute: commands },
      now: () => new Date(epoch),
    });
    expect((await engine.tick())[0]!.reason).toBe('TELEMETRY_UNAVAILABLE');
    expect(commands).not.toHaveBeenCalled();
  });
});
