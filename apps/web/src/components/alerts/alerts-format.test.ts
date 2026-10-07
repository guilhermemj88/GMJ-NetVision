import { describe, expect, it } from 'vitest';
import type { AlertCenterItem } from '@gmj/shared';
import {
  alertAckText,
  alertAgeText,
  alertCanAcknowledge,
  alertCategoryBadge,
  alertSeverityLabel,
  alertSeverityTone,
  alertStateText,
  alertStateTone,
  alertTimelineText,
} from './alerts-format';

const NOW = new Date('2026-10-12T12:00:00.000Z').getTime();
const HOUR = 60 * 60 * 1000;

function item(patch: Partial<AlertCenterItem> = {}): AlertCenterItem {
  return {
    id: 'alarm-1',
    category: 'ALARM',
    state: 'ACTIVE_UNACKNOWLEDGED',
    severity: 'CRITICAL',
    type: 'INTERFACE_DOWN',
    typeLabel: 'LINK DOWN',
    deviceId: 'dev-1',
    deviceName: 'RNS-FLOR-6730-MPLS-01',
    deviceHostname: null,
    site: null,
    interfaceId: 'iface-1',
    interfaceName: '100GE0/0/2',
    interfaceAlias: null,
    interfaceLabel: null,
    ifIndex: 1,
    startedAt: new Date(NOW - 2 * HOUR).toISOString(),
    lastSeenAt: new Date(NOW - HOUR).toISOString(),
    endedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    valueSummary: 'DOWN',
    mapIds: [],
    ...patch,
  };
}

describe('tom e rotulo de estado', () => {
  it('diferencia ativo, reconhecido, resolvido e suprimido', () => {
    expect(alertStateTone('ACTIVE_UNACKNOWLEDGED')).toBe('critical');
    expect(alertStateTone('ACTIVE_ACKNOWLEDGED')).toBe('ack');
    expect(alertStateTone('RESOLVED')).toBe('resolved');
    expect(alertStateTone('SUPPRESSED')).toBe('suppressed');
    expect(alertStateTone('QUIET_24H')).toBe('suppressed');
    expect(alertStateText('UNACKNOWLEDGED')).toBe('NOVO');
    expect(alertStateText('SUPPRESSED')).toBe('SUPRIMIDO');
  });

  it('ACK nao vira resolvido na apresentacao', () => {
    expect(alertStateText('ACTIVE_ACKNOWLEDGED')).toBe('ACK');
    expect(alertStateTone('ACTIVE_ACKNOWLEDGED')).not.toBe('resolved');
  });
});

describe('severidade e categoria', () => {
  it('mapeia severidade real do alarme', () => {
    expect(alertSeverityTone('CRITICAL')).toBe('critical');
    expect(alertSeverityTone('MAJOR')).toBe('major');
    expect(alertSeverityTone('WARNING')).toBe('warning');
    expect(alertSeverityTone('INFO')).toBe('info');
    expect(alertSeverityLabel('CRITICAL')).toBe('CRIT');
    expect(alertSeverityLabel(null)).toBeNull();
  });

  it('ocorrencia nao ganha severidade: usa badge de categoria', () => {
    const occurrence = item({ category: 'OCCURRENCE', severity: null, state: 'UNACKNOWLEDGED' });
    expect(alertSeverityTone(occurrence.severity)).toBeNull();
    expect(alertCategoryBadge(occurrence)).toBe('OCORRÊNCIA');
    expect(alertCategoryBadge(item())).toBe('ALARME');
  });
});

describe('quem pode ser reconhecido', () => {
  it('alarme ativo nao reconhecido e ocorrencia pendente', () => {
    expect(alertCanAcknowledge(item())).toBe(true);
    expect(
      alertCanAcknowledge(item({ category: 'OCCURRENCE', severity: null, state: 'UNACKNOWLEDGED' })),
    ).toBe(true);
  });

  it('item ja reconhecido ou resolvido nao e selecionavel', () => {
    expect(
      alertCanAcknowledge(
        item({ state: 'ACTIVE_ACKNOWLEDGED', acknowledgedAt: new Date(NOW).toISOString() }),
      ),
    ).toBe(false);
    expect(alertCanAcknowledge(item({ state: 'RESOLVED', endedAt: new Date(NOW).toISOString() }))).toBe(
      false,
    );
  });
});

describe('tempo', () => {
  it('mostra primeiro -> ultimo evento com duracao', () => {
    const text = alertTimelineText(item(), NOW);
    expect(text).toMatch(/→/);
    expect(text).toContain('2h00m');
  });

  it('idade compacta por faixa', () => {
    expect(alertAgeText(new Date(NOW).toISOString(), NOW)).toBe('agora');
    expect(alertAgeText(new Date(NOW - 12 * 60_000).toISOString(), NOW)).toBe('12m');
    expect(alertAgeText(new Date(NOW - 3 * HOUR - 5 * 60_000).toISOString(), NOW)).toBe('3h05m');
    expect(alertAgeText(new Date(NOW - 49 * HOUR).toISOString(), NOW)).toBe('2d');
    expect(alertAgeText('nope', NOW)).toBe('—');
  });

  it('ACK sem reconhecimento mostra Nao; com ACK mostra autor e hora', () => {
    expect(alertAckText(item())).toBe('Não');
    const acked = item({
      acknowledgedAt: new Date(NOW - 30 * 60_000).toISOString(),
      acknowledgedBy: 'qa-preview',
    });
    expect(alertAckText(acked)).toContain('qa-preview');
  });
});
