import { describe, expect, it } from 'vitest';
import type { AlertCenterItem } from '@gmj/shared';
import {
  alertAckText,
  alertAgeText,
  alertAgeWords,
  alertCanAcknowledge,
  alertCategoryBadge,
  alertLastSeenText,
  alertSeverityLabel,
  alertSeverityTone,
  alertStateText,
  alertStateTone,
  alertTimelineText,
  comparePanelAlarms,
  mergeRecentResolved,
  occurrenceCountersText,
  panelOccurrenceVisible,
  resolvedReasonText,
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

describe('painel compacto (F9.4)', () => {
  function alarmDetail(patch: Partial<NonNullable<AlertCenterItem['alarm']>> = {}) {
    return {
      ruleId: null,
      ruleName: null,
      metricKey: null,
      direction: null,
      currentValue: null,
      thresholdValue: null,
      unit: null,
      ratePerMinute: null,
      thresholdPerMinute: null,
      delta: null,
      message: 'm',
      linkId: null,
      linkLabel: null,
      resolutionReason: null,
      suppression: null,
      optical: null,
      ...patch,
    };
  }

  function occurrenceDetail(patch: Partial<NonNullable<AlertCenterItem['occurrence']>> = {}) {
    return {
      occurrenceCount: 3,
      crcDeltaTotal: 0,
      rxDiscardDeltaTotal: 0,
      txDiscardDeltaTotal: 0,
      currentRatePerMin: 1.5,
      peakRatePerMin: 9.5,
      closeReason: null,
      closedAt: null,
      mediaAvailable: false as const,
      ...patch,
    };
  }

  it('ordena nao reconhecidos por severidade e reconhecidos por ultimo', () => {
    const critical = item({ id: 'c', severity: 'CRITICAL' });
    const major = item({ id: 'm', severity: 'MAJOR' });
    const acked = item({ id: 'a', severity: 'CRITICAL', acknowledgedAt: new Date(NOW).toISOString() });
    const sorted = [acked, major, critical].sort(comparePanelAlarms).map((entry) => entry.id);
    expect(sorted).toEqual(['c', 'm', 'a']);
  });

  it('desempata pela ultima mudanca mais recente', () => {
    const older = item({ id: 'older', severity: 'MAJOR', lastSeenAt: new Date(NOW - HOUR).toISOString() });
    const newer = item({ id: 'newer', severity: 'MAJOR', lastSeenAt: new Date(NOW - 60_000).toISOString() });
    expect([older, newer].sort(comparePanelAlarms).map((entry) => entry.id)).toEqual([
      'newer',
      'older',
    ]);
  });

  it('occurrence vigente so vale sem ACK e dentro de 24h', () => {
    const occurrence = item({
      category: 'OCCURRENCE',
      state: 'UNACKNOWLEDGED',
      severity: null,
      lastSeenAt: new Date(NOW - 23 * HOUR).toISOString(),
    });
    expect(panelOccurrenceVisible(occurrence, NOW)).toBe(true);
    expect(
      panelOccurrenceVisible(
        { ...occurrence, lastSeenAt: new Date(NOW - 25 * HOUR).toISOString() },
        NOW,
      ),
    ).toBe(false);
    expect(
      panelOccurrenceVisible({ ...occurrence, acknowledgedAt: new Date(NOW).toISOString() }, NOW),
    ).toBe(false);
    expect(panelOccurrenceVisible(item(), NOW)).toBe(false);
  });

  it('junta resolvidos e suprimidos, do mais novo, sem repetir e com limite', () => {
    const resolved = [
      item({ id: 'r1', state: 'RESOLVED', endedAt: new Date(NOW - 3 * HOUR).toISOString() }),
      item({ id: 'r2', state: 'RESOLVED', endedAt: new Date(NOW - HOUR).toISOString() }),
    ];
    const suppressed = [
      item({ id: 's1', state: 'SUPPRESSED', endedAt: new Date(NOW - 30_000).toISOString() }),
      item({ id: 'r2', state: 'SUPPRESSED', endedAt: new Date(NOW - HOUR).toISOString() }),
    ];
    expect(mergeRecentResolved(resolved, suppressed, 3).map((entry) => entry.id)).toEqual([
      's1',
      'r2',
      'r1',
    ]);
    expect(mergeRecentResolved(resolved, suppressed, 1).map((entry) => entry.id)).toEqual(['s1']);
    expect(mergeRecentResolved([], [], 3)).toEqual([]);
  });

  it('separa recuperacao tecnica de motivo administrativo', () => {
    expect(resolvedReasonText(item({ alarm: alarmDetail() }))).toBe(
      'Normalizado (recuperação técnica)',
    );
    expect(
      resolvedReasonText(
        item({
          alarm: alarmDetail({
            resolutionReason: 'RULE_DISABLED',
          }),
        }),
      ),
    ).toBe('regra desativada');
    expect(
      resolvedReasonText(
        item({
          state: 'SUPPRESSED',
          alarm: alarmDetail({
            suppression: {
              id: 's',
              mode: 'UNTIL_CLEAR',
              reason: 'MAINTENANCE',
              note: null,
              suppressedBy: 'qa',
              suppressedAt: new Date(NOW).toISOString(),
              expiresAt: null,
            },
          }),
        }),
      ),
    ).toBe('Manutenção');
  });

  it('resume o episodio: CRC ou RX/TX no MESMO card', () => {
    expect(
      occurrenceCountersText(
        item({ category: 'OCCURRENCE', type: 'CRC_FCS', occurrence: occurrenceDetail({ crcDeltaTotal: 17 }) }),
      ),
    ).toBe('+17 CRC');
    expect(
      occurrenceCountersText(
        item({
          category: 'OCCURRENCE',
          type: 'DISCARDS',
          occurrence: occurrenceDetail({ rxDiscardDeltaTotal: 23, txDiscardDeltaTotal: 1364 }),
        }),
      ),
    ).toBe('RX +23 · TX +1364');
    expect(
      occurrenceCountersText(
        item({ category: 'OCCURRENCE', type: 'DISCARDS', occurrence: occurrenceDetail() }),
      ),
    ).toBe('—');
    expect(occurrenceCountersText(item())).toBe('—');
  });

  it('idade em palavras para o card de ocorrencia', () => {
    expect(alertAgeWords(new Date(NOW).toISOString(), NOW)).toBe('agora');
    expect(alertAgeWords(new Date(NOW - 3 * 60_000).toISOString(), NOW)).toBe('3 min');
    expect(alertAgeWords(new Date(NOW - 65 * 60_000).toISOString(), NOW)).toBe('1h05m');
    expect(alertAgeWords(new Date(NOW - 50 * HOUR).toISOString(), NOW)).toBe('2d');
    expect(alertAgeWords('nope', NOW)).toBe('—');
    expect(alertLastSeenText(new Date(NOW).toISOString(), NOW)).toBe('Última agora');
    expect(alertLastSeenText(new Date(NOW - 3 * 60_000).toISOString(), NOW)).toBe(
      'Última há 3 min',
    );
  });
});
