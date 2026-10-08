import { describe, expect, it, vi } from 'vitest';
import type { Alarm, AlarmSeverity } from '@gmj/shared';
import type { MediaDeliveryOutcome } from '../infrastructure/media/n8n-media-transport';
import type { NetworkAlarmEvent } from '../infrastructure/alarms/n8n-alarm-transport';
import { AlarmNotificationService } from './alarm-notification-service';

const NOW = new Date('2026-10-07T12:00:00.000Z');

function alarmOf(overrides: Partial<Alarm> = {}): Alarm {
  return {
    id: 'alarm-1',
    deviceId: 'dev-1',
    deviceName: 'F1A',
    interfaceId: 'if-1',
    interfaceName: '100GE0/0/2',
    interfaceLabel: 'CLIENTE-X',
    ifIndex: 1,
    linkId: null,
    linkLabel: null,
    type: 'OPTICAL_RX_DEGRADATION',
    severity: 'WARNING',
    startedAt: NOW.toISOString(),
    endedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    message: 'RX optico com proximidade 91%',
    ruleId: 'rule-1',
    metricKey: 'RX',
    currentValue: 91,
    thresholdValue: 90,
    unit: '%',
    metadata: { direction: 'RX' },
    ...overrides,
  };
}

function ok(event: NetworkAlarmEvent): MediaDeliveryOutcome {
  return { ok: true, skipped: false, httpStatus: 200, latencyMs: 30, safeError: null, event };
}

function build(options: { now?: () => Date; publish?: ReturnType<typeof vi.fn> } = {}) {
  const publish = options.publish
    ?? vi.fn().mockImplementation(async (event: NetworkAlarmEvent) => ok(event));
  const markAlarmNotified = vi.fn().mockResolvedValue(undefined);
  const markAlarmResolutionNotified = vi.fn().mockResolvedValue(undefined);
  let current = options.now ?? (() => NOW);
  const service = new AlarmNotificationService({
    alarms: { markAlarmNotified, markAlarmResolutionNotified },
    transport: { publish },
    now: () => current(),
    retryCooldownMs: 300_000,
  });
  return {
    service,
    publish,
    markAlarmNotified,
    markAlarmResolutionNotified,
    setNow: (date: Date) => {
      current = () => date;
    },
  };
}

describe('notificacao de midia dos alarmes de rede', () => {
  it('entrega OPENED exatamente 1x por abertura e marca notifiedAt', async () => {
    const built = build();
    const alarm = alarmOf();
    await built.service.notifyOpened(alarm, { mediaEnabled: true });
    expect(built.publish).toHaveBeenCalledTimes(1);
    expect(built.publish.mock.calls[0]?.[0]).toBe('NETWORK_ALARM_OPENED');
    expect(built.markAlarmNotified).toHaveBeenCalledWith('alarm-1', {
      notifiedSeverity: 'WARNING',
      notifiedAt: NOW,
    });

    // Poll seguinte: o alarme volta do banco JA marcado -> zero envios.
    const persisted = alarmOf({ notifiedSeverity: 'WARNING', notifiedAt: NOW.toISOString() });
    await built.service.notifyOpened(persisted, { mediaEnabled: true });
    expect(built.publish).toHaveBeenCalledTimes(1);
  });

  it('entrega ESCALATED exatamente 1x por severidade nova', async () => {
    const built = build();
    await built.service.notifyEscalated(
      alarmOf({ severity: 'MAJOR', notifiedSeverity: 'WARNING', notifiedAt: NOW.toISOString() }),
      { mediaEnabled: true },
    );
    expect(built.publish).toHaveBeenCalledTimes(1);
    expect(built.publish.mock.calls[0]?.[0]).toBe('NETWORK_ALARM_ESCALATED');
    expect(built.markAlarmNotified).toHaveBeenCalledWith('alarm-1', {
      notifiedSeverity: 'MAJOR',
      notifiedAt: NOW,
    });

    await built.service.notifyEscalated(
      alarmOf({ severity: 'MAJOR', notifiedSeverity: 'MAJOR', notifiedAt: NOW.toISOString() }),
      { mediaEnabled: true },
    );
    expect(built.publish).toHaveBeenCalledTimes(1);
  });

  it('nunca rebaixa: severidade menor que a notificada nao gera evento', async () => {
    const built = build();
    await built.service.notifyEscalated(
      alarmOf({ severity: 'WARNING', notifiedSeverity: 'CRITICAL', notifiedAt: NOW.toISOString() }),
      { mediaEnabled: true },
    );
    expect(built.publish).not.toHaveBeenCalled();
  });

  it('trata escalation sem notificacao previa como abertura', async () => {
    const built = build();
    await built.service.notifyEscalated(alarmOf({ severity: 'MAJOR' }), { mediaEnabled: true });
    expect(built.publish.mock.calls[0]?.[0]).toBe('NETWORK_ALARM_OPENED');
  });

  it('entrega RESOLVED exatamente 1x', async () => {
    const built = build();
    const resolved = alarmOf({
      severity: 'MAJOR',
      endedAt: NOW.toISOString(),
      notifiedSeverity: 'MAJOR',
      notifiedAt: NOW.toISOString(),
    });
    await built.service.notifyResolved(resolved, { mediaEnabled: true });
    expect(built.publish).toHaveBeenCalledTimes(1);
    expect(built.publish.mock.calls[0]?.[0]).toBe('NETWORK_ALARM_RESOLVED');
    expect(built.markAlarmResolutionNotified).toHaveBeenCalledWith('alarm-1', NOW);

    await built.service.notifyResolved(
      { ...resolved, resolutionNotifiedAt: NOW.toISOString() },
      { mediaEnabled: true },
    );
    expect(built.publish).toHaveBeenCalledTimes(1);
  });

  it('falha de midia nao marca sucesso e respeita o cooldown com retry controlado', async () => {
    let succeed = false;
    const publish = vi.fn().mockImplementation(async (event: NetworkAlarmEvent) =>
      succeed
        ? ok(event)
        : { ok: false, skipped: false, httpStatus: 500, latencyMs: 12, safeError: 'HTTP 500', event });
    const built = build({ publish });

    await built.service.notifyOpened(alarmOf(), { mediaEnabled: true });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(built.markAlarmNotified).not.toHaveBeenCalled();

    // Dentro do cooldown: nao tenta de novo (nada de storm).
    await built.service.notifyOpened(alarmOf(), { mediaEnabled: true });
    expect(publish).toHaveBeenCalledTimes(1);

    built.setNow(new Date(NOW.getTime() + 300_001));
    succeed = true;
    await built.service.notifyOpened(alarmOf(), { mediaEnabled: true });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(built.markAlarmNotified).toHaveBeenCalledTimes(1);
  });

  it('midia desligada marca como tratado sem enviar nada', async () => {
    const built = build();
    await built.service.notifyOpened(alarmOf(), { mediaEnabled: false });
    expect(built.publish).not.toHaveBeenCalled();
    expect(built.markAlarmNotified).toHaveBeenCalledWith('alarm-1', {
      notifiedSeverity: 'WARNING',
      notifiedAt: NOW,
    });
  });

  it('canal inexistente (skip) tambem marca como tratado', async () => {
    const publish = vi.fn().mockImplementation(async (event: NetworkAlarmEvent) => ({
      ok: false, skipped: true, httpStatus: null, latencyMs: null, safeError: 'Webhook não configurado', event,
    }));
    const built = build({ publish });
    await built.service.notifyOpened(alarmOf({ severity: 'CRITICAL' as AlarmSeverity }), {
      mediaEnabled: true,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(built.markAlarmNotified).toHaveBeenCalledWith('alarm-1', {
      notifiedSeverity: 'CRITICAL',
      notifiedAt: NOW,
    });
  });
});
