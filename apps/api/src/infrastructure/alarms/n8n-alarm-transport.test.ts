import { describe, expect, it, vi } from 'vitest';
import type { Alarm } from '@gmj/shared';
import { WebhookDeliveryError, type MediaChannelPort } from '../media/n8n-media-transport';
import {
  N8nAlarmTransport,
  buildNetworkAlarmTestAlarm,
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
  'device',
  'deviceId',
  'deviceName',
  'direction',
  'event',
  'eventKey',
  'interface',
  'interfaceId',
  'interfaceLabel',
  'interfaceName',
  'lane',
  'linkId',
  'linkLabel',
  'marginDb',
  'message',
  'metricKey',
  'optical',
  'occurredAt',
  'proximityPercent',
  'purpose',
  'resolvedAt',
  'ruleId',
  'rxHighAlarmDbm',
  'rxLowAlarmDbm',
  'rxPowerDbm',
  'schemaVersion',
  'severity',
  'speedBps',
  'startedAt',
  'test',
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
    integrationId: 'media-2',
    source: 'DATABASE' as const,
    enabled: true,
    url: 'https://n8n.exemplo.com/webhook/alarmes?token=nao-pode-vazar',
    token: 'token-alarmes-123',
    resolvedPurpose: 'NETWORK_ALARMS' as const,
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
    transport: new N8nAlarmTransport({ media, send, now: () => NOW }),
    media,
    resolveOutbound,
    recordOutboundAttempt,
    recordOutboundDelivery,
    send,
  };
}

describe('transporte de midia dos alarmes (NETWORK_ALARMS)', () => {
  it('monta o payload whitelist exato com o bloco canonico e nunca inclui segredo', () => {
    const payload = buildNetworkAlarmWebhookPayload(OPTICAL_ALARM, 'NETWORK_ALARM_ESCALATED');
    expect(Object.keys(payload).sort()).toEqual(PAYLOAD_KEYS);
    expect(payload).toMatchObject({
      schemaVersion: 1,
      purpose: 'NETWORK_ALARMS',
      event: 'ESCALATED',
      eventKey: 'NETWORK_ALARM_ESCALATED',
      test: false,
      alarmId: 'alarm-1',
      message: 'F1A: CLIENTE-X (100GE0/0/2) — RX optico com proximidade 96%',
      device: { id: 'dev-1', name: 'F1A' },
      interface: { id: 'if-1', name: '100GE0/0/2', alias: 'CLIENTE-X' },
      metricKey: 'RX_LANE_2',
      optical: {
        lane: 2,
        rxPowerDbm: -13.5,
        lowThresholdDbm: -14,
        highThresholdDbm: -1,
        proximityPercent: 96.15,
        dropDb: 1.2,
        dropWindowMinutes: 30,
        triggerReasons: ['RAPID_DROP', 'PROXIMITY'],
      },
      occurredAt: NOW.toISOString(),
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

  it('alarme nao-optico nao inventa bloco optical', () => {
    const payload = buildNetworkAlarmWebhookPayload(
      { ...OPTICAL_ALARM, type: 'INTERFACE_DOWN', metadata: null },
      'NETWORK_ALARM_OPENED',
    );
    expect(payload.optical).toBeNull();
    expect(payload.event).toBe('OPENED');
    expect(payload.lane).toBeNull();
  });

  it('resolve SOMENTE NETWORK_ALARMS e envia o token em header', async () => {
    const built = build();
    const outcome = await built.transport.publish('NETWORK_ALARM_OPENED', OPTICAL_ALARM);
    expect(outcome).toMatchObject({ ok: true, skipped: false, httpStatus: 200 });
    expect(built.resolveOutbound).toHaveBeenCalledWith('NETWORK_ALARMS');
    expect(built.resolveOutbound).not.toHaveBeenCalledWith('NETWORK_ALARMS', 'BGP_MITIGATION');
    const [, payload, headers] = built.send.mock.calls[0] as [string, object, Record<string, string>];
    expect(headers['X-NetVision-Token']).toBe('token-alarmes-123');
    expect(JSON.stringify(payload)).not.toContain('token-alarmes-123');
    expect(built.recordOutboundAttempt).toHaveBeenCalledWith(expect.objectContaining({
      integrationId: 'media-2',
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

describe('TESTAR ALARME (NETWORK_ALARMS)', () => {
  it('envia pelo canal NETWORK_ALARMS e nunca pela mitigacao', async () => {
    const built = build();
    const outcome = await built.transport.publishAlarmTest({ profileId: 'media-2' });

    expect(outcome).toMatchObject({ ok: true, skipped: false, event: 'NETWORK_ALARM_TEST' });
    expect(built.resolveOutbound).toHaveBeenCalledTimes(1);
    expect(built.resolveOutbound).toHaveBeenCalledWith('NETWORK_ALARMS');
    const [url, payload, headers] = built.send.mock.calls[0] as [string, Record<string, unknown>, Record<string, string>];
    expect(url).toBe('https://n8n.exemplo.com/webhook/alarmes?token=nao-pode-vazar');
    expect(headers['X-NetVision-Token']).toBe('token-alarmes-123');
    expect(payload).toMatchObject({
      schemaVersion: 1,
      purpose: 'NETWORK_ALARMS',
      event: 'OPENED',
      test: true,
      alarmId: 'TEST-NETVISION',
      severity: 'CRITICAL',
      type: 'INTERFACE_DOWN',
      message: 'Teste de alarme do GMJ NetVision',
      device: { id: 'test-device', name: 'NETVISION-TEST' },
      interface: { id: 'test-interface', name: '100GE0/0/1', alias: 'TESTE-WEBHOOK' },
      optical: null,
    });
    expect(payload.occurredAt).toBe(NOW.toISOString());
    expect(JSON.stringify(payload)).not.toContain('token-alarmes-123');
  });

  it('registra NETWORK_ALARM_TEST no log da propria integracao', async () => {
    const built = build();
    await built.transport.publishAlarmTest({ profileId: 'media-2' });
    expect(built.recordOutboundAttempt).toHaveBeenCalledWith(expect.objectContaining({
      integrationId: 'media-2',
      event: 'NETWORK_ALARM_TEST',
      profileId: 'media-2',
      requestId: 'TEST-NETVISION',
    }));
    expect(built.recordOutboundDelivery).toHaveBeenCalledWith(expect.objectContaining({
      event: 'NETWORK_ALARM_TEST',
      ok: true,
      httpStatus: 200,
      latencyMs: 25,
    }));
  });

  it('config ausente devolve SKIPPED/NOT_CONFIGURED sem chamar a rede', async () => {
    const built = build({ channel: channel({ enabled: false, url: null, token: null, integrationId: null }) });
    const outcome = await built.transport.publishAlarmTest();
    expect(outcome).toMatchObject({
      ok: false,
      skipped: true,
      safeError: 'Webhook não configurado',
      event: 'NETWORK_ALARM_TEST',
    });
    expect(built.send).not.toHaveBeenCalled();
  });

  it('HTTP 500 devolve FAILED com erro seguro', async () => {
    const send = vi.fn().mockRejectedValue(
      new WebhookDeliveryError('HTTP 500', 500, 12, 'Webhook respondeu HTTP 500'),
    );
    const built = build({ send });
    const outcome = await built.transport.publishAlarmTest();
    expect(outcome).toMatchObject({ ok: false, skipped: false, httpStatus: 500, latencyMs: 12 });
    expect(built.recordOutboundDelivery).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      httpStatus: 500,
      safeError: 'Webhook respondeu HTTP 500',
    }));
  });

  it('timeout devolve erro seguro, sem stack nem token', async () => {
    const send = vi.fn().mockRejectedValue(
      new WebhookDeliveryError('timeout', null, 10_000, 'Timeout ao chamar o webhook'),
    );
    const built = build({ send });
    const outcome = await built.transport.publishAlarmTest();
    expect(outcome.safeError).toBe('Timeout ao chamar o webhook');
    expect(JSON.stringify(outcome)).not.toContain('token-alarmes-123');
  });

  it('o alarme sintetico nao e persistido: o transporte so fala com a camada de midias', async () => {
    const alarm = buildNetworkAlarmTestAlarm(NOW);
    expect(alarm).toMatchObject({ id: 'TEST-NETVISION', endedAt: null, ruleId: null });

    const built = build();
    await built.transport.publishAlarmTest();
    // A porta de midias nao possui nenhum metodo de alarme/ocorrencia: se o
    // teste tentasse criar row, o proprio mock quebraria.
    const portMethods = Object.keys(built.media);
    expect(portMethods.sort()).toEqual(['recordOutboundAttempt', 'recordOutboundDelivery', 'resolveOutbound']);
  });
});
