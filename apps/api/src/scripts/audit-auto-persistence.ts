/** Explicit integration test; refuses every database except a disposable local DB. */
import assert from 'node:assert/strict';
import { PrismaClient } from '../generated/prisma/index.js';
import { PrismaAutomationStore } from '../worker/mitigation/automation-store';
import {
  DurableMitigationOutbox,
  type OutboxEntry,
} from '../worker/mitigation/durable-mitigation-outbox';
import type { MitigationNotification } from '../infrastructure/bgp/mitigation/notification-publisher';

const url = new URL(process.env.DATABASE_URL ?? '');
assert.equal(url.hostname, '127.0.0.1');
assert.equal(url.port, '55439');
assert.equal(url.pathname, '/netvision_auto_isolated');
const client = new PrismaClient();
try {
  await client.mitigationAutomationRecord.deleteMany(); // disposable DB guarded above
  const store = new PrismaAutomationStore(client);
  await store.transaction(async (tx) => {
    assert.equal(await tx.get('roundtrip'), null);
    await tx.put('roundtrip', 'audit', 'PENDING', { count: 0 });
  });
  await Promise.all(
    Array.from({ length: 20 }, () =>
      store.transaction(async (tx) => {
        const p = (await tx.get<{ count: number }>('roundtrip'))!;
        await tx.put('roundtrip', 'audit', 'PENDING', { count: p.count + 1 });
      }),
    ),
  );
  assert.equal(
    (await store.transaction((tx) => tx.get<{ count: number }>('roundtrip')))?.count,
    20,
  );
  await assert.rejects(
    store.transaction(async (tx) => {
      await tx.put('must-rollback', 'audit', 'ACTIVE', { id: 1 });
      throw Error('simulated transaction failure');
    }),
  );
  assert.equal(await store.transaction((tx) => tx.get('must-rollback')), null);
  const n: MitigationNotification = {
    event: 'MITIGATION_REMOVED_VERIFIED',
    eventId: 'persisted-remove',
    profileId: 'isolated',
    simulation: false,
    verified: true,
    customer: 'OFFLINE',
    device: 'FAKE',
    interfaceName: null,
    peer: null,
    affectedPeers: [],
    detectedBandwidthBps: null,
    bandwidthOverrideBps: null,
    effectiveBandwidthBps: 10_000_000_000n,
    trafficBps: null,
    thresholdBps: null,
    policy: 'FAKE',
    node: 2,
    rt: '1:1',
  };
  await new DurableMitigationOutbox(store, {
    publish: async () => {
      throw Error('not called');
    },
  }).publish(n);
  await client.$disconnect();
  const restartedClient = new PrismaClient();
  try {
    const restartedStore = new PrismaAutomationStore(restartedClient);
    let deliveries = 0;
    const sender = {
      publish: async (notification: MitigationNotification) => {
        assert.equal(notification.eventId, n.eventId);
        assert.equal(notification.effectiveBandwidthBps, n.effectiveBandwidthBps);
        deliveries++;
        return { published: true, skipped: false };
      },
    };
    await Promise.all([
      new DurableMitigationOutbox(restartedStore, sender).drain(),
      new DurableMitigationOutbox(restartedStore, sender).drain(),
    ]);
    assert.equal(deliveries, 1);
    assert.equal(
      (await restartedStore.transaction((tx) => tx.list<OutboxEntry>('outbox')))[0]?.state,
      'SENT',
    );
    console.log(
      JSON.stringify(
        {
          database: 'disposable local PostgreSQL16',
          concurrentTransactions: 20,
          rollback: true,
          clientRestart: true,
          outboxLease: true,
          bigintRoundtrip: true,
          deliveries,
        },
        null,
        2,
      ),
    );
  } finally {
    await restartedClient.$disconnect();
  }
} finally {
  await client.$disconnect();
}
