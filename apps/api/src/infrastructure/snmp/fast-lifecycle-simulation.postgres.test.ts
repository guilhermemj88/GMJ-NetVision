import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { PrismaObserverTrafficStore } from './prisma-observer-traffic-store';
import { fastLifecycleScenario } from '../../testing/fast-lifecycle-scenario';
import { SINGLE_AUTO_PILOT as P } from '../../worker/mitigation/single-pilot-trigger';

const url = process.env.FAST_TEST_DATABASE_URL;
if (url) {
  const p = new URL(url);
  if (
    p.hostname !== '127.0.0.1' ||
    p.port !== '55439' ||
    p.pathname !== '/netvision_ddos_fast_test'
  )
    throw Error('DISPOSABLE_FAST_DATABASE_REQUIRED');
}
describe.skipIf(!url)(
  'F3: actual PostgreSQL observation persistence before lifecycle confirmation',
  () => {
    const db = new PrismaClient({ datasourceUrl: url ?? 'postgresql://invalid/unused' });
    const store = new PrismaObserverTrafficStore(db);
    beforeEach(async () => {
      await db.mitigationTrafficObservation.deleteMany({
        where: { interfaceId: P.interfaceId, deviceId: P.deviceId },
      });
    });
    afterAll(async () => {
      await db.$disconnect();
    });
    it('durably stores Counter64 observations used by the actual source/lifecycle', async () => {
      const result = await fastLifecycleScenario({
        cadenceSeconds: 10,
        seed: 1234,
        observationStore: store,
      });
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]!.result.verified).toBe(true);
      expect(
        await db.mitigationTrafficObservation.count({ where: { interfaceId: P.interfaceId } }),
      ).toBe(result.observations.length);
      const first = result.observations[0]!;
      const persisted = await db.mitigationTrafficObservation.findUniqueOrThrow({
        where: { id: first.id },
      });
      expect(persisted.outOctets.toString()).toBe(first.outOctets.toString());
    });
    it('an append outage invalidates the sequence; only a new baseline and three committed deltas can activate', async () => {
      let calls = 0;
      let failedAt = 0;
      const result = await fastLifecycleScenario({
        cadenceSeconds: 10,
        seed: 1234,
        observationStore: {
          latest: (id) => store.latest(id),
          append: async (o) => {
            if (++calls === 3) {
              failedAt = +o.collectedAt;
              throw Error('injected observation database outage');
            }
            return store.append(o);
          },
        },
      });
      expect(result.commands).toHaveLength(1);
      const afterFailure = result.observations.filter((o) => +o.collectedAt > failedAt);
      expect(afterFailure[0]!.quality).toBe('BASELINE');
      const command = result.commands[0]!;
      const start = Date.parse(command.input.autoEvidence!.sequenceStartedAt!),
        last = Date.parse(command.input.autoEvidence!.sampleAt);
      expect(start).toBeGreaterThan(+afterFailure[0]!.collectedAt);
      const samples = afterFailure.filter((o) => +o.collectedAt >= start && +o.collectedAt <= last);
      expect(samples).toHaveLength(3);
      expect(samples.every((o) => o.quality === 'VALID')).toBe(true);
      const persisted = await db.mitigationTrafficObservation.findMany({
        where: { id: { in: samples.map((s) => s.id) } },
      });
      expect(persisted).toHaveLength(3);
      expect(result.pollerStatus.failures).toBe(1);
    });
  },
);
