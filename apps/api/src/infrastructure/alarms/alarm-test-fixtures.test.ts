import { describe, expect, it } from 'vitest';
import { NETWORK_ALARM_TEST_DEFAULT_SEVERITY, resolveNetworkAlarmTestSelection } from '@gmj/shared';
import { buildNetworkAlarmTestAlarm } from './alarm-test-fixtures';

const NOW = new Date('2026-10-08T14:00:00.000Z');

describe('fixtures sinteticas do TESTAR ALARME', () => {
  it('usa o equipamento/interface de teste e nunca um ruleId real', () => {
    const alarm = buildNetworkAlarmTestAlarm({ type: 'INTERFACE_DOWN', event: 'OPENED' }, NOW);
    expect(alarm).toMatchObject({
      id: 'TEST-NETVISION',
      deviceId: 'test-device',
      deviceName: 'NETVISION-TEST',
      interfaceId: 'test-interface',
      type: 'INTERFACE_DOWN',
      severity: 'CRITICAL',
      ruleId: null,
      endedAt: null,
      acknowledgedAt: null,
      linkId: null,
      linkLabel: null,
      metadata: null,
    });
    expect(alarm.startedAt).toBe(NOW.toISOString());
  });

  it('INTERFACE_CRC preenche metrica, direcao e interface de backbone', () => {
    const alarm = buildNetworkAlarmTestAlarm({ type: 'INTERFACE_CRC', event: 'OPENED' }, NOW);
    expect(alarm).toMatchObject({
      interfaceName: '100GE0/0/2',
      interfaceLabel: 'BACKBONE-TEST',
      metricKey: 'crc_rx',
      currentValue: 18,
      thresholdValue: 10,
      unit: 'errors/min',
      message: 'Teste de CRC/FCS do GMJ NetVision',
      metadata: { direction: 'RX' },
    });
  });

  it('INTERFACE_DISCARDS usa a direcao BOTH da regra', () => {
    const alarm = buildNetworkAlarmTestAlarm({ type: 'INTERFACE_DISCARDS', event: 'OPENED' }, NOW);
    expect(alarm).toMatchObject({
      metricKey: 'discards_rx_tx',
      currentValue: 35,
      thresholdValue: 20,
      unit: 'discards/min',
      metadata: { direction: 'BOTH' },
    });
  });

  it('INTERFACE_ERRORS usa inErrors RX', () => {
    const alarm = buildNetworkAlarmTestAlarm({ type: 'INTERFACE_ERRORS', event: 'OPENED' }, NOW);
    expect(alarm).toMatchObject({
      metricKey: 'errors_rx',
      currentValue: 24,
      thresholdValue: 10,
      unit: 'errors/min',
      severity: 'MAJOR',
      metadata: { direction: 'RX' },
    });
  });

  it('OPTICAL_RX_DEGRADATION traz lane, potencia e limites DEVICE', () => {
    const alarm = buildNetworkAlarmTestAlarm(
      { type: 'OPTICAL_RX_DEGRADATION', event: 'OPENED' },
      NOW,
    );
    expect(alarm).toMatchObject({
      type: 'OPTICAL_RX_DEGRADATION',
      severity: 'MAJOR',
      currentValue: -18.7,
      thresholdValue: -21.48,
      unit: 'dBm',
      metadata: {
        lane: 2,
        rxPowerDbm: -18.7,
        rxLowAlarmDbm: -21.48,
        rxHighAlarmDbm: -2.5,
        proximityPercent: 92,
        trendDropDb: 3.4,
        trendWindowMinutes: 30,
        triggerReasons: ['PROXIMITY', 'RAPID_DROP'],
        currentPowerSource: 'SNMP',
        thresholdSource: 'DEVICE',
      },
    });
  });

  it('ESCALATED informa a severidade anterior e nao resolve o alarme', () => {
    expect(
      buildNetworkAlarmTestAlarm({ type: 'INTERFACE_CRC', event: 'ESCALATED', severity: 'WARNING' }, NOW)
        .notifiedSeverity,
    ).toBe('INFO');
    expect(
      buildNetworkAlarmTestAlarm({ type: 'INTERFACE_CRC', event: 'ESCALATED', severity: 'MAJOR' }, NOW)
        .notifiedSeverity,
    ).toBe('WARNING');
    const critical = buildNetworkAlarmTestAlarm(
      { type: 'INTERFACE_CRC', event: 'ESCALATED', severity: 'CRITICAL' },
      NOW,
    );
    expect(critical.notifiedSeverity).toBe('MAJOR');
    expect(critical.endedAt).toBeNull();
  });

  it('RESOLVED encerra no mesmo instante e troca a mensagem, mantendo o contexto', () => {
    const alarm = buildNetworkAlarmTestAlarm({ type: 'INTERFACE_CRC', event: 'RESOLVED' }, NOW);
    expect(alarm.endedAt).toBe(NOW.toISOString());
    expect(alarm.message).toBe('Teste de resolução de alarme do GMJ NetVision');
    expect(alarm.metricKey).toBe('crc_rx');
    expect(alarm.notifiedSeverity).toBeNull();
  });

  it('OPENED nao traz endedAt nem severidade anterior', () => {
    const alarm = buildNetworkAlarmTestAlarm({ type: 'INTERFACE_ERRORS', event: 'OPENED' }, NOW);
    expect(alarm.endedAt).toBeNull();
    expect(alarm.notifiedSeverity).toBeNull();
    expect(alarm.message).toBe('Teste de erros de interface do GMJ NetVision');
  });
});

describe('defaults do simulador', () => {
  it('sem selecao usa INTERFACE_DOWN / OPENED / CRITICAL', () => {
    expect(resolveNetworkAlarmTestSelection(undefined)).toEqual({
      type: 'INTERFACE_DOWN',
      event: 'OPENED',
      severity: 'CRITICAL',
    });
  });

  it('a severidade default acompanha o tipo escolhido', () => {
    for (const [type, severity] of Object.entries(NETWORK_ALARM_TEST_DEFAULT_SEVERITY)) {
      expect(resolveNetworkAlarmTestSelection({ type: type as never }).severity).toBe(severity);
    }
  });

  it('valores fora do contrato caem no default em vez de vazar para o payload', () => {
    expect(
      resolveNetworkAlarmTestSelection({
        type: 'INTERFACE_BOGUS' as never,
        event: 'NOPE' as never,
        severity: 'BLOCKER' as never,
      }),
    ).toEqual({ type: 'INTERFACE_DOWN', event: 'OPENED', severity: 'CRITICAL' });
  });
});
