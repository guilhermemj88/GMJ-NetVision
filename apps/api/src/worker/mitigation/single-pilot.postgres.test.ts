import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/index.js';
import { PrismaAutomationStore, type AutomationStore } from './automation-store';
import { createPilotHarness } from '../../testing/single-pilot-harness';
import { DurableMitigationOutbox, type OutboxEntry } from './durable-mitigation-outbox';

// Explicit opt-in; this suite must never accept an operational database URL.
const url = process.env.SINGLE_PILOT_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55077' ||
    parsed.pathname !== '/single_pilot_test'
  )
    throw Error('DISPOSABLE_SINGLE_PILOT_DATABASE_REQUIRED');
}
describe.skipIf(!url)('single pilot with real PostgreSQL ownership, journal and outbox', () => {
  let db = new PrismaClient({ datasources: { db: { url: url ?? 'postgresql://invalid/unused' } } });
  const store: AutomationStore = {
    transaction: (work) => new PrismaAutomationStore(db).transaction(work),
  };
  beforeEach(async () => {
    await db.mitigationAutomationRecord.deleteMany();
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  const reconnect = async () => {
    await db.$disconnect();
    db = new PrismaClient({ datasources: { db: { url: url! } } });
  };
  it('survives a new DB client/coordinator and retries the same event without another ACTIVATE', async () => {
    const h = await createPilotHarness(store);
    for (const bps of [9_200_000_000n, 9_300_000_000n, 9_400_000_000n]) {
      h.sample(bps);
      await h.lifecycle.tickPilot();
    }
    expect((await h.scope())?.phase).toBe('ACTIVE');
    const [event] = await store.transaction((tx) => tx.list<OutboxEntry>('outbox'));
    expect(event).toBeDefined();
    await reconnect();
    await h.restart();
    h.sample(9_900_000_000n);
    await h.lifecycle.tickPilot();
    expect(h.lifecycle.pilotStatus()?.state).toBe('ACTIVE');
    expect(h.ssh.writes).toHaveLength(1);
    const publish = async () => ({ published: false, skipped: false });
    await new DurableMitigationOutbox(store, { publish }, h.now).drain();
    await reconnect();
    h.advance(30_000);
    const ids: string[] = [];
    await new DurableMitigationOutbox(
      store,
      {
        publish: async (n) => {
          ids.push(n.eventId!);
          return { published: true, skipped: false };
        },
      },
      h.now,
    ).drain();
    expect(ids).toEqual([event!.payload.eventId]);
    expect(h.ssh.writes).toHaveLength(1);
  });
  it('reconciles a restart after SSH write but before completion to durable UNCERTAIN', async () => {
    const h = await createPilotHarness(store);
    let entered!: () => void, release!: () => void;
    const written = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.ssh.afterWrite = async () => {
      entered();
      await held;
    };
    for (const bps of [9_200_000_000n, 9_300_000_000n]) {
      h.sample(bps);
      await h.lifecycle.tickPilot();
    }
    h.sample(9_400_000_000n);
    const inFlight = h.lifecycle.tickPilot();
    try {
      await written;
      expect((await h.scope())?.phase).toBe('ACTIVATING');
      await h.restart();
      expect((await h.scope())?.phase).toBe('UNCERTAIN');
    } finally {
      release();
      await inFlight;
    }
    await reconnect();
    await h.restart();
    for (let i = 0; i < 4; i++) {
      h.sample(9_900_000_000n);
      await h.lifecycle.tickPilot();
    }
    expect((await h.scope())?.phase).toBe('UNCERTAIN');
    expect(h.ssh.writes).toHaveLength(1);
    expect(h.ssh.writes.flat().some((c) => c.startsWith('undo'))).toBe(false);
  });
});
