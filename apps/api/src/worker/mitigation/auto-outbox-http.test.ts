import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DurableMitigationOutbox, type OutboxEntry } from './durable-mitigation-outbox';
import { MemoryAutomationStore } from './automation-store';
import {
  N8nMediaTransport,
  createFetchWebhookSender,
} from '../../infrastructure/media/n8n-media-transport';
import type { MitigationNotification } from '../../infrastructure/bgp/mitigation/notification-publisher';

describe('durable real HTTP transport, loopback only', () => {
  it.each([
    'MITIGATION_VERIFIED',
    'MITIGATION_REMOVED_VERIFIED',
    'MITIGATION_DETECTION_BLOCKED',
  ] as const)('%s requires 2xx AND delivered=true; retry survives restart', async (event) => {
    let now = 0,
      status = 200,
      ack = false,
      tokenValid = true;
    const received: string[] = [];
    const server = createServer(async (req, res) => {
      tokenValid &&= req.headers['x-netvision-token'] === 'isolated-header';
      let body = '';
      for await (const chunk of req) body += String(chunk);
      received.push(JSON.parse(body).eventId);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ delivered: ack }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw Error('address');
    const media = {
      resolveOutbound: async () => ({
        integrationId: 'isolated',
        source: 'DATABASE' as const,
        enabled: true,
        url: `http://127.0.0.1:${addr.port}/webhook/netvision-mitigation`,
        token: 'isolated-header',
      }),
      recordOutboundAttempt: async () => {},
      recordOutboundDelivery: async () => {},
    };
    const transport = new N8nMediaTransport({
      media,
      send: createFetchWebhookSender({ timeoutMs: 1000 }),
      requireAcknowledgement: true,
    });
    const store = new MemoryAutomationStore();
    let q = new DurableMitigationOutbox(store, transport, () => now);
    const notification: MitigationNotification = {
      event,
      eventId: 'stable-http-id',
      profileId: 'fake',
      simulation: false,
      verified: event !== 'MITIGATION_DETECTION_BLOCKED',
      customer: 'OFFLINE',
      device: 'FAKE',
      interfaceName: null,
      peer: null,
      affectedPeers: [],
      detectedBandwidthBps: null,
      bandwidthOverrideBps: null,
      effectiveBandwidthBps: 1000000000n,
      trafficBps: null,
      thresholdBps: null,
      policy: 'FAKE',
      node: 2,
      rt: '1:1',
    };
    try {
      await q.publish(notification);
      await q.drain();
      expect((await store.transaction((tx) => tx.list<OutboxEntry>('outbox')))[0]?.state).toBe(
        'PENDING',
      );
      now += 30000;
      status = 503;
      ack = true;
      q = new DurableMitigationOutbox(store, transport, () => now);
      await q.drain();
      expect((await store.transaction((tx) => tx.list<OutboxEntry>('outbox')))[0]?.state).toBe(
        'PENDING',
      );
      now += 60000;
      status = 200;
      await q.drain();
      expect((await store.transaction((tx) => tx.list<OutboxEntry>('outbox')))[0]?.state).toBe(
        'SENT',
      );
      expect(received).toEqual(['stable-http-id', 'stable-http-id', 'stable-http-id']);
      expect(tokenValid).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('real HTTP timeout aborts and retains pending event', async () => {
    const server = createServer(() => {});
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw Error('address');
    try {
      const send = createFetchWebhookSender({ timeoutMs: 50 });
      await expect(
        send(`http://127.0.0.1:${addr.port}/`, { event: 'fake' }, {}),
      ).rejects.toMatchObject({ safeError: 'Timeout ao chamar o webhook' });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
