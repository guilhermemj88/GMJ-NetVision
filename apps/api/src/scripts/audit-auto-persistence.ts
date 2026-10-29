/** Explicit integration test; refuses every database except a disposable local DB. */
import assert from 'node:assert/strict';
import { PrismaClient } from '../generated/prisma/index.js';
import { PrismaAutomationStore } from '../worker/mitigation/automation-store';
import {
  DurableMitigationOutbox,
  type OutboxEntry,
} from '../worker/mitigation/durable-mitigation-outbox';
import type { MitigationNotification } from '../infrastructure/bgp/mitigation/notification-publisher';
import type { MitigationActionResult } from '../infrastructure/bgp/mitigation/mitigation-command-service';
import {
  AutoMitigationLifecycle,
  lifecycleConfig,
  scopeKey,
  type ScopeOwnership,
  type JournalCommand,
} from '../worker/mitigation/auto-lifecycle';

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
    // Exercise manual ownership release and durable idempotency on real JSONB,
    // without any executor or network transport. This is not physical readback.
    const now = Date.parse('2026-10-29T16:00:00Z'),
      key = scopeKey({ deviceId: 'offline-device', policyName: 'PL-FAKE' });
    const makeLifecycle = () =>
      new AutoMitigationLifecycle({
        store: restartedStore,
        config: () => ({ ...lifecycleConfig({}), cooldownMs: 60000 }),
        target: async () => null,
        execute: async () => {
          throw Error('No transport authorized');
        },
        physical: async () => {
          throw Error('No device authorized');
        },
        now: () => now,
      });
    const ownership: ScopeOwnership = {
      key,
      profileId: 'offline',
      owner: 'auto-owner',
      revision: 'offline',
      phase: 'ACTIVE',
      target: {
        deviceId: 'offline-device',
        policy: 'PL-FAKE',
        family: 'IPV4',
        rt: '1:1',
        bogon: 1,
        mitigation: 2,
      },
      activatedAt: now - 60000,
      cooldownUntil: 0,
      lastSample: null,
      operationId: 'old-activate',
      reason: null,
    };
    await restartedStore.transaction((tx) => tx.put(key, 'scope', 'ACTIVE', ownership));
    const input = {
      requestId: 'manual-offline-db',
      profileId: 'offline',
      action: 'REMOVE' as const,
    };
    const result: MitigationActionResult = {
      requestId: input.requestId,
      action: 'REMOVE',
      profileId: input.profileId,
      ok: true,
      status: 'REMOVED_VERIFIED',
      verified: true,
      customer: 'OFFLINE',
      device: 'offline-device',
      interface: 'Eth-Trunk1.100',
      interfaceId: 'offline-interface',
      addressFamily: 'IPV4',
      policy: 'PL-FAKE',
      node: 2,
      bogonNode: 1,
      mitigationNode: 2,
      rt: '1:1',
      sharedPolicy: false,
      sharedPolicyTargets: [],
      affectedPeers: ['192.0.2.1'],
      executedAt: new Date(now).toISOString(),
      idempotent: false,
      commandPreview: [],
      verification: { command: 'fake only', summary: 'test adapter; no physical verification' },
    };
    let lifecycle = makeLifecycle();
    await lifecycle.beginManual(input, 'offline-device', 'PL-FAKE');
    assert.equal(await lifecycle.authorizeManual(input), true);
    await lifecycle.completeManual(input, result, true);
    const released = await restartedStore.transaction((tx) => tx.get<ScopeOwnership>(key));
    assert.equal(released?.phase, 'COOLDOWN');
    assert.equal(released?.owner, 'released:' + input.requestId);
    assert.equal(released?.cooldownUntil, now + 60000);
    lifecycle = makeLifecycle();
    assert.equal(
      (await lifecycle.beginManual(input, 'offline-device', 'PL-FAKE'))?.idempotent,
      true,
    );
    assert.equal(
      (await restartedStore.transaction((tx) => tx.get<ScopeOwnership>(key)))?.cooldownUntil,
      now + 60000,
    );
    assert.equal(
      (await restartedStore.transaction((tx) => tx.list<JournalCommand>('command'))).filter(
        (j) => j.origin === 'MANUAL' && j.state === 'VERIFIED',
      ).length,
      1,
    );
    const interrupted = { ...input, requestId: 'interrupted-manual-db' };
    await lifecycle.beginManual(interrupted, 'offline-device', 'PL-FAKE');
    await lifecycle.authorizeManual(interrupted);
    lifecycle = makeLifecycle();
    await assert.rejects(
      lifecycle.beginManual(interrupted, 'offline-device', 'PL-FAKE'),
      /RECONCILIATION_REQUIRED/,
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
          manualOwnershipRelease: true,
          manualReceiptAfterRestart: true,
          interruptedManualNotReplayed: true,
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
