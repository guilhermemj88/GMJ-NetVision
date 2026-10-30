import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import Fastify from 'fastify';
import { createPilotHarness } from '../../testing/single-pilot-harness';
import { registerN8nRoutes } from '../../n8n-routes';
import { DurableMitigationOutbox, type OutboxEntry } from './durable-mitigation-outbox';
import {
  N8nMediaTransport,
  createFetchWebhookSender,
} from '../../infrastructure/media/n8n-media-transport';
import { SINGLE_AUTO_PILOT as P, assertSinglePilotAuthorization } from './single-pilot-trigger';

const high = [9_200_000_000n, 9_300_000_000n, 9_400_000_000n];
async function trigger(h: Awaited<ReturnType<typeof createPilotHarness>>) {
  for (const bps of high) {
    h.sample(bps);
    await h.lifecycle.tickPilot();
  }
}
describe('single pilot through real FAST adapter, command service, Huawei executor and parsers', () => {
  it('8 → 9.2 → 9.3 → 9.4, one ACTIVATE, HTTP verified event, hold, restart and authenticated manual REMOVE', async () => {
    const h = await createPilotHarness();
    h.sample(8_000_000_000n);
    await h.lifecycle.tickPilot();
    for (const bps of high.slice(0, 2)) {
      h.sample(bps);
      await h.lifecycle.tickPilot();
      expect(h.ssh.writes).toHaveLength(0);
    }
    h.sample(high[2]!);
    const [d] = await h.lifecycle.tickPilot();
    expect(d?.verified).toBe(true);
    expect(h.ssh.writes).toHaveLength(1);
    expect(h.ssh.writes[0]).toEqual([
      'system-view',
      `route-policy ${P.policy} deny node 1`,
      ' if-match ip-prefix BOGONS',
      `route-policy ${P.policy} permit node 2`,
      ' if-match ip-prefix AGLINK-BLOCO-TODO-23',
      ' apply local-preference 1100',
      ` apply extcommunity rt ${P.rt}`,
      'commit',
    ]);
    expect(h.lifecycle.pilotStatus()?.state).toBe('ACTIVE');
    const received: Record<string, unknown>[] = [];
    let delivered = false;
    const server = createServer(async (req, res) => {
      expect(req.url).toBe('/webhook/netvision-mitigation');
      expect(req.headers['x-netvision-token']).toBe('isolated-outbound');
      let body = '';
      for await (const chunk of req) body += String(chunk);
      received.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ delivered }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('missing loopback address');
    const transport = new N8nMediaTransport({
      media: {
        resolveOutbound: async () => ({
          integrationId: 'isolated',
          source: 'DATABASE',
          enabled: true,
          url: `http://127.0.0.1:${address.port}/webhook/netvision-mitigation`,
          token: 'isolated-outbound',
        }),
        recordOutboundAttempt: async () => {},
        recordOutboundDelivery: async () => {},
      },
      send: createFetchWebhookSender({ timeoutMs: 1000 }),
      requireAcknowledgement: true,
    });
    try {
      let q = new DurableMitigationOutbox(h.store, transport, h.now);
      await q.drain();
      expect((await h.scope())?.phase).toBe('ACTIVE');
      expect((await h.store.transaction((tx) => tx.list<OutboxEntry>('outbox')))[0]?.state).toBe(
        'PENDING',
      );
      h.advance(30000);
      delivered = true;
      q = new DurableMitigationOutbox(h.store, transport, h.now);
      await q.drain();
      expect(received).toHaveLength(2);
      expect(received[0]?.eventId).toBe(received[1]?.eventId);
      expect(received[1]).toMatchObject({
        event: 'MITIGATION_VERIFIED',
        verified: true,
        profileId: P.profileId,
        policy: P.policy,
        bogonNode: 1,
        mitigationNode: 2,
        rt: P.rt,
        interface: P.interfaceName,
      });
      h.sample(1_000_000_000n);
      await h.lifecycle.tickPilot();
      await h.restart();
      h.sample(9_900_000_000n);
      await h.lifecycle.tickPilot();
      expect(h.lifecycle.pilotStatus()?.state).toBe('ACTIVE');
      expect(h.ssh.writes).toHaveLength(1);
      const app = Fastify();
      registerN8nRoutes(app, { commands: h.commands, commandToken: 'isolated-inbound' });
      try {
        const body = {
          requestId: 'operator-remove-1',
          action: 'REMOVE',
          profileId: P.profileId,
          confirmedBy: 'operator',
        };
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/api/integrations/n8n/mitigation-command',
              payload: body,
            })
          ).statusCode,
        ).toBe(401);
        expect(h.ssh.writes).toHaveLength(1);
        const result = await app.inject({
          method: 'POST',
          url: '/api/integrations/n8n/mitigation-command',
          headers: { authorization: 'Bearer isolated-inbound' },
          payload: body,
        });
        expect(result.json()).toMatchObject({
          ok: true,
          verified: true,
          status: 'REMOVED_VERIFIED',
        });
        expect(h.ssh.writes).toHaveLength(2);
        expect(h.ssh.active).toBe(false);
      } finally {
        await app.close();
      }
      await q.drain();
      expect(received.at(-1)).toMatchObject({
        event: 'MITIGATION_REMOVED_VERIFIED',
        verified: true,
      });
      await h.restart();
      h.sample(9_900_000_000n);
      await h.lifecycle.tickPilot();
      expect(h.ssh.writes).toHaveLength(2); // cooldown and a new episode are mandatory
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it.each(['missing', 'stale', 'reset', 'gap', 'duplicate'] as const)(
    '%s cannot complete the previous sequence',
    async (failure) => {
      const h = await createPilotHarness();
      h.sample(high[0]!);
      await h.lifecycle.tickPilot();
      if (failure === 'missing') h.snapshot().collectorAvailable = false;
      if (failure === 'stale') h.advance(16000);
      if (failure === 'reset') h.snapshot().current!.generation = 'reset';
      if (failure === 'gap') h.sample(high[1]!, 20000);
      await h.lifecycle.tickPilot();
      h.snapshot().collectorAvailable = true;
      if (failure === 'duplicate') {
        await h.lifecycle.tickPilot();
        expect(h.ssh.writes).toHaveLength(0);
        return;
      }
      h.sample(high[1]!);
      await h.lifecycle.tickPilot();
      h.sample(high[2]!);
      await h.lifecycle.tickPilot();
      expect(h.ssh.writes).toHaveLength(0);
    },
  );
  it.each(['M8', 'profile', 'shared', 'family', 'binding', 'runtime'] as const)(
    '%s gate closes before any write',
    async (gate) => {
      const h = await createPilotHarness();
      if (gate === 'M8') h.config.executionEnabled = false;
      if (gate === 'profile') h.config.profiles = [];
      if (gate === 'shared') h.target.sharedPolicy = true;
      if (gate === 'family') h.target.otherFamilyAuto = true;
      if (gate === 'binding') h.target.clientBinding = null;
      if (gate === 'runtime')
        await h.repository.upsertRuntime(P.profileId, { state: 'RECONCILIATION_REQUIRED' });
      await trigger(h);
      expect(h.ssh.writes).toHaveLength(0);
    },
  );
  it.each(['partial', 'timeout', 'wrongRt'] as const)(
    '%s becomes UNCERTAIN and never rolls back or retries ACTIVATE',
    async (mode) => {
      const h = await createPilotHarness();
      h.ssh[mode] = true;
      await trigger(h);
      expect(h.ssh.writes).toHaveLength(1);
      expect((await h.scope())?.phase).toBe('UNCERTAIN');
      await trigger(h);
      await h.restart();
      await trigger(h);
      expect(h.ssh.writes).toHaveLength(1);
      expect(h.ssh.writes.flat().some((c) => c.startsWith('undo'))).toBe(false);
    },
  );
  it('canonical prefix preflight and occupied manual nodes reject writes', async () => {
    for (const kind of ['prefixes', 'preexisting'] as const) {
      const h = await createPilotHarness();
      h.ssh[kind] = kind === 'preexisting';
      await trigger(h);
      expect(h.ssh.writes).toHaveLength(0);
    }
  });
  it('rejects a second physical BGP peer even when cached scope says dedicated', async () => {
    const h = await createPilotHarness();
    h.ssh.sharedBinding = true;
    await trigger(h);
    expect(h.ssh.writes).toHaveLength(0);
  });
  it('restart without an ownership record reads hardware and quarantines preexisting mitigation', async () => {
    const h = await createPilotHarness();
    h.ssh.active = true;
    await h.restart();
    await trigger(h);
    expect(h.ssh.writes).toHaveLength(0);
    expect((await h.scope())?.phase).toBe('UNCERTAIN');
  });
  it('the pilot configuration refuses broad or different allowlists', async () => {
    const h = await createPilotHarness();
    h.config.profiles.push('another');
    expect(() => assertSinglePilotAuthorization(h.config)).toThrow(
      'SINGLE_PILOT_EXPLICIT_AUTHORIZATION_REQUIRED',
    );
  });
  it('a read failure cannot recount the last sample when telemetry returns', async () => {
    const h = await createPilotHarness();
    h.sample(high[0]!);
    await h.lifecycle.tickPilot();
    h.snapshot().collectorAvailable = false;
    await h.lifecycle.tickPilot();
    h.snapshot().collectorAvailable = true;
    await h.lifecycle.tickPilot();
    h.sample(high[1]!);
    await h.lifecycle.tickPilot();
    h.sample(high[2]!);
    await h.lifecycle.tickPilot();
    expect(h.ssh.writes).toHaveLength(0);
    h.sample(high[2]!);
    await h.lifecycle.tickPilot();
    expect(h.ssh.writes).toHaveLength(1);
  });
  it('9 Gbps exactly resets the sequence; successful manual REMOVE needs a new post-cooldown episode', async () => {
    const h = await createPilotHarness();
    h.sample(high[0]!);
    await h.lifecycle.tickPilot();
    h.sample(9_000_000_000n);
    await h.lifecycle.tickPilot();
    await trigger(h);
    expect(h.ssh.writes).toHaveLength(1);
    const removed = await h.commands.execute({
      requestId: 'manual-clear',
      profileId: P.profileId,
      action: 'REMOVE',
    });
    expect(removed.status).toBe('REMOVED_VERIFIED');
    expect(h.ssh.writes).toHaveLength(2);
    h.advance(60001);
    h.sample(1_000_000_000n);
    await h.lifecycle.tickPilot();
    await trigger(h);
    expect(h.ssh.writes).toHaveLength(3);
    expect((await h.scope())?.phase).toBe('ACTIVE');
  });
  it('restart loses incomplete confirmations instead of replaying them', async () => {
    const h = await createPilotHarness();
    h.sample(high[0]!);
    await h.lifecycle.tickPilot();
    h.sample(high[1]!);
    await h.lifecycle.tickPilot();
    await h.restart();
    await h.lifecycle.tickPilot();
    h.sample(high[2]!);
    await h.lifecycle.tickPilot();
    expect(h.ssh.writes).toHaveLength(0);
  });
  it('concurrent coordinators share the durable scope and canonical writer lock', async () => {
    const h = await createPilotHarness();
    h.sample(high[0]!);
    await h.lifecycle.tickPilot();
    h.sample(high[1]!);
    await h.lifecycle.tickPilot();
    h.sample(high[2]!);
    await Promise.all([h.lifecycle.tickPilot(), h.lifecycle.tickPilot()]);
    expect(h.ssh.writes).toHaveLength(1);
  });
});
