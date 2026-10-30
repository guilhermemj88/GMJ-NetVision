import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PrismaClient } from '../../generated/prisma/index.js';
import { PrismaAutomationStore, type AutomationStore } from './automation-store';
import { createPilotHarness } from '../../testing/single-pilot-harness';
import { DurableMitigationOutbox, type OutboxEntry } from './durable-mitigation-outbox';
import { SINGLE_AUTO_PILOT as P } from './single-pilot-trigger';
import { type JournalCommand } from './auto-lifecycle';
import {
  N8nMediaTransport,
  createFetchWebhookSender,
} from '../../infrastructure/media/n8n-media-transport';

// Separate from the earlier PostgreSQL suite: parallel tests cannot delete its rows.
const url = process.env.SINGLE_PILOT_READINESS_DATABASE_URL;
if (url) {
  const u = new URL(url);
  if (
    u.hostname !== '127.0.0.1' ||
    u.port !== '55077' ||
    u.pathname !== '/aglink_persistence_readiness'
  )
    throw Error('DISPOSABLE_READINESS_DATABASE_REQUIRED');
}

describe.skipIf(!url)('durable readiness with PostgreSQL and fake external transports', () => {
  let db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://invalid/unused' } } });
  const store: AutomationStore = {
    transaction: (work) => new PrismaAutomationStore(db).transaction(work),
  };
  const reconnect = async () => {
    await db.$disconnect();
    db = new PrismaClient({ datasources: { db: { url: url! } } });
  };
  beforeEach(async () => {
    await db.mitigationAutomationRecord.deleteMany();
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  const activate = async (h: Awaited<ReturnType<typeof createPilotHarness>>) => {
    for (const bps of [9_200_000_000n, 9_300_000_000n, 9_400_000_000n]) {
      h.sample(bps);
      await h.lifecycle.tickPilot();
    }
  };

  it('serializes competing transactions and rolls back journal/outbox together', async () => {
    await store.transaction((tx) => tx.put('counter', 'audit', 'PENDING', { count: 0 }));
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.transaction(async (tx) => {
          const current = await tx.get<{ count: number }>('counter');
          await tx.put('counter', 'audit', 'PENDING', { count: current!.count + 1 });
        }),
      ),
    );
    expect(await store.transaction((tx) => tx.get('counter'))).toEqual({ count: 20 });
    await expect(
      store.transaction(async (tx) => {
        await tx.put('failed-command', 'command', 'STARTED', { action: 'ACTIVATE' });
        await tx.put('failed-event', 'outbox', 'PENDING', { eventId: 'must-not-escape' });
        throw Error('injected transaction interruption');
      }),
    ).rejects.toThrow('injected transaction interruption');
    await reconnect();
    expect(await store.transaction((tx) => tx.get('failed-command'))).toBeNull();
    expect(await store.transaction((tx) => tx.get('failed-event'))).toBeNull();
  });

  it('holds ACTIVE across restart/normalization and releases only on verified manual REMOVE', async () => {
    const h = await createPilotHarness(store);
    await activate(h);
    expect((await h.scope())?.phase).toBe('ACTIVE');
    await reconnect();
    await h.restart();
    h.sample(9_900_000_000n);
    await h.lifecycle.tickPilot();
    expect(h.ssh.writes).toHaveLength(1);
    for (let i = 0; i < 10; i++) {
      h.sample(100_000_000n);
      await h.lifecycle.tickPilot();
    }
    h.advance(7 * 24 * 60 * 60_000);
    await h.lifecycle.tickPilot();
    expect((await h.scope())?.phase).toBe('ACTIVE');
    expect(h.ssh.writes).toHaveLength(1);
    h.config.executionEnabled = false;
    const input = {
      action: 'REMOVE' as const,
      profileId: P.profileId,
      requestId: 'readiness-manual-remove',
      confirmedBy: 'isolated-operator',
    };
    const result = await h.commands.execute(input);
    expect(result).toMatchObject({ ok: true, verified: true, status: 'REMOVED_VERIFIED' });
    expect(h.ssh.writes).toHaveLength(2);
    expect((await h.scope())?.phase).toBe('COOLDOWN');
    expect((await h.scope())?.owner).toBe('released:' + input.requestId);
    await reconnect();
    await h.restart();
    expect(await h.commands.execute(input)).toMatchObject({ ok: true, idempotent: true });
    h.sample(9_900_000_000n);
    await h.lifecycle.tickPilot();
    expect(h.ssh.writes).toHaveLength(2);
    const journal = await store.transaction((tx) => tx.list<JournalCommand>('command'));
    expect(journal.filter((j) => j.action === 'REMOVE')).toHaveLength(1);
    expect(journal.find((j) => j.action === 'REMOVE')?.origin).toBe('MANUAL');
  });

  it('retains UNCERTAIN and forbids replay after a timeout following the write', async () => {
    const h = await createPilotHarness(store);
    h.ssh.timeout = true;
    await activate(h);
    expect((await h.scope())?.phase).toBe('UNCERTAIN');
    await reconnect();
    h.ssh.timeout = false;
    await h.restart();
    for (let i = 0; i < 5; i++) {
      h.sample(9_900_000_000n);
      await h.lifecycle.tickPilot();
    }
    expect((await h.scope())?.phase).toBe('UNCERTAIN');
    expect(h.ssh.writes).toHaveLength(1);
    expect(h.ssh.writes.flat().some((line) => line.startsWith('undo'))).toBe(false);
  });

  it('keeps the outbox/event ID through an HTTP NACK, reconnect and positive ACK', async () => {
    const h = await createPilotHarness(store);
    await activate(h);
    const received: Record<string, unknown>[] = [];
    let delivered = false;
    const server = createServer(async (req, res) => {
      expect(req.url).toBe('/webhook/netvision-mitigation');
      expect(req.headers['x-netvision-token']).toBe('fake-loopback-token');
      let body = '';
      for await (const chunk of req) body += String(chunk);
      received.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ delivered }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Loopback fixture missing');
    const transport = new N8nMediaTransport({
      media: {
        resolveOutbound: async () => ({
          integrationId: 'readiness-fake',
          source: 'DATABASE',
          enabled: true,
          url: `http://127.0.0.1:${address.port}/webhook/netvision-mitigation`,
          token: 'fake-loopback-token',
        }),
        recordOutboundAttempt: async () => {},
        recordOutboundDelivery: async () => {},
      },
      send: createFetchWebhookSender({ timeoutMs: 1000 }),
      requireAcknowledgement: true,
    });
    try {
      await new DurableMitigationOutbox(store, transport, h.now).drain();
      expect((await store.transaction((tx) => tx.list<OutboxEntry>('outbox')))[0]?.state).toBe(
        'PENDING',
      );
      await reconnect();
      await h.restart();
      h.advance(30_000);
      delivered = true;
      await new DurableMitigationOutbox(store, transport, h.now).drain();
      await reconnect();
      await new DurableMitigationOutbox(store, transport, h.now).drain();
      expect(received).toHaveLength(2);
      expect(received[0]?.eventId).toBe(received[1]?.eventId);
      expect(received[1]).toMatchObject({ event: 'MITIGATION_VERIFIED', verified: true });
      expect((await store.transaction((tx) => tx.list<OutboxEntry>('outbox')))[0]?.state).toBe(
        'SENT',
      );
      expect(h.ssh.writes).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
