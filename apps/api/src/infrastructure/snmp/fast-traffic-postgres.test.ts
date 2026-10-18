import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { PrismaFastTrafficStore } from './prisma-fast-traffic-store';
import { PrismaInterfaceTrafficReader } from '../bgp/mitigation/prisma-interface-traffic-reader';
import type { FastTrafficObservation } from './fast-traffic-types';

const url = process.env.FAST_TEST_DATABASE_URL;
// Refuse EVERY operational/remote database even if someone misconfigures the test.
if (url) {
  const parsed = new URL(url);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55439' ||
    parsed.pathname !== '/netvision_ddos_fast_test'
  ) {
    throw new Error('Only the disposable loopback fast-response test database is allowed');
  }
}
describe.skipIf(!url)('priority persistence, real isolated PostgreSQL', () => {
  const db = new PrismaClient({
    datasources: {
      db: { url: url ?? 'postgresql://unused@127.0.0.1:55439/netvision_ddos_fast_test' },
    },
  });
  const store = new PrismaFastTrafficStore(db);
  const deviceId = 'fast-integration-device';
  const interfaceId = 'fast-integration-interface';
  const observation = (n: number): FastTrafficObservation => ({
    id: `fast-integration-${n}`,
    generation: 'integration',
    deviceId,
    interfaceId,
    ifIndex: 200,
    interfaceName: 'Eth-Trunk1.3043',
    requestStartedAt: new Date(10000 * n),
    collectedAt: new Date(10000 * n),
    previousCollectedAt: new Date(10000 * (n - 1)),
    intervalMs: 10000,
    inOctets: 18446744073709551615n,
    outOctets: 17485954741261n,
    uptimeTicks: BigInt(10000 + n * 1000),
    discontinuityTicks: 0n,
    lastChangeTicks: 0n,
    adminStatus: 1,
    operStatus: 1,
    speedBps: 300_000_000_000n,
    rxBps: 10,
    txBps: 156e9,
    quality: 'VALID',
  });

  beforeAll(async () => {
    await db.mitigationTrafficObservation.deleteMany({ where: { interfaceId } });
    await db.device.upsert({
      where: { id: deviceId },
      update: {},
      create: {
        id: deviceId,
        name: 'Synthetic',
        displayName: 'Synthetic',
        hostname: 'synthetic-isolated',
        ip: '127.0.0.1',
        managementIp: '127.0.0.1',
        deviceType: 'ROUTER',
        source: 'SNMP',
      },
    });
    await db.interface.upsert({
      where: { id: interfaceId },
      update: { ifIndex: 200 },
      create: {
        id: interfaceId,
        deviceId,
        name: 'Eth-Trunk1.3043',
        ifIndex: 200,
        speedBps: 300_000_000_000n,
        adminStatus: 'UP',
        operStatus: 'UP',
      },
    });
  });
  afterAll(async () => {
    await db.mitigationTrafficObservation.deleteMany({ where: { interfaceId } });
    await db.device.delete({ where: { id: deviceId } });
    await db.$disconnect();
  });

  it('duplicate simultaneous commits persist exactly one immutable observation', async () => {
    const results = await Promise.all([store.append(observation(1)), store.append(observation(1))]);
    expect(results.sort()).toEqual([false, true]);
    expect((await store.latest(interfaceId))?.inOctets).toBe(18446744073709551615n);
  });
  it('out-of-order commit cannot regress the latest observation', async () => {
    expect(await store.append(observation(3))).toBe(true);
    expect(await store.append(observation(2))).toBe(false);
    expect((await store.latest(interfaceId))?.id).toBe('fast-integration-3');
  });
  it('invalid latest observation is visible; no fallback to a high valid row', async () => {
    await store.append({
      ...observation(4),
      quality: 'ADMIN_DOWN',
      adminStatus: 2,
      rxBps: null,
      txBps: null,
    });
    expect((await store.latest(interfaceId))?.quality).toBe('ADMIN_DOWN');
  });
  it('general polling persistence cannot change priority rate or baseline', async () => {
    await Promise.all([
      db.interfaceMetricSample.create({
        data: {
          interfaceId,
          timestamp: new Date(50000),
          inOctets: 1n,
          outOctets: 2n,
          rxBps: 0,
          txBps: 0,
          operStatus: 'UP',
        },
      }),
      store.append(observation(5)),
    ]);
    expect((await store.latest(interfaceId))?.txBps).toBe(156e9);
    expect((await db.interfaceMetricSample.findFirst({ where: { interfaceId } }))?.outOctets).toBe(
      2n,
    );
  });
  it('legacy reader returns latest invalid row atomically instead of stale high rate', async () => {
    await db.interfaceMetricSample.create({
      data: {
        interfaceId,
        timestamp: new Date(60000),
        inOctets: 3n,
        outOctets: 4n,
        rxBps: -1,
        txBps: -1,
        operStatus: 'DOWN',
      },
    });
    const latest = await new PrismaInterfaceTrafficReader(db).latestTraffic(interfaceId);
    expect(latest?.txBps).toBe(-1);
    expect(latest?.usable).toBe(false);
    expect(latest?.operStatus).toBe('DOWN');
    expect(latest?.rateStartAt).toEqual(new Date(50000));
  });
  it('ifIndex mapping change prevents both reading and committing obsolete observations', async () => {
    await db.interface.update({ where: { id: interfaceId }, data: { ifIndex: 201 } });
    expect(await store.latest(interfaceId)).toBeNull();
    expect(await store.append(observation(6))).toBe(false);
  });
});
