import { describe, expect, it, vi } from 'vitest';
import type { Alarm } from '@gmj/shared';
import { N8nAlarmTransport, NETWORK_ALARM_EVENT_KEY } from '../alarms/n8n-alarm-transport';
import type { MediaChannelPort, WebhookDeliverySender } from './n8n-media-transport';
import { UNAVAILABLE_ALARM_CHART, type AlarmChartMedia } from './alarm-chart-snapshot';

const NOW = new Date('2026-10-08T18:00:00.000Z');

const CHART: AlarmChartMedia = {
  available: true,
  url: 'https://netvision.example/media/snapshot/abc.png',
  mimeType: 'image/png',
  period: '15m',
  generatedAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + 900_000).toISOString(),
};

function alarm(): Alarm {
  return {
    id: 'alarm-1',
    ruleId: 'rule-1',
    type: 'INTERFACE_CRC',
    severity: 'CRITICAL',
    status: 'OPEN',
    deviceId: 'dev-1',
    deviceName: 'CEM-CEN-6730-MPLS-01',
    interfaceId: 'if-1',
    interfaceName: '100GE0/0/1',
    interfaceLabel: 'TESTE',
    linkId: null,
    linkLabel: null,
    metricKey: 'crc_rx',
    currentValue: 18,
    thresholdValue: 10,
    unit: 'errors/min',
    message: 'CRC alto',
    startedAt: NOW.toISOString(),
    endedAt: null,
    acknowledgedAt: null,
    notifiedSeverity: null,
    metadata: null,
  } as unknown as Alarm;
}

function harness(options: { chart?: ((payload: unknown) => Promise<AlarmChartMedia>) | undefined } = {}) {
  const state: { channel: { enabled: boolean; url: string | null; token: string | null; integrationId: string } } = {
    channel: { enabled: true, url: 'https://n8n.example/webhook/alarmes', token: 'tk', integrationId: 'media-1' },
  };
  const media = {
    resolveOutbound: vi.fn(async () => state.channel),
    recordOutboundAttempt: vi.fn(async () => undefined),
    recordOutboundDelivery: vi.fn(async () => undefined),
  };
  const sent: Array<Record<string, unknown>> = [];
  const send: WebhookDeliverySender = async (_url, payload) => {
    sent.push(payload as Record<string, unknown>);
    return { httpStatus: 200, latencyMs: 12 };
  };
  const transport = new N8nAlarmTransport({
    media: media as unknown as MediaChannelPort,
    send,
    now: () => NOW,
    ...(options.chart ? { chartSnapshot: options.chart as never } : {}),
  });
  return { transport, media, sent, state };
}

describe('snapshot do grÃ¡fico no transporte NETWORK_ALARMS', () => {
  it('alarme REAL leva media.chart com URL assinada e segue registrando a entrega', async () => {
    const { transport, media, sent } = harness({ chart: async () => CHART });
    const outcome = await transport.publish(NETWORK_ALARM_EVENT_KEY.OPENED, alarm());
    expect(outcome.ok).toBe(true);
    expect(sent[0]?.media).toEqual({ chart: { ...CHART, reason: undefined } });
    expect(sent[0]?.media).not.toHaveProperty('chart.bytes');
    expect(media.recordOutboundDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, httpStatus: 200 }),
    );
  });

  it('falha do snapshot NUNCA perde o alarme: payload sai sem media e a entrega continua', async () => {
    const { transport, sent } = harness({
      chart: async () => {
        throw new Error('renderer caiu');
      },
    });
    const outcome = await transport.publish(NETWORK_ALARM_EVENT_KEY.OPENED, alarm());
    expect(outcome.ok).toBe(true);
    expect(sent[0]).not.toHaveProperty('media');
  });

  it('sem renderer configurado o payload nÃ£o muda (compatibilidade do n8n)', async () => {
    const { transport, sent } = harness();
    await transport.publish(NETWORK_ALARM_EVENT_KEY.OPENED, alarm());
    expect(sent[0]).not.toHaveProperty('media');
  });

  it('TESTAR ALARME com INCLUIR GRÃFICO off nÃ£o chama o renderer (default)', async () => {
    const chart = vi.fn(async () => CHART);
    const { transport, sent } = harness({ chart });
    await transport.publishAlarmTest({ profileId: 'media-1', type: 'INTERFACE_CRC', event: 'OPENED' });
    expect(chart).not.toHaveBeenCalled();
    expect(sent[0]).not.toHaveProperty('media');
    expect(sent[0]?.test).toBe(true);
    expect(sent[0]?.eventKey).toBe('NETWORK_ALARM_TEST');
  });

  it('TESTAR ALARME com INCLUIR GRÃFICO on usa o MESMO builder e anexa media.chart', async () => {
    const chart = vi.fn(async () => CHART);
    const { transport, sent } = harness({ chart });
    await transport.publishAlarmTest({
      profileId: 'media-1',
      type: 'INTERFACE_CRC',
      event: 'OPENED',
      includeChart: true,
    });
    expect(chart).toHaveBeenCalledTimes(1);
    expect(sent[0]?.purpose).toBe('NETWORK_ALARMS');
    expect(sent[0]?.test).toBe(true);
    expect(sent[0]?.eventKey).toBe('NETWORK_ALARM_TEST');
    expect(sent[0]?.media).toMatchObject({ chart: { available: true, mimeType: 'image/png' } });
  });

  it('tipo sem sÃ©rie (INTERFACE_DOWN) nem tenta renderizar, mesmo com grÃ¡fico ligado', async () => {
    const chart = vi.fn(async () => CHART);
    const { transport, sent } = harness({ chart });
    await transport.publishAlarmTest({ profileId: 'media-1', type: 'INTERFACE_DOWN', includeChart: true });
    expect(chart).not.toHaveBeenCalled();
    expect(sent[0]).not.toHaveProperty('media');
  });

  it('canal desabilitado => SKIPPED registrado e nenhum render desperdiÃ§ado', async () => {
    const chart = vi.fn(async () => CHART);
    const { transport, state } = harness({ chart });
    state.channel = { enabled: false, url: null, token: null, integrationId: 'media-1' };
    const outcome = await transport.publish(NETWORK_ALARM_EVENT_KEY.OPENED, alarm());
    expect(outcome).toMatchObject({ ok: false, skipped: true });
    expect(chart).not.toHaveBeenCalled();
  });

  it('render indisponÃ­vel (available=false) nÃ£o injeta bloco vazio no payload', async () => {
    const { transport, sent } = harness({
      chart: async () => ({ ...UNAVAILABLE_ALARM_CHART, reason: 'snapshot desabilitado' }),
    });
    await transport.publish(NETWORK_ALARM_EVENT_KEY.OPENED, alarm());
    expect(sent[0]).not.toHaveProperty('media');
  });

  it('RESOLVED e ESCALATED usam o mesmo caminho com snapshot', async () => {
    const { transport, sent } = harness({ chart: async () => CHART });
    await transport.publish(NETWORK_ALARM_EVENT_KEY.ESCALATED, alarm());
    await transport.publish(NETWORK_ALARM_EVENT_KEY.RESOLVED, alarm());
    expect(sent).toHaveLength(2);
    expect(sent[0]?.event).toBe('ESCALATED');
    expect(sent[1]?.event).toBe('RESOLVED');
    for (const payload of sent) {
      expect(payload.media).toMatchObject({ chart: { available: true } });
    }
  });
});
