import { expect, it } from 'vitest';
import { MemoryAutomationStore } from './automation-store';
import { DurableMitigationOutbox, type OutboxEntry } from './durable-mitigation-outbox';
import type { MitigationNotification } from '../../infrastructure/bgp/mitigation/notification-publisher';

// Only the injected clock of this in-memory unit test advances. No global clock,
// real PostgreSQL, application process, HTTP endpoint or persisted timestamp is edited.
const notice = (eventId: string): MitigationNotification => ({
  event: 'MITIGATION_DETECTION_BLOCKED',
  eventId,
  profileId: 'isolated-clock-only',
  simulation: true,
  verified: false,
  customer: 'SYNTHETIC',
  device: 'SYNTHETIC',
  interfaceName: null,
  peer: null,
  affectedPeers: [],
  detectedBandwidthBps: null,
  bandwidthOverrideBps: null,
  effectiveBandwidthBps: 1000000000n,
  trafficBps: 980000000n,
  thresholdBps: 950000000n,
  policy: 'SYNTHETIC',
  node: null,
  rt: null,
});
const T = Date.parse('2026-11-05T12:00:00Z');

it('default 30-minute delivery limit blocks at deadline minus 1 ms and permits exactly at deadline after restart', async () => {
  const store = new MemoryAutomationStore();
  let now = T;
  let calls = 0;
  const transport = {
    publish: async () => {
      calls++;
      return { published: true, skipped: false };
    },
  };
  let q = new DurableMitigationOutbox(store, transport, () => now);
  await q.publish(notice('first'));
  await q.drain();
  await q.publish(notice('second'));
  await q.drain();
  expect(calls).toBe(1);
  q = new DurableMitigationOutbox(store, transport, () => now);
  now = T + 30 * 60000 - 1;
  expect(await q.drain()).toBe(0);
  expect(calls).toBe(1);
  now = T + 30 * 60000;
  expect(await q.drain()).toBe(1);
  expect(calls).toBe(2);
  await q.publish(notice('second'));
  await q.drain();
  expect(calls).toBe(2);
});

it('30-second and 60-second retry boundaries preserve payload and require a positive ACK', async () => {
  const store = new MemoryAutomationStore();
  let now = T;
  const seen: Array<{ at: number; payload: string }> = [];
  const q = new DurableMitigationOutbox(
    store,
    {
      publish: async (n) => {
        seen.push({
          at: now,
          payload: JSON.stringify(n, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
        });
        return { published: seen.length === 3, skipped: false };
      },
    },
    () => now,
  );
  await q.publish(notice('retry'));
  await q.drain();
  now = T + 29999;
  expect(await q.drain()).toBe(0);
  now = T + 30000;
  expect(await q.drain()).toBe(1);
  now = T + 89999;
  expect(await q.drain()).toBe(0);
  now = T + 90000;
  expect(await q.drain()).toBe(1);
  expect(seen.map((s) => s.at)).toEqual([T, T + 30000, T + 90000]);
  expect(new Set(seen.map((s) => s.payload)).size).toBe(1);
  expect((await store.transaction((tx) => tx.list<OutboxEntry>('outbox')))[0]!.state).toBe('SENT');
});

it('exponential retry delay caps at ten minutes without permitting early retries', async () => {
  const store = new MemoryAutomationStore();
  let now = T;
  const q = new DurableMitigationOutbox(
    store,
    { publish: async () => ({ published: false, skipped: false }) },
    () => now,
  );
  await q.publish(notice('cap'));
  for (const delay of [30000, 60000, 120000, 240000, 480000, 600000, 600000]) {
    expect(await q.drain()).toBe(1);
    const row = (await store.transaction((tx) => tx.list<OutboxEntry>('outbox')))[0]!;
    expect(row.nextAt).toBe(now + delay);
    now = row.nextAt - 1;
    expect(await q.drain()).toBe(0);
    now++;
  }
});
