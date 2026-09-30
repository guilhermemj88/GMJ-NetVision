import { describe, expect, it, vi } from 'vitest';
import {
  buildMitigationWebhookPayload,
  createWebhookNotificationPublisher,
  type MitigationWebhookPayload,
} from './mitigation-webhook';
import type { MitigationNotification } from './notification-publisher';

const notification: MitigationNotification = {
  event: 'MITIGATION_VERIFIED',
  simulation: true,
  customer: 'HORIZONTE_IP',
  device: 'BHE-VTA-F1A-BGP-01',
  interfaceName: 'Eth-Trunk1.3011',
  peer: '10.200.200.106',
  affectedPeers: ['10.200.200.10', '10.200.200.106'],
  detectedBandwidthBps: 40_000_000_000n,
  bandwidthOverrideBps: null,
  effectiveBandwidthBps: 40_000_000_000n,
  trafficBps: 38_700_000_000n,
  thresholdBps: 36_000_000_000n,
  policy: 'PL-HORIZONTES_IPv4-IN',
  node: 1,
  rt: '268568:660',
  verified: true,
  eventId: 'evt-1',
  profileId: 'profile-1',
  addressFamily: 'IPV4',
  sharedPolicy: true,
  sharedPolicyTargets: [
    {
      interfaceName: 'Eth-Trunk1.3013',
      peerAddress: '10.200.200.10',
      customer: 'HORIZONTE_IP_02',
      addressFamily: 'IPV4',
    },
  ],
  occurredAt: '2026-01-01T12:00:00.000Z',
};

describe('canal OUT (NetVision -> n8n)', () => {
  it('payload traz os campos novos e preserva os antigos', () => {
    const payload = buildMitigationWebhookPayload(notification);

    // campos antigos continuam identicos
    expect(payload).toMatchObject({
      event: 'MITIGATION_VERIFIED',
      simulation: true,
      customer: 'HORIZONTE_IP',
      device: 'BHE-VTA-F1A-BGP-01',
      interface: 'Eth-Trunk1.3011',
      peer: '10.200.200.106',
      policy: 'PL-HORIZONTES_IPv4-IN',
      node: 1,
      rt: '268568:660',
      bandwidthGbps: 40,
      trafficGbps: 38.7,
      thresholdGbps: 36,
      verified: true,
    });
    // campos novos
    expect(payload).toMatchObject({
      eventId: 'evt-1',
      profileId: 'profile-1',
      addressFamily: 'IPV4',
      sharedPolicy: true,
      occurredAt: '2026-01-01T12:00:00.000Z',
    });
    expect(payload.sharedPolicyTargets).toEqual([
      {
        interfaceName: 'Eth-Trunk1.3013',
        peerAddress: '10.200.200.10',
        customer: 'HORIZONTE_IP_02',
        addressFamily: 'IPV4',
      },
    ]);
    expect(payload.affectedPeers).toEqual(['10.200.200.10', '10.200.200.106']);
  });

  it('envia o token em header e NUNCA na URL', async () => {
    const send = vi.fn(async () => undefined);
    const publisher = createWebhookNotificationPublisher({
      url: 'https://n8n.example/webhook/mitigacao',
      send,
      token: 'segredo-do-outbound',
    });

    const result = await publisher.publish(notification);

    expect(result).toEqual({ published: true, skipped: false });
    expect(send).toHaveBeenCalledTimes(1);
    const [url, payload, headers] = send.mock.calls[0] as unknown as [
      string,
      MitigationWebhookPayload,
      Record<string, string>,
    ];
    expect(url).not.toContain('segredo-do-outbound');
    expect(headers['X-NetVision-Token']).toBe('segredo-do-outbound');
    expect(headers['content-type']).toBe('application/json');
    expect(payload.policy).toBe('PL-HORIZONTES_IPv4-IN');
  });

  it('sem URL configurada apenas pula (sem erro)', async () => {
    const send = vi.fn(async () => undefined);
    const publisher = createWebhookNotificationPublisher({ url: null, send, token: 'x' });

    expect(await publisher.publish(notification)).toEqual({ published: false, skipped: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('falha de rede nao afeta o motor e nao vaza o secret', async () => {
    const send = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:443 token=segredo-do-outbound');
    });
    const publisher = createWebhookNotificationPublisher({
      url: 'https://n8n.example/webhook/mitigacao',
      send,
      token: 'segredo-do-outbound',
    });

    const result = await publisher.publish(notification);

    expect(result).toEqual({ published: false, skipped: false });
    // o retorno nao carrega mensagem de erro (nem o secret)
    expect(JSON.stringify(result)).not.toContain('segredo-do-outbound');
  });

  it('config vem do ambiente (sem URL hardcoded)', async () => {
    const { mitigationConfigFromEnv } = await import('./mitigation-config');
    const config = mitigationConfigFromEnv({
      MITIGATION_N8N_WEBHOOK_URL: 'https://n8n.example/webhook',
      MITIGATION_N8N_WEBHOOK_TOKEN: 'token-x',
    });
    expect(config.n8nWebhookUrl).toBe('https://n8n.example/webhook');
    expect(config.n8nWebhookToken).toBe('token-x');

    const empty = mitigationConfigFromEnv({});
    expect(empty.n8nWebhookUrl).toBeNull();
    expect(empty.n8nWebhookToken).toBeNull();
  });
});
