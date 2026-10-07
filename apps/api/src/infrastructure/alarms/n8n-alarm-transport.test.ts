import { describe, expect, it, vi } from 'vitest';
import type { Alarm } from '@gmj/shared';
import { WebhookDeliveryError, type MediaChannelPort } from '../media/n8n-media-transport';
import {
  N8nAlarmTransport,
  buildNetworkAlarmWebhookPayload,
} from './n8n-alarm-transport';

const NOW = new Date('2026-10-07T12:00:00.000Z');

const OPTICAL_ALARM: Alarm = {
  id: 'alarm-1',
  deviceId: 'dev-1',
  deviceName: 'F1A',
  interfaceId: 'if-1',
  interfaceName: '100GE0/0/2',
  interfaceLabel: 'CLIENTE-X',
  ifIndex: 1,
  linkId: 'link-1',
  linkLabel: 'BHE-LIKEE-6730',
  type: 'OPTICAL_RX_DEGRADATION',
  severity: 'MAJOR',
  startedAt: NOW.toISOString(),
  endedAt: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  message: 'F1A: CLIENTE-X (100GE0/0/2) — RX optico com proximidade 96%',
  ruleId: 'rule-1',
  metricKey: 'RX_LANE_2',
  currentValue: 96.15,
  thresholdValue: 95,
  unit: '%',
  metadata: {
    direction: 'RX',
    lane: 2,
    rxPowerDbm: -13.5,
    rxLowAlarmDbm: -14,
    rxHighAlarmDbm: -1,
    marginDb: 0.5,
    proximityPercent: 96.15,
    trendDropDb: 1.2,
    trendWindowMinutes: 30,
    triggerReasons: ['RAPID_DROP', 'PROXIMITY'],
    currentPowerSource: 'SNMP',
    thresholdSource: 'DEVICE',
    speedBps: 100_000_000_000,
  },
};

const PAYLOAD_KEYS = [
  'alarmId',
  'currentPowerSource',
  'currentValue',
  'deviceId',
  'deviceName',
  'direction',
  'event',
  'interfaceId',
  'interfaceLabel',
  'interfaceName',
  'lane',
  'linkId',
  'linkLabel',
  'marginDb',
  'proximityPercent',
  'resolvedAt',
  'ruleId',
  'rxHighAlarmDbm',
  'rxLowAlarmDbm',
  'rxPowerDbm',
  'severity',
  'speedBps',
  'startedAt',
  'thresholdSource',
  'thresholdValue',
  'trendDropDb',
  'trendWindowMinutes',
  'triggerReasons',
  'type',
  'unit',
].sort();

function channel(overrides: Record<string, unknown> = {}) {
  return {
    integrationId: 'media-1',
    source: 'DATABASE' as const,
    enabled: true,
    url: 'https://n8n.exemplo.com/webhook/abc?token=nao-pode-vazar',
    token: 'token-secreto-123',
    resolvedPurpose: 'BGP_MITIGATION' as const,
    shared: true,
    ...overrides,
  };
}

function build(options: {
  channel?: ReturnType<typeof channel>;
  send?: ReturnType<typeof vi.fn>;
} = {}) {
  const resolveOutbound = vi.fn().mockResolvedValue(options.channel ?? channel());
  const recordOutboundAttempt = vi.fn().mockResolvedValue(undefined);
  const recordOutboundDelivery = vi.fn().mockResolvedValue(undefined);
  const send = options.send
    ?? vi.fn().mockResolvedValue({ httpStatus: 200, latencyMs: 25 });
  const media = {
    resolveOutbound,
    recordOutboundAttempt,
    recordOutboundDelivery,
  } as unknown as MediaChannelPort;
  return {
    transport: new N8nAlarmTransport({ media, send }),
    resolveOutbound,
    recordOutboundAttempt,
    recordOutboundDelivery,
    send,
  };
}

describe('transporte de midia dos alarmes (NETWORK_ALARMS)', () => {
  it('monta o payload whitelist exato e nunca inclui segredo', () => {
    const payload = buildNetworkAlarmWebhookPayload(OPTICAL_ALARM, 'NETWORK_ALARM_ESCALATED');
    expect(Object.keys(payload).sort()).toEqual(PAYLOAD_KEYS);
    expect(payload).toMatchObject({
      event: 'NETWORK_ALARM_ESCALATED',
      alarmId: 'alarm-1',
      ruleId: 'rule-1',
      type: 'OPTICAL_RX_DEGRADATION',
      severity: 'MAJOR',
      deviceId: 'dev-1',
      deviceName: 'F1A',
      interfaceId: 'if-1',
      interfaceName: '100GE0/0/2',
      interfaceLabel: 'CLIENTE-X',
      speedBps: 100_000_000_000,
      linkId: 'link-1',
      linkLabel: 'BHE-LIKEE-6730',
      direction: 'RX',
      lane: 2,
      currentValue: 96.15,
      thresholdValue: 95,
      unit: '%',
      rxPowerDbm: -13.5,
      rxLowAlarmDbm: -14,
      rxHighAlarmDbm: -1,
      marginDb: 0.5,
      proximityPercent: 96.15,
      trendDropDb: 1.2,
      trendWindowMinutes: 30,
      triggerReasons: ['RAPID_DROP', 'PROXIMITY'],
      currentPowerSource: 'SNMP',
      thresholdSource: 'DEVICE',
      startedAt: NOW.toISOString(),
      resolvedAt: null,
    });
    const serialized = JSON.stringify(payload);
    for (const forbidden of ['community', 'password', 'DATABASE_URL', 'token', 'secret', 'ssh']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('resolve NETWORK_ALARMS com fallback no canal BGP e envia o token em header', async () => {
    const built = build();
    const outcome = await built.transport.publish('NETWORK_ALARM_OPENED', OPTICAL_ALARM);
    expect(outcome).toMatchObject({ ok: true, skipped: false, httpStatus: 200 });
    expect(built.resolveOutbound).toHaveBeenCalledWith('NETWORK_ALARMS', 'BGP_MITIGATION');
    const [, payload, headers] = built.send.mock.calls[0] as [string, object, Record<string, string>];
    expect(headers['X-NetVision-Token']).toBe('token-secreto-123');
    expect(JSON.stringify(payload)).not.toContain('token-secreto-123');
    expect(built.recordOutboundAttempt).toHaveBeenCalledWith(expect.objectContaining({
      integrationId: 'media-1',
      event: 'NETWORK_ALARM_OPENED',
      profileId: 'rule-1',
      requestId: 'alarm-1',
      destination: 'https://n8n.exemplo.com',
    }));
    expect(built.recordOutboundDelivery).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      httpStatus: 200,
      latencyMs: 25,
      safeError: null,
    }));
  });

  it('canal inexistente vira SKIPPED registrado no log sem chamar o sender', async () => {
    const built = build({
      channel: channel({ enabled: false, url: null, token: null, integrationId: null }),
    });
    const outcome = await built.transport.publish('NETWORK_ALARM_RESOLVED', {
      ...OPTICAL_ALARM,
      endedAt: NOW.toISOString(),
    });
    expect(outcome).toMatchObject({ ok: false, skipped: true, safeError: 'Webhook não configurado' });
    expect(built.send).not.toHaveBeenCalled();
    expect(built.recordOutboundDelivery).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      safeError: 'Webhook não configurado',
    }));
  });

  it('falha HTTP devolve ok:false com status/destino seguros', async () => {
    const send = vi.fn().mockRejectedValue(
      new WebhookDeliveryError('HTTP 500', 500, 18, 'Webhook respondeu HTTP 500'),
    );
    const built = build({ send });
    const outcome = await built.transport.publish('NETWORK_ALARM_OPENED', OPTICAL_ALARM);
    expect(outcome).toMatchObject({
      ok: false,
      skipped: false,
      httpStatus: 500,
      latencyMs: 18,
      safeError: 'Webhook respondeu HTTP 500',
    });
    expect(built.recordOutboundDelivery).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      httpStatus: 500,
      destination: 'https://n8n.exemplo.com',
    }));
  });
});
