import { afterAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { PrismaClient } from '../generated/prisma/index.js';
import { PrismaAutomationStore, type AutomationStore } from '../worker/mitigation/automation-store';
import {
  DurableMitigationOutbox,
  type OutboxEntry,
} from '../worker/mitigation/durable-mitigation-outbox';
import {
  N8nMediaTransport,
  createFetchWebhookSender,
} from '../infrastructure/media/n8n-media-transport';
import type { MitigationNotification } from '../infrastructure/bgp/mitigation/notification-publisher';
import { FastGrowthNotifications } from './fast-growth-notifications';
import { fastGrowthProfile } from '../infrastructure/snmp/fast-growth-profile';
import type {
  FastTrafficTarget,
  FastTrafficObservation,
} from '../infrastructure/snmp/fast-traffic-types';

const url = process.env.FAST_TEST_DATABASE_URL;
if (url) {
  const u = new URL(url);
  if (
    u.hostname !== '127.0.0.1' ||
    u.port !== '55439' ||
    u.pathname !== '/netvision_ddos_fast_test'
  )
    throw Error('Only explicitly isolated disposable FAST PostgreSQL is accepted');
}
const evidence: unknown[] = [];
describe.skipIf(!url)('Growth: real PostgreSQL reconnect and identical local HTTP retries', () => {
  let db = new PrismaClient({ datasourceUrl: url ?? 'postgresql://invalid/unused' });
  const store: AutomationStore = {
    transaction: (work) => new PrismaAutomationStore(db).transaction(work),
  };
  afterAll(async () => {
    await db.mitigationAutomationRecord.deleteMany({
      where: {
        OR: [
          { id: { startsWith: 'outbox:MITIGATION_DETECTION_BLOCKED:growth-audit-pg-' } },
          { id: { startsWith: 'delivery-limit:growth-audit-pg-' } },
        ],
      },
    });
    await db.$disconnect();
  });
  it.each([false, true])(
    'fractional recovery=%s cannot block persistence/delivery or alter a retry',
    async (fractional) => {
      const id = 'growth-audit-pg-' + randomUUID(),
        bw = 1000000000n,
        start = Date.parse('2026-11-05T12:00:00Z');
      let now = start + 60000,
        ack = false;
      const metadata = fastGrowthProfile({
        profileId: id,
        direction: 'tx',
        bandwidthBps: bw,
        triggerPercent: 95,
        recoveryPercent: fractional ? 70.5 : 70,
        recoverySamples: 3,
      });
      const target: FastTrafficTarget = {
        deviceId: 'loopback-only',
        interfaceId: id,
        interfaceName: id,
        ifIndex: 1,
        speedBps: bw * 10n,
        profiles: [
          metadata ?? {
            profileId: id,
            direction: 'tx',
            bandwidthBps: bw,
            thresholdBps: 950000000n,
            growthEligible: false,
          },
        ],
      };
      const g = new FastGrowthNotifications(15000);
      for (let i = 0; i <= 12; i++) {
        const at = start + i * 5000;
        g.record(target, {
          deviceId: target.deviceId,
          interfaceId: id,
          interfaceName: id,
          ifIndex: 1,
          speedBps: target.speedBps,
          id: String(i),
          generation: 'same',
          quality: 'VALID',
          collectedAt: new Date(at),
          requestStartedAt: new Date(at),
          previousCollectedAt: new Date(at - 5000),
          intervalMs: 5000,
          rxBps: 0,
          txBps: i === 12 ? 950000000 : 200000000,
          inOctets: 1n,
          outOctets: 1n,
          uptimeTicks: BigInt(at),
          discontinuityTicks: 0n,
          lastChangeTicks: 0n,
          adminStatus: 1,
          operStatus: 1,
        } satisfies FastTrafficObservation);
      }
      const notification: MitigationNotification = {
        event: 'MITIGATION_DETECTION_BLOCKED',
        eventId: id,
        profileId: id,
        episodeId: id,
        occurredAt: new Date(now).toISOString(),
        simulation: true,
        verified: false,
        customer: 'OFFLINE',
        device: 'LOOPBACK ONLY',
        interfaceName: id,
        peer: null,
        affectedPeers: [],
        detectedBandwidthBps: null,
        bandwidthOverrideBps: null,
        effectiveBandwidthBps: bw,
        trafficBps: 980000000n,
        thresholdBps: 950000000n,
        policy: 'OFFLINE',
        node: null,
        rt: null,
      };
      const frozen = g.enrich(notification),
        received: Record<string, unknown>[] = [];
      const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += String(chunk);
        received.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ delivered: ack }));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('address');
      const transport = new N8nMediaTransport({
        requireAcknowledgement: true,
        media: {
          resolveOutbound: async () => ({
            integrationId: 'offline',
            source: 'DATABASE',
            enabled: true,
            url: `http://127.0.0.1:${address.port}/growth-test`,
            token: null,
          }),
          recordOutboundAttempt: async () => {},
          recordOutboundDelivery: async () => {},
        },
        send: createFetchWebhookSender({ timeoutMs: 2000 }),
      });
      try {
        await new DurableMitigationOutbox(store, transport, () => now).publish(frozen);
        await new DurableMitigationOutbox(store, transport, () => now).drain();
        await db.$disconnect();
        // New sidecar and database client: retry must use the durable JSON, never live history.
        expect(new FastGrowthNotifications(15000).enrich(notification)).toEqual(notification);
        db = new PrismaClient({ datasourceUrl: url! });
        now += 30000;
        ack = true;
        await new DurableMitigationOutbox(store, transport, () => now).drain();
        expect(received).toHaveLength(2);
        expect(received[1]).toEqual(received[0]);
        expect(received[0]!.eventId).toBe(id);
        expect(received[0]!.profileId).toBe(id);
        if (fractional) expect(received[0]!.growth).toBeNull();
        else
          expect(received[0]!.growth).toMatchObject({
            growthClassification: 'BRUSCO',
            currentUtilizationPct: 95,
          });
        const rows = await store.transaction((tx) => tx.list<OutboxEntry>('outbox'));
        expect(rows.find((r) => r.profileId === id)?.state).toBe('SENT');
        evidence.push({
          fractionalRecovery: fractional,
          received,
          databaseReconnected: true,
          sidecarRestarted: true,
        });
        if (process.env.FAST_GROWTH_PG_EVIDENCE_PATH)
          await writeFile(
            process.env.FAST_GROWTH_PG_EVIDENCE_PATH,
            JSON.stringify(
              { synthetic: true, realPostgreSql: true, loopbackOnly: true, cases: evidence },
              null,
              2,
            ) + '\n',
          );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
