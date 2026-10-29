/** Run only inside the disposable internal-network n8n container. No Telegram credentials. */
import assert from 'node:assert/strict';
import {
  N8nMediaTransport,
  createFetchWebhookSender,
} from '../infrastructure/media/n8n-media-transport';
import {
  DurableMitigationOutbox,
  type OutboxEntry,
} from '../worker/mitigation/durable-mitigation-outbox';
import { MemoryAutomationStore } from '../worker/mitigation/automation-store';
import type { MitigationNotification } from '../infrastructure/bgp/mitigation/notification-publisher';

async function main() {
  assert.equal(process.env.AUTO_DDOS_ISOLATED_TEST, '1');
  let now = Date.now(),
    wrongAuth = true;
  const receipts: Array<{ event: string; status: number; delivered: boolean }> = [];
  const sender = createFetchWebhookSender({ timeoutMs: 5000 });
  const transport = new N8nMediaTransport({
    requireAcknowledgement: true,
    media: {
      resolveOutbound: async () => ({
        enabled: true,
        url: 'http://127.0.0.1:5678/webhook/netvision-mitigation',
        token: 'auto-ddos-isolated-header',
        integrationId: 'isolated',
        source: 'DATABASE',
      }),
      recordOutboundAttempt: async () => {},
      recordOutboundDelivery: async (r) => {
        receipts.push({ event: r.event, status: r.httpStatus ?? 0, delivered: r.ok });
      },
    },
    send: (u, p, h) =>
      sender(u, p, {
        ...h,
        ...(wrongAuth ? { 'X-NetVision-Token': 'wrong-isolated-header' } : {}),
      }),
  });
  const store = new MemoryAutomationStore();
  let queue = new DurableMitigationOutbox(store, transport, () => now);
  const n: MitigationNotification = {
    event: 'MITIGATION_VERIFIED',
    eventId: 'auto-activate-isolated',
    profileId: 'offline',
    addressFamily: 'IPV4',
    simulation: false,
    verified: true,
    customer: 'OFFLINE - FAKE TRANSPORT',
    device: 'FAKE HUAWEI',
    interfaceName: 'FAKE',
    peer: '192.0.2.1',
    affectedPeers: ['192.0.2.1'],
    detectedBandwidthBps: null,
    bandwidthOverrideBps: null,
    effectiveBandwidthBps: 10_000_000_000n,
    trafficBps: null,
    thresholdBps: null,
    policy: 'PL-FAKE',
    node: 2,
    bogonNode: 1,
    mitigationNode: 2,
    rt: '1:1',
  };
  await queue.publish(n);
  await queue.drain();
  assert.equal(receipts[0]?.status, 403);
  assert.equal(receipts[0]?.delivered, false);
  wrongAuth = false;
  now += 30000;
  queue = new DurableMitigationOutbox(store, transport, () => now);
  await queue.drain();
  assert.equal(receipts.at(-1)?.delivered, true);
  await queue.publish({
    ...n,
    event: 'MITIGATION_REMOVED_VERIFIED',
    eventId: 'manual-remove-isolated',
  });
  await queue.drain();
  assert.equal(receipts.at(-1)?.delivered, true);
  await queue.publish({
    ...n,
    event: 'MITIGATION_FAILED',
    eventId: 'auto-failed-isolated',
    verified: false,
  });
  await queue.drain();
  assert.equal(receipts.at(-1)?.delivered, true);
  await queue.publish({
    ...n,
    event: 'MITIGATION_DETECTION_BLOCKED',
    eventId: 'auto-detection-isolated',
    episodeId: 'stable-episode',
    simulation: true,
    verified: false,
    trafficBps: 9_500_000_000n,
    thresholdBps: 9_000_000_000n,
    direction: 'tx',
    blockedReason: 'AUTO_EXECUTION_DISABLED',
  });
  await queue.drain();
  assert.equal(receipts.at(-1)?.delivered, true);
  // A fabricated unverified removal must never route or obtain a delivery ACK.
  await queue.publish({
    ...n,
    event: 'MITIGATION_REMOVED_VERIFIED',
    eventId: 'invalid-remove',
    verified: false,
  });
  await queue.drain();
  assert.equal(receipts.at(-1)?.delivered, false);
  await queue.publish({
    ...n,
    event: 'MITIGATION_REMOVED_VERIFIED',
    eventId: 'failed-telegram',
    customer: 'HTTP_FAIL',
  });
  await queue.drain();
  assert.equal(receipts.at(-1)?.status, 500);
  assert.equal(receipts.at(-1)?.delivered, false);
  const entries = await store.transaction((tx) => tx.list<OutboxEntry>('outbox'));
  assert.equal(entries.filter((e) => e.state === 'SENT').length, 4);
  assert.equal(entries.filter((e) => e.state === 'PENDING').length, 2);
  console.log(
    JSON.stringify(
      {
        isolated: true,
        telegram: 'code sink; no real delivery',
        receipts,
        stableId: entries[0]?.payload.eventId,
        delivered: 4,
        pending: 2,
      },
      null,
      2,
    ),
  );
}
void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
