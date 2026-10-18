import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { PrismaObserverTrafficStore } from '../../infrastructure/snmp/prisma-observer-traffic-store';
import { PrismaFastBridgeReader } from '../../infrastructure/snmp/prisma-fast-bridge-reader';
import { PrismaMitigationRepository } from '../../infrastructure/bgp/mitigation/prisma-mitigation-repository';
import { PrismaPolicyScopeLock } from '../../infrastructure/bgp/mitigation/prisma-policy-scope-lock';
import {
  PrismaFastShadowRuntime,
  recordFastBridgeDecisions,
} from '../../infrastructure/bgp/mitigation/prisma-fast-shadow-runtime';
import { fastResponseScenario } from '../../testing/fast-response-scenario';

const url = process.env.TELEMETRY_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55439' ||
    parsed.pathname !== '/netvision_ddos_telemetry_test'
  )
    throw Error('Disposable loopback bridge database required');
}
describe.skipIf(!url)(
  'real PostgreSQL databases, canonical command service, synthetic Huawei',
  () => {
    const db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://invalid' } } });
    const observationUrl = new URL(
      url ?? 'postgresql://unused@127.0.0.1:55439/netvision_ddos_telemetry_test',
    );
    observationUrl.pathname = '/netvision_ddos_observe_test';
    const obs = new PrismaClient({ datasources: { db: { url: observationUrl.toString() } } });
    const readerUrl = new URL(observationUrl);
    readerUrl.username = 'fast_bridge_test_reader';
    readerUrl.password = 'isolated_bridge_reader';
    const ro = new PrismaClient({ datasources: { db: { url: readerUrl.toString() } } });
    const repository = new PrismaMitigationRepository(db);
    beforeAll(async () => {
      await obs.$executeRawUnsafe(
        `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='fast_bridge_test_reader') THEN CREATE ROLE fast_bridge_test_reader LOGIN PASSWORD 'isolated_bridge_reader'; END IF; END $$`,
      );
      await obs.$executeRawUnsafe(
        'GRANT CONNECT ON DATABASE netvision_ddos_observe_test TO fast_bridge_test_reader',
      );
      await obs.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO fast_bridge_test_reader');
      await obs.$executeRawUnsafe(
        'GRANT SELECT ON "MitigationTrafficObservation" TO fast_bridge_test_reader',
      );
      await obs.$executeRawUnsafe(
        'ALTER ROLE fast_bridge_test_reader IN DATABASE netvision_ddos_observe_test SET default_transaction_read_only=on',
      );
    });
    afterEach(() => vi.useRealTimers());
    afterAll(async () => {
      await db.device.deleteMany({ where: { id: { startsWith: 'synthetic-device-' } } });
      await obs.mitigationTrafficObservation.deleteMany({
        where: { interfaceId: { startsWith: 'synthetic-if-' } },
      });
      await db.mitigationFastDecision.deleteMany({
        where: { profileId: { startsWith: 'bridge-test-' } },
      });
      await db.mitigationFastShadowState.deleteMany({
        where: { profileId: { startsWith: 'bridge-test-' } },
      });
      await Promise.all([db.$disconnect(), obs.$disconnect(), ro.$disconnect()]);
    });
    it('consumes separate read-only observations, persists one activation and audit, preserves general stream', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const start = Date.parse('2026-10-18T13:00:00Z');
      vi.setSystemTime(start);
      const reader = new PrismaFastBridgeReader(db, ro, async () => ({
        observationOnly: true,
        executionAvailable: false,
        healthy: true,
        running: true,
        mode: 'OBSERVE',
        entries: h.poller.status().entries,
      }));
      const h = await fastResponseScenario({
        startAt: start,
        attackAt: start,
        externalBridge: true,
        repository,
        observationStore: new PrismaObserverTrafficStore(obs),
        bridgeReader: reader,
        scopeLock: new PrismaPolicyScopeLock(db),
        preflightMs: 3,
        executionMs: 4,
        readbackMs: 2,
        beforeProfiles: async (hosts, interfaces) => {
          await db.device.deleteMany({ where: { id: { startsWith: 'synthetic-device-' } } });
          await obs.mitigationTrafficObservation.deleteMany({
            where: { interfaceId: { startsWith: 'synthetic-if-' } },
          });
          await db.device.createMany({
            data: hosts.map((h) => ({
              id: h.id,
              name: h.name,
              displayName: h.displayName,
              hostname: h.hostname,
              ip: '127.0.0.1',
              managementIp: '127.0.0.1',
              source: 'SNMP',
              deviceType: 'ROUTER',
            })),
          });
          await db.interface.createMany({
            data: interfaces.map((i) => ({
              id: i.id,
              deviceId: i.deviceId,
              name: i.name,
              ifIndex: i.ifIndex,
              speedBps: BigInt(i.speedBps!),
              adminStatus: 'UP',
              operStatus: 'UP',
            })),
          });
        },
      });
      try {
        const id = h.profiles[0]!.id;
        for (const t of [0, 20000, 30000, 40000]) {
          vi.setSystemTime(start + t);
          await h.poller.runDue();
          await h.poller.drain();
          await h.engine.tick();
        }
        const activation = h.decisions.filter((d) => d.outcome === 'ACTIVATED');
        expect(activation).toHaveLength(1);
        expect((await repository.getRuntime(id))?.state).toBe('MITIGATED');
        expect(
          (await repository.listEvents(id, 20)).filter((e) => e.type === 'ACTIVATE' && e.verified),
        ).toHaveLength(1);
        const row = await obs.mitigationTrafficObservation.findFirstOrThrow({
          orderBy: { collectedAt: 'desc' },
          where: { interfaceId: h.profiles[0]!.interfaceId! },
        });
        await expect(
          ro.mitigationTrafficObservation.delete({ where: { id: row.id } }),
        ).rejects.toThrow();
        const source = h.bridgeTraffic.status()[0]!;
        expect(source.available).toBe(true);
        expect(source.rxBps).toBe('0');
        const decision = {
          ...h.decisions.find((d) => d.outcome === 'ACTIVATED')!,
          profileId: 'bridge-test-audit',
        };
        const original = h.bridgeTraffic.status.bind(h.bridgeTraffic);
        h.bridgeTraffic.status = () =>
          original().map((e) => ({ ...e, profileId: 'bridge-test-audit' }));
        await recordFastBridgeDecisions(db, 'ENFORCE', [decision, decision], h.bridgeTraffic);
        expect(
          await db.mitigationFastDecision.count({ where: { profileId: 'bridge-test-audit' } }),
        ).toBe(1);
        h.bridgeTraffic.status = original;
        await db.interfaceMetricSample.create({
          data: {
            interfaceId: h.profiles[0]!.interfaceId!,
            rxBps: 1,
            txBps: 2,
            inOctets: 1n,
            outOctets: 2n,
            operStatus: 'UP',
          },
        });
        expect(
          (await reader.snapshot(h.profiles[0]!.interfaceId!, id)).current?.txBps,
        ).toBeGreaterThan(9_000_000_000);
        await db.interface.update({
          where: { id: h.profiles[0]!.interfaceId! },
          data: { ifIndex: 9999 },
        });
        expect(
          await h.bridgeTraffic.sampleWithId({
            profileId: id,
            deviceId: h.profiles[0]!.deviceId,
            interfaceId: h.profiles[0]!.interfaceId,
            bandwidthBps: 10_000_000_000n,
          }),
        ).toBeNull();
      } finally {
        await h.stop();
      }
    }, 15000);
    it('cross-process policy/global-tick locks exclude a second writer and release on failure', async () => {
      const first = new PrismaPolicyScopeLock(db),
        second = new PrismaPolicyScopeLock(db);
      const scope = { deviceId: 'bridge-test', policyName: 'shared' };
      let release!: () => void, entered!: () => void;
      const ready = new Promise<void>((r) => {
        entered = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const held = first.run(scope, async () => {
        entered();
        await gate;
      });
      await ready;
      await expect(
        second.run(scope, async () => {
          throw Error('must not enter');
        }),
      ).rejects.toThrow('ocupada');
      await expect(second.run({ ...scope, deviceId: 'other' }, async () => 'ok')).resolves.toBe(
        'ok',
      );
      release();
      await held;
      await expect(
        first.run(scope, async () => {
          throw Error('synthetic');
        }),
      ).rejects.toThrow('synthetic');
      await expect(second.run(scope, async () => 'released')).resolves.toBe('released');
    });
    it('shadow counters persist separately and cannot overwrite operational mitigation state', async () => {
      const runtime = new PrismaFastShadowRuntime(db, {
        getRuntime: async () => ({ state: 'MITIGATED' }) as never,
      });
      await runtime.save('bridge-test-shadow', {
        triggerCounter: 2,
        lastSampleAt: new Date(),
        state: 'TRIGGER_PENDING',
      });
      expect(await runtime.get('bridge-test-shadow')).toMatchObject({
        state: 'MITIGATED',
        triggerCounter: 2,
      });
      expect(
        await db.bgpMitigationRuntime.count({ where: { profileId: 'bridge-test-shadow' } }),
      ).toBe(0);
    });
    it.each(['operational', 'observational'] as const)(
      '%s database connection failure cannot produce a source sample',
      async (kind) => {
        const badUrl = new URL(url!);
        badUrl.port = '1';
        badUrl.searchParams.set('connect_timeout', '1');
        badUrl.searchParams.set('pool_timeout', '1');
        const bad = new PrismaClient({ datasources: { db: { url: badUrl.toString() } } });
        try {
          const reader = new PrismaFastBridgeReader(
            kind === 'operational' ? bad : db,
            kind === 'observational' ? bad : ro,
            async () => ({
              observationOnly: true,
              mode: 'OBSERVE',
              executionAvailable: false,
              healthy: true,
              running: true,
              entries: [],
            }),
          );
          await expect(reader.snapshot('synthetic-if-0', 'unavailable-profile')).rejects.toThrow();
        } finally {
          await bad.$disconnect();
        }
      },
    );
    it('rejects a read-write observation connection rather than silently trusting credentials', async () => {
      const reader = new PrismaFastBridgeReader(db, obs, async () => ({ entries: [] }));
      await expect(reader.snapshot('synthetic-if-0', 'p')).rejects.toThrow('read-only role');
    });
  },
);
