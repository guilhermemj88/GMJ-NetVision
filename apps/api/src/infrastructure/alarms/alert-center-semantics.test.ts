import { describe, expect, it } from 'vitest';
import {
  ALERT_CENTER_OCCURRENCE_WINDOW_MS,
  type AlertCenterItem,
} from '@gmj/shared';
import {
  alarmMatchesPeriodFilter,
  alarmMatchesSearch,
  alarmMatchesStateFilter,
  alarmStateFor,
  alarmValueSummary,
  compareAlertCenterItems,
  occurrenceFloorMs,
  occurrenceMatchesPeriodFilter,
  occurrenceMatchesSearch,
  occurrenceMatchesStateFilter,
  occurrenceStateFor,
  occurrenceValueSummary,
  SUPPRESSION_RESOLUTION_REASONS,
} from './alert-center-semantics';
import type {
  AlertCenterAlarmRow,
  AlertCenterOccurrenceRow,
} from './alert-center-repository';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function alarmRow(patch: Partial<AlertCenterAlarmRow> = {}): AlertCenterAlarmRow {
  return {
    id: 'alarm-1',
    type: 'INTERFACE_DOWN',
    severity: 'CRITICAL',
    startedAt: new Date(NOW - 2 * HOUR),
    endedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    updatedAt: new Date(NOW - HOUR),
    deviceId: 'dev-1',
    deviceName: 'CEM-CEN-6730-MPLS-01',
    deviceHostname: 'cem-cen-6730-mpls-01',
    site: 'CEM',
    interfaceId: 'iface-1',
    interfaceName: '100GE0/0/2',
    interfaceAlias: 'CLIENTE-ACME',
    interfaceDescription: 'TO ACME',
    ifIndex: 67502222,
    linkId: null,
    linkLabel: null,
    ruleId: null,
    ruleName: null,
    metricKey: null,
    currentValue: null,
    thresholdValue: null,
    unit: null,
    message: 'Interface DOWN',
    metadata: null,
    suppression: null,
    ...patch,
  };
}

function occurrenceRow(patch: Partial<AlertCenterOccurrenceRow> = {}): AlertCenterOccurrenceRow {
  return {
    id: 'occ-1',
    type: 'CRC_FCS',
    deviceId: 'dev-1',
    deviceName: 'CEM-CEN-6730-MPLS-01',
    deviceHostname: 'cem-cen-6730-mpls-01',
    site: 'CEM',
    interfaceId: 'iface-1',
    interfaceName: '100GE0/0/2',
    interfaceAlias: 'CLIENTE-ACME',
    interfaceDescription: 'TO ACME',
    ifIndex: 67502222,
    firstSeenAt: new Date(NOW - 3 * HOUR),
    lastSeenAt: new Date(NOW - HOUR),
    occurrenceCount: 4,
    crcDeltaTotal: 17n,
    rxDiscardDeltaTotal: 0n,
    txDiscardDeltaTotal: 0n,
    currentRatePerMin: 0.8,
    peakRatePerMin: 4.2,
    acknowledgedAt: null,
    acknowledgedBy: null,
    closedAt: null,
    closeReason: null,
    ...patch,
  };
}

function item(patch: Partial<AlertCenterItem>): AlertCenterItem {
  return {
    id: 'id',
    category: 'ALARM',
    state: 'ACTIVE_UNACKNOWLEDGED',
    severity: 'CRITICAL',
    type: 'INTERFACE_DOWN',
    typeLabel: 'LINK DOWN',
    deviceId: 'dev-1',
    deviceName: 'dev',
    deviceHostname: null,
    site: null,
    interfaceId: null,
    interfaceName: null,
    interfaceAlias: null,
    interfaceLabel: null,
    ifIndex: null,
    startedAt: new Date(NOW).toISOString(),
    lastSeenAt: new Date(NOW).toISOString(),
    endedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    valueSummary: 'DOWN',
    mapIds: [],
    ...patch,
  };
}

describe('estado normalizado', () => {
  it('alarme ativo sem ACK, com ACK, resolvido e suprimido', () => {
    expect(alarmStateFor({ endedAt: null, acknowledgedAt: null })).toBe('ACTIVE_UNACKNOWLEDGED');
    expect(
      alarmStateFor({ endedAt: null, acknowledgedAt: new Date(NOW) }),
    ).toBe('ACTIVE_ACKNOWLEDGED');
    expect(alarmStateFor({ endedAt: new Date(NOW), acknowledgedAt: null })).toBe('RESOLVED');
  });

  it('encerrado por retirada do operador e SUPPRESSED, nunca RESOLVED', () => {
    for (const reason of SUPPRESSION_RESOLUTION_REASONS) {
      expect(
        alarmStateFor({ endedAt: new Date(NOW), acknowledgedAt: new Date(NOW), suppressionReason: reason }),
      ).toBe('SUPPRESSED');
    }
    expect(
      alarmStateFor({ endedAt: new Date(NOW), acknowledgedAt: null, suppressionReason: 'RULE_DISABLED' }),
    ).toBe('RESOLVED');
  });

  it('ACK nao transforma alarme ativo em resolvido', () => {
    const state = alarmStateFor({ endedAt: null, acknowledgedAt: new Date(NOW) });
    expect(state).toBe('ACTIVE_ACKNOWLEDGED');
    expect(alarmMatchesStateFilter({ endedAt: null, acknowledgedAt: new Date(NOW) }, 'ACTIVE')).toBe(true);
    expect(alarmMatchesStateFilter({ endedAt: null, acknowledgedAt: new Date(NOW) }, 'RESOLVED')).toBe(
      false,
    );
  });

  it('ocorrencia distingue nao reconhecida, reconhecida, 24h e encerrada', () => {
    expect(occurrenceStateFor({ acknowledgedAt: null, closedAt: null })).toBe('UNACKNOWLEDGED');
    expect(occurrenceStateFor({ acknowledgedAt: new Date(NOW), closedAt: null })).toBe('ACKNOWLEDGED');
    expect(
      occurrenceStateFor({ acknowledgedAt: null, closedAt: new Date(NOW), closeReason: 'QUIET_24H' }),
    ).toBe('QUIET_24H');
    expect(
      occurrenceStateFor({ acknowledgedAt: null, closedAt: new Date(NOW), closeReason: 'MANUAL' }),
    ).toBe('CLOSED');
  });
});

describe('filtro de estado', () => {
  it('alarme: ATIVOS inclui reconhecidos e nao reconhecidos', () => {
    expect(alarmMatchesStateFilter({ endedAt: null, acknowledgedAt: null }, 'ACTIVE')).toBe(true);
    expect(alarmMatchesStateFilter({ endedAt: null, acknowledgedAt: new Date(NOW) }, 'ACTIVE')).toBe(true);
    expect(alarmMatchesStateFilter({ endedAt: new Date(NOW), acknowledgedAt: null }, 'ACTIVE')).toBe(
      false,
    );
  });

  it('alarme: NAO RECONHECIDOS e RECONHECIDOS separam por ACK', () => {
    expect(
      alarmMatchesStateFilter({ endedAt: null, acknowledgedAt: new Date(NOW) }, 'UNACKNOWLEDGED'),
    ).toBe(false);
    expect(
      alarmMatchesStateFilter({ endedAt: null, acknowledgedAt: new Date(NOW) }, 'ACKNOWLEDGED'),
    ).toBe(true);
  });

  it('RESOLVIDOS exclui suprimidos e SUPRIMIDOS exclui recuperacao tecnica', () => {
    const resolved = { endedAt: new Date(NOW), acknowledgedAt: null };
    const suppressed = { ...resolved, suppressionReason: 'MAINTENANCE' };
    expect(alarmMatchesStateFilter(resolved, 'RESOLVED')).toBe(true);
    expect(alarmMatchesStateFilter(resolved, 'SUPPRESSED')).toBe(false);
    expect(alarmMatchesStateFilter(suppressed, 'RESOLVED')).toBe(false);
    expect(alarmMatchesStateFilter(suppressed, 'SUPPRESSED')).toBe(true);
  });

  it('ocorrencia vigente exige 24h; reconhecida independe de vigencia', () => {
    const fresh = occurrenceRow({ lastSeenAt: new Date(NOW - HOUR) });
    const stale = occurrenceRow({ lastSeenAt: new Date(NOW - 30 * HOUR) });
    expect(occurrenceMatchesStateFilter(fresh, 'UNACKNOWLEDGED', NOW)).toBe(true);
    expect(occurrenceMatchesStateFilter(stale, 'UNACKNOWLEDGED', NOW)).toBe(false);
    expect(occurrenceMatchesStateFilter(stale, 'ACKNOWLEDGED', NOW)).toBe(false);
    expect(
      occurrenceMatchesStateFilter(
        { ...stale, acknowledgedAt: new Date(NOW - 10 * HOUR) },
        'ACKNOWLEDGED',
        NOW,
      ),
    ).toBe(true);
  });

  it('ocorrencia nao aparece nos filtros de alarme (resolvido/suprimido)', () => {
    const row = occurrenceRow();
    expect(occurrenceMatchesStateFilter(row, 'RESOLVED', NOW)).toBe(false);
    expect(occurrenceMatchesStateFilter(row, 'SUPPRESSED', NOW)).toBe(false);
    expect(occurrenceMatchesStateFilter(row, 'ALL', NOW)).toBe(true);
  });

  it('piso de tempo combina periodo com a janela de 24h das vigentes', () => {
    expect(occurrenceFloorMs('ACTIVE', null, NOW)).toBe(NOW - ALERT_CENTER_OCCURRENCE_WINDOW_MS);
    expect(occurrenceFloorMs('ACTIVE', NOW - HOUR, NOW)).toBe(NOW - HOUR);
    // Vigente nunca olha mais de 24h para tras, mesmo com periodo maior.
    expect(occurrenceFloorMs('ACTIVE', NOW - 7 * 24 * HOUR, NOW)).toBe(
      NOW - ALERT_CENTER_OCCURRENCE_WINDOW_MS,
    );
    // Historico (ACK) respeita apenas o periodo escolhido.
    expect(occurrenceFloorMs('ACKNOWLEDGED', null, NOW)).toBeNull();
    expect(occurrenceFloorMs('ALL', null, NOW)).toBeNull();
  });
});

describe('periodo', () => {
  it('nunca esconde alarme ativo (inicio fora da janela)', () => {
    const old = alarmRow({ startedAt: new Date(NOW - 40 * 24 * HOUR), endedAt: null });
    expect(alarmMatchesPeriodFilter(old, NOW - HOUR)).toBe(true);
  });

  it('esconde apenas historico encerrado fora da janela', () => {
    const ended = alarmRow({ endedAt: new Date(NOW - 10 * HOUR), updatedAt: new Date(NOW - 10 * HOUR) });
    expect(alarmMatchesPeriodFilter(ended, NOW - HOUR)).toBe(false);
    expect(alarmMatchesPeriodFilter(ended, NOW - 24 * HOUR)).toBe(true);
  });

  it('ocorrencia usa lastSeenAt', () => {
    const stale = occurrenceRow({ lastSeenAt: new Date(NOW - 5 * 24 * HOUR) });
    expect(occurrenceMatchesPeriodFilter(stale, NOW - 7 * 24 * HOUR)).toBe(true);
    expect(occurrenceMatchesPeriodFilter(stale, NOW - 24 * HOUR)).toBe(false);
  });
});

describe('busca', () => {
  it('encontra por equipamento, hostname, interface e alias', () => {
    const row = alarmRow();
    expect(alarmMatchesSearch(row, 'cen-6730')).toBe(true);
    expect(alarmMatchesSearch(row, 'CEM-CEN')).toBe(true);
    expect(alarmMatchesSearch(row, '100ge0/0/2')).toBe(true);
    expect(alarmMatchesSearch(row, 'acme')).toBe(true);
    expect(alarmMatchesSearch(row, 'inexistente')).toBe(false);
  });

  it('encontra por tipo (link down, crc, discard, optico)', () => {
    expect(alarmMatchesSearch(alarmRow({ type: 'INTERFACE_DOWN' }), 'link down')).toBe(true);
    expect(alarmMatchesSearch(alarmRow({ type: 'INTERFACE_CRC' }), 'crc')).toBe(true);
    expect(alarmMatchesSearch(alarmRow({ type: 'INTERFACE_DISCARDS' }), 'discard')).toBe(true);
    expect(alarmMatchesSearch(alarmRow({ type: 'OPTICAL_RX_DEGRADATION' }), 'optico')).toBe(true);
    expect(occurrenceMatchesSearch(occurrenceRow({ type: 'CRC_FCS' }), 'crc')).toBe(true);
    expect(occurrenceMatchesSearch(occurrenceRow({ type: 'DISCARDS' }), 'discard')).toBe(true);
  });

  it('busca vazia nao filtra nada', () => {
    expect(alarmMatchesSearch(alarmRow(), '   ')).toBe(true);
    expect(occurrenceMatchesSearch(occurrenceRow(), '')).toBe(true);
  });
});

describe('ordenacao estavel', () => {
  it('prioriza ativo nao reconhecido, ativo reconhecido e ocorrencia nao reconhecida', () => {
    const list = [
      item({ id: 'occ-ack', category: 'OCCURRENCE', state: 'ACKNOWLEDGED', severity: null }),
      item({ id: 'alarm-ack', state: 'ACTIVE_ACKNOWLEDGED' }),
      item({ id: 'alarm-new', state: 'ACTIVE_UNACKNOWLEDGED' }),
      item({ id: 'occ-new', category: 'OCCURRENCE', state: 'UNACKNOWLEDGED', severity: null }),
    ].sort(compareAlertCenterItems);
    expect(list.map((entry) => entry.id)).toEqual(['alarm-new', 'alarm-ack', 'occ-new', 'occ-ack']);
  });

  it('empate resolve por lastSeenAt DESC e depois por id', () => {
    const older = item({ id: 'b', lastSeenAt: new Date(NOW - HOUR).toISOString() });
    const newer = item({ id: 'a', lastSeenAt: new Date(NOW).toISOString() });
    expect([older, newer].sort(compareAlertCenterItems).map((entry) => entry.id)).toEqual(['a', 'b']);
    const same = [
      item({ id: 'z', lastSeenAt: new Date(NOW).toISOString() }),
      item({ id: 'a', lastSeenAt: new Date(NOW).toISOString() }),
    ];
    expect(same.sort(compareAlertCenterItems).map((entry) => entry.id)).toEqual(['a', 'z']);
  });

  it('ordenacao e deterministica independente da ordem de entrada', () => {
    const rows = [
      item({ id: 'c', state: 'RESOLVED', endedAt: new Date(NOW).toISOString(), lastSeenAt: new Date(NOW).toISOString() }),
      item({ id: 'a', state: 'ACTIVE_UNACKNOWLEDGED' }),
      item({ id: 'b', category: 'OCCURRENCE', state: 'UNACKNOWLEDGED', severity: null }),
    ];
    const first = [...rows].sort(compareAlertCenterItems).map((entry) => entry.id);
    const second = [...rows].reverse().sort(compareAlertCenterItems).map((entry) => entry.id);
    expect(first).toEqual(['a', 'b', 'c']);
    expect(second).toEqual(first);
  });
});

describe('resumo de valor', () => {
  it('alarme de link down mostra o estado tecnico', () => {
    expect(alarmValueSummary(alarmRow())).toBe('DOWN');
    expect(alarmValueSummary(alarmRow({ endedAt: new Date(NOW) }))).toBe('NORMALIZADO');
  });

  it('alarme metrico mostra direcao, taxa e limite', () => {
    const summary = alarmValueSummary(
      alarmRow({
        type: 'INTERFACE_CRC',
        metricKey: 'FCS',
        currentValue: 12,
        thresholdValue: 1,
        metadata: { ratePerMinute: 12, thresholdPerMinute: 1, delta: '17' },
      }),
    );
    expect(summary).toBe('RX · 12/min · limite 1 · +17 no período');
  });

  it('alarme optico mostra potencia, LOW e margem', () => {
    const summary = alarmValueSummary(
      alarmRow({
        type: 'OPTICAL_RX_DEGRADATION',
        metadata: { rxPowerDbm: -10.02, rxLowAlarmDbm: -12.31, marginDb: 2.29, lane: 2 },
      }),
    );
    expect(summary).toBe('-10.02 dBm · LOW -12.31 dBm · margem 2.29 dB · lane 2');
  });

  it('ocorrencia mostra CRC, RX/TX e taxa sem BigInt cru', () => {
    expect(occurrenceValueSummary(occurrenceRow())).toBe('+17 CRC · 0.8/min');
    expect(
      occurrenceValueSummary(
        occurrenceRow({
          type: 'DISCARDS',
          crcDeltaTotal: 0n,
          rxDiscardDeltaTotal: 23n,
          txDiscardDeltaTotal: 1364n,
          currentRatePerMin: 90.9,
        }),
      ),
    ).toBe('RX +23 · TX +1364 · 90.9/min');
    expect(occurrenceValueSummary(occurrenceRow({ crcDeltaTotal: 0n, currentRatePerMin: 0 }))).toBe(
      'sem delta acumulado',
    );
  });
});
