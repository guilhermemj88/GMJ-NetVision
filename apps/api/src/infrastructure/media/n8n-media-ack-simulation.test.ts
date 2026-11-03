import { describe, it, expect } from 'vitest';
import {
  N8nMediaTransport,
  type MediaChannelPort,
  type WebhookDeliveryResult,
} from './n8n-media-transport';
import type {
  MitigationNotification,
  MitigationNotificationEvent,
} from '../bgp/mitigation/notification-publisher';
import { DurableMitigationOutbox, type OutboxEntry } from '../../worker/mitigation/durable-mitigation-outbox';
import { MemoryAutomationStore } from '../../worker/mitigation/automation-store';

const EVENT_ID = 'sim-ack-1';
const SIMULATION_ERROR =
  'Webhook nao confirmou o processamento da simulacao (received/routed/delivered)';
const DELIVERY_ERROR = 'Webhook nao confirmou a entrega do alerta (delivered != true)';

interface Recorded {
  ok: boolean;
  safeError: string | null;
  httpStatus: number | null;
  event: string;
}

function notification(
  event: MitigationNotificationEvent,
  eventId: string = EVENT_ID,
): MitigationNotification {
  return {
    event,
    eventId,
    profileId: 'profile-1',
    simulation: event === 'MITIGATION_SIMULATION_TRIGGERED' || event === 'MITIGATION_REMOVE_SIMULATED',
    verified: event === 'MITIGATION_VERIFIED' ? true : null,
    customer: 'CLIENTE',
    device: 'DEVICE',
    interfaceName: 'Eth-Trunk1',
    peer: '203.0.113.1',
    affectedPeers: [],
    detectedBandwidthBps: null,
    bandwidthOverrideBps: null,
    effectiveBandwidthBps: 1_000_000_000n,
    trafficBps: null,
    thresholdBps: null,
    policy: 'PL-TEST',
    node: 2,
    rt: '268568:660',
  };
}

/** ACK devolvido pelo node `Responder OUT 200` para um evento de simulacao. */
function simulationAck(event: string, eventId: string | null = EVENT_ID) {
  return {
    ok: true,
    received: true,
    routed: false,
    delivered: false,
    event,
    eventId,
    profileId: 'profile-1',
    episodeId: null,
  };
}

function harness(
  response: WebhookDeliveryResult | (() => WebhookDeliveryResult | Promise<never>),
  options: { requireAcknowledgement?: boolean } = {},
) {
  const deliveries: Recorded[] = [];
  const attempts: string[] = [];
  const sent: Array<{ url: string; payload: unknown }> = [];
  const media: MediaChannelPort = {
    resolveOutbound: async () => ({
      integrationId: 'isolated',
      source: 'DATABASE' as const,
      enabled: true,
      url: 'https://n8n.test/webhook/netvision-mitigation',
      token: 'header-token',
    }),
    recordOutboundAttempt: async (input) => {
      attempts.push(input.event);
    },
    recordOutboundDelivery: async (input) => {
      deliveries.push({
        ok: input.ok,
        safeError: input.safeError,
        httpStatus: input.httpStatus,
        event: input.event,
      });
    },
  };
  const transport = new N8nMediaTransport({
    media,
    requireAcknowledgement: options.requireAcknowledgement ?? true,
    send: async (url, payload) => {
      sent.push({ url, payload });
      if (typeof response === 'function') return response() as WebhookDeliveryResult;
      return response;
    },
  });
  return { transport, deliveries, attempts, sent };
}

function ok(body: unknown): WebhookDeliveryResult {
  return { httpStatus: 200, latencyMs: 5, body };
}

describe('ACK de simulacao no webhook n8n', () => {
  it.each(['MITIGATION_SIMULATION_TRIGGERED', 'MITIGATION_REMOVE_SIMULATED'] as const)(
    '%s com received/routed/delivered e identidade corretos e aceito',
    async (event) => {
      const h = harness(ok(simulationAck(event)));
      await expect(h.transport.publish(notification(event))).resolves.toEqual({
        published: true,
        skipped: false,
      });
      expect(h.deliveries).toEqual([
        { ok: true, safeError: null, httpStatus: 200, event },
      ]);
      expect(h.attempts).toEqual([event]);
      expect(h.sent).toHaveLength(1);
    },
  );

  it.each(['MITIGATION_SIMULATION_TRIGGERED', 'MITIGATION_REMOVE_SIMULATED'] as const)(
    '%s fecha o outbox em SENT na primeira tentativa',
    async (event) => {
      const h = harness(ok(simulationAck(event)));
      const store = new MemoryAutomationStore();
      const outbox = new DurableMitigationOutbox(store, h.transport, () => 1_000);
      await outbox.publish(notification(event));
      expect(await outbox.drain()).toBe(1);
      const [row] = await store.transaction((tx) => tx.list<OutboxEntry>('outbox'));
      expect(row?.state).toBe('SENT');
      expect(row?.attempts).toBe(1);
      expect(row?.error).toBeNull();
      expect(row?.deliveredAt).toBe(1_000);
      expect(h.deliveries).toHaveLength(1);
    },
  );

  it('ACK de simulacao com identidade divergente reprova e agenda retry', async () => {
    const store = new MemoryAutomationStore();
    const wrongId = harness(ok(simulationAck('MITIGATION_SIMULATION_TRIGGERED', 'outro-evento')));
    const wrongEvent = harness(
      ok({ ...simulationAck('MITIGATION_SIMULATION_TRIGGERED'), event: 'MITIGATION_VERIFIED' }),
    );
    const nullId = harness(ok(simulationAck('MITIGATION_SIMULATION_TRIGGERED', null)));

    for (const h of [wrongId, wrongEvent, nullId]) {
      await expect(
        h.transport.publish(notification('MITIGATION_SIMULATION_TRIGGERED')),
      ).resolves.toEqual({ published: false, skipped: false });
      expect(h.deliveries).toEqual([
        { ok: false, safeError: SIMULATION_ERROR, httpStatus: 200, event: 'MITIGATION_SIMULATION_TRIGGERED' },
      ]);
    }

    const outbox = new DurableMitigationOutbox(store, wrongId.transport, () => 1_000);
    await outbox.publish(notification('MITIGATION_SIMULATION_TRIGGERED'));
    await outbox.drain();
    const [row] = await store.transaction((tx) => tx.list<OutboxEntry>('outbox'));
    expect(row?.state).toBe('PENDING');
    expect(row?.attempts).toBe(1);
  });

  it('identidade ausente no ACK de simulacao nao reprova', async () => {
    const h = harness(ok({ ok: true, received: true, routed: false, delivered: false }));
    await expect(h.transport.publish(notification('MITIGATION_SIMULATION_TRIGGERED'))).resolves.toEqual(
      { published: true, skipped: false },
    );
  });

  it.each([
    ['corpo ausente', null],
    ['corpo nao-objeto', 'ok'],
    ['array', []],
    ['ACK vazio', {}],
    ['received ausente', { routed: false, delivered: false }],
    ['received false', { received: false, routed: false, delivered: false }],
    ['routed true', { received: true, routed: true, delivered: false }],
    ['delivered true', { received: true, routed: false, delivered: true }],
    ['delivered ausente', { received: true, routed: false }],
    [
      'evento de outro tipo',
      { ...simulationAck('MITIGATION_SIMULATION_TRIGGERED'), event: 'MITIGATION_REMOVED_VERIFIED' },
    ],
  ])('simulacao com %s reprova com retry', async (_label, body) => {
    const h = harness(ok(body));
    await expect(h.transport.publish(notification('MITIGATION_SIMULATION_TRIGGERED'))).resolves.toEqual({
      published: false,
      skipped: false,
    });
    expect(h.deliveries[0]).toMatchObject({ ok: false, safeError: SIMULATION_ERROR });
  });

  it('HTTP nao-2xx reprova mesmo com ACK de simulacao valido', async () => {
    const h = harness({ httpStatus: 503, latencyMs: 5, body: simulationAck('MITIGATION_SIMULATION_TRIGGERED') });
    await expect(h.transport.publish(notification('MITIGATION_SIMULATION_TRIGGERED'))).resolves.toEqual({
      published: false,
      skipped: false,
    });
    expect(h.deliveries[0]).toMatchObject({ ok: false, safeError: SIMULATION_ERROR, httpStatus: 503 });
  });

  it.each([
    'MITIGATION_VERIFIED',
    'MITIGATION_REMOVED_VERIFIED',
    'MITIGATION_TRIGGERED',
    'MITIGATION_FAILED',
  ] as const)('%s continua exigindo delivered=true', async (event) => {
    const withoutDelivery = harness(ok({ received: true, routed: false, delivered: false }));
    const notRouted = harness(ok({ ok: true, received: true, routed: false, delivered: false }));
    for (const h of [withoutDelivery, notRouted]) {
      await expect(h.transport.publish(notification(event))).resolves.toEqual({
        published: false,
        skipped: false,
      });
      expect(h.deliveries[0]).toMatchObject({ ok: false, safeError: DELIVERY_ERROR });
    }
    const delivered = harness(ok({ ok: true, received: true, routed: true, delivered: true }));
    await expect(delivered.transport.publish(notification(event))).resolves.toEqual({
      published: true,
      skipped: false,
    });
  });

  it('MITIGATION_DETECTION_BLOCKED continua exigindo delivered=true', async () => {
    const simulationLike = harness(ok({ received: true, routed: false, delivered: false }));
    await expect(
      simulationLike.transport.publish(notification('MITIGATION_DETECTION_BLOCKED')),
    ).resolves.toEqual({ published: false, skipped: false });
    expect(simulationLike.deliveries[0]).toMatchObject({ ok: false, safeError: DELIVERY_ERROR });

    const delivered = harness(ok({ delivered: true }));
    await expect(
      delivered.transport.publish(notification('MITIGATION_DETECTION_BLOCKED')),
    ).resolves.toEqual({ published: true, skipped: false });
  });

  it('sem requireAcknowledgement o comportamento anterior e preservado', async () => {
    const generic = harness(ok({}), { requireAcknowledgement: false });
    await expect(
      generic.transport.publish(notification('MITIGATION_SIMULATION_TRIGGERED')),
    ).resolves.toEqual({ published: true, skipped: false });
    await expect(generic.transport.publish(notification('MITIGATION_VERIFIED'))).resolves.toEqual({
      published: true,
      skipped: false,
    });
    // DETECTION_BLOCKED sempre cobrou ACK, independente da flag.
    await expect(
      generic.transport.publish(notification('MITIGATION_DETECTION_BLOCKED')),
    ).resolves.toEqual({ published: false, skipped: false });
  });

  it('retry preservado: ACK invalido seguido de ACK valido fecha SENT', async () => {
    let now = 1_000;
    let body: unknown = { received: true, routed: false, delivered: true };
    const h = harness(() => ok(body));
    const store = new MemoryAutomationStore();
    const outbox = new DurableMitigationOutbox(store, h.transport, () => now);
    await outbox.publish(notification('MITIGATION_SIMULATION_TRIGGERED'));
    await outbox.drain();
    let [row] = await store.transaction((tx) => tx.list<OutboxEntry>('outbox'));
    expect(row?.state).toBe('PENDING');
    expect(row?.attempts).toBe(1);

    now += 30_000;
    body = simulationAck('MITIGATION_SIMULATION_TRIGGERED');
    await outbox.drain();
    [row] = await store.transaction((tx) => tx.list<OutboxEntry>('outbox'));
    expect(row?.state).toBe('SENT');
    expect(row?.attempts).toBe(2);
    expect(h.attempts).toEqual([
      'MITIGATION_SIMULATION_TRIGGERED',
      'MITIGATION_SIMULATION_TRIGGERED',
    ]);
  });
});
