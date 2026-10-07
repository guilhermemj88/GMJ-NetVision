import { describe, expect, it, vi } from 'vitest';
import type { AlertCenterSummary } from '@gmj/shared';
import type {
  AlertCenterAlarmRow,
  AlertCenterOccurrenceRow,
  AlertCenterQuery,
  AlertCenterRepository,
} from '../infrastructure/alarms/alert-center-repository';
import { AlertCenterService } from './alert-center-service';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function emptySummary(): AlertCenterSummary {
  return {
    alarmsActive: 0,
    alarmsActiveCritical: 0,
    alarmsActiveMajor: 0,
    alarmsActiveWarning: 0,
    alarmsActiveInfo: 0,
    alarmsActiveUnacknowledged: 0,
    alarmsActiveAcknowledged: 0,
    occurrencesUnacknowledged: 0,
    occurrencesAcknowledged: 0,
    occurrencesQuiet24h: 0,
  };
}

function alarmRow(patch: Partial<AlertCenterAlarmRow> = {}): AlertCenterAlarmRow {
  return {
    id: 'alarm-1',
    type: 'INTERFACE_DOWN',
    severity: 'CRITICAL',
    startedAt: new Date(NOW - 3 * HOUR),
    endedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    updatedAt: new Date(NOW - HOUR),
    deviceId: 'dev-1',
    deviceName: 'RNS-FLOR-6730-MPLS-01',
    deviceHostname: 'rns-flor-6730-mpls-01',
    site: 'RNS',
    interfaceId: 'iface-1',
    interfaceName: '100GE0/0/2',
    interfaceAlias: 'CLIENTE-ACME',
    interfaceDescription: 'TO ACME',
    ifIndex: 67502222,
    linkId: 'link-1',
    linkLabel: 'ACME',
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
    deviceName: 'RNS-FLOR-6730-MPLS-01',
    deviceHostname: 'rns-flor-6730-mpls-01',
    site: 'RNS',
    interfaceId: 'iface-1',
    interfaceName: '100GE0/0/2',
    interfaceAlias: 'CLIENTE-ACME',
    interfaceDescription: 'TO ACME',
    ifIndex: 67502222,
    firstSeenAt: new Date(NOW - 5 * HOUR),
    lastSeenAt: new Date(NOW - 2 * HOUR),
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

/** Repositorio falso que CONTA chamadas: prova que a pagina nao e N+1. */
function repository(rows: {
  alarms?: AlertCenterAlarmRow[];
  alarmTotal?: number;
  occurrences?: AlertCenterOccurrenceRow[];
  occurrenceTotal?: number;
  summary?: AlertCenterSummary;
  mapIds?: Map<string, string[]>;
}) {
  const calls: string[] = [];
  const queries: AlertCenterQuery[] = [];
  const repo: AlertCenterRepository = {
    listAlarms: vi.fn(async (query: AlertCenterQuery) => {
      calls.push('listAlarms');
      queries.push(query);
      return rows.alarms ?? [];
    }),
    countAlarms: vi.fn(async () => {
      calls.push('countAlarms');
      return rows.alarmTotal ?? rows.alarms?.length ?? 0;
    }),
    listOccurrences: vi.fn(async (query: AlertCenterQuery) => {
      calls.push('listOccurrences');
      queries.push(query);
      return rows.occurrences ?? [];
    }),
    countOccurrences: vi.fn(async () => {
      calls.push('countOccurrences');
      return rows.occurrenceTotal ?? rows.occurrences?.length ?? 0;
    }),
    summaryCounts: vi.fn(async () => {
      calls.push('summaryCounts');
      return rows.summary ?? emptySummary();
    }),
    mapIdsByDevice: vi.fn(async () => {
      calls.push('mapIdsByDevice');
      return rows.mapIds ?? new Map();
    }),
  };
  return { repo, calls, queries };
}

function service(repo: AlertCenterRepository, nowMs: number = NOW) {
  return new AlertCenterService(repo, { now: () => nowMs });
}

describe('AlertCenterService — leitura e unificacao', () => {
  it('funde alarmes e ocorrencias em uma pagina unica ordenada', async () => {
    const { repo } = repository({
      alarms: [
        alarmRow({ id: 'alarm-ack', acknowledgedAt: new Date(NOW - HOUR) }),
        alarmRow({ id: 'alarm-new' }),
      ],
      occurrences: [occurrenceRow({ id: 'occ-new' })],
    });
    const response = await service(repo).list();

    expect(response.items.map((item) => item.id)).toEqual(['alarm-new', 'alarm-ack', 'occ-new']);
    expect(response.total).toBe(3);
    expect(response.state).toBe('ACTIVE');
    expect(response.hasMore).toBe(false);
  });

  it('mapeia o DTO com categoria, estado, identidade e detalhe por entidade', async () => {
    const { repo } = repository({
      alarms: [alarmRow({ ruleId: 'rule-1', ruleName: 'CRC-100G', metricKey: 'FCS' })],
      occurrences: [occurrenceRow()],
      mapIds: new Map([['dev-1', ['map-1']]]),
    });
    const response = await service(repo).list({ category: 'ALARM' });
    const alarm = response.items[0]!;

    expect(alarm).toMatchObject({
      category: 'ALARM',
      state: 'ACTIVE_UNACKNOWLEDGED',
      severity: 'CRITICAL',
      type: 'INTERFACE_DOWN',
      typeLabel: 'LINK DOWN',
      deviceName: 'RNS-FLOR-6730-MPLS-01',
      deviceHostname: 'rns-flor-6730-mpls-01',
      interfaceName: '100GE0/0/2',
      interfaceLabel: 'CLIENTE-ACME',
      ifIndex: 67502222,
      valueSummary: 'DOWN',
      mapIds: ['map-1'],
    });
    expect(alarm.alarm).toMatchObject({ ruleId: 'rule-1', ruleName: 'CRC-100G', metricKey: 'FCS' });

    const withOccurrence = await service(repo).list({ category: 'OCCURRENCE' });
    const occurrence = withOccurrence.items[0]!;
    expect(occurrence).toMatchObject({
      category: 'OCCURRENCE',
      state: 'UNACKNOWLEDGED',
      // Severidade NUNCA inventada para ocorrencia.
      severity: null,
      typeLabel: 'CRC/FCS',
      valueSummary: '+17 CRC · 0.8/min',
      startedAt: new Date(NOW - 5 * HOUR).toISOString(),
      lastSeenAt: new Date(NOW - 2 * HOUR).toISOString(),
    });
    expect(occurrence.occurrence).toMatchObject({
      occurrenceCount: 4,
      crcDeltaTotal: 17,
      currentRatePerMin: 0.8,
      peakRatePerMin: 4.2,
      mediaAvailable: false,
    });
  });

  it('nunca vaza BigInt no JSON da ocorrencia', async () => {
    const { repo } = repository({
      occurrences: [
        occurrenceRow({
          crcDeltaTotal: 9_007_199_254_740_993n,
          rxDiscardDeltaTotal: 12n,
          txDiscardDeltaTotal: 34n,
        }),
      ],
    });
    const response = await service(repo).list({ category: 'OCCURRENCE' });
    // BigInt no payload faria o JSON.stringify lancar.
    expect(() => JSON.stringify(response)).not.toThrow();
    expect(response.items[0]!.occurrence).toMatchObject({
      crcDeltaTotal: Number.MAX_SAFE_INTEGER,
      rxDiscardDeltaTotal: 12,
      txDiscardDeltaTotal: 34,
    });
    expect(response.items[0]!.valueSummary).toBe(
      '+9007199254740991 CRC · RX +12 · TX +34 · 0.8/min',
    );
  });

  it('filtro de severidade exclui ocorrencias (nunca ganham severidade)', async () => {
    const { repo, calls } = repository({
      alarms: [alarmRow()],
      occurrences: [occurrenceRow()],
    });
    const response = await service(repo).list({ severities: ['CRITICAL'] });
    expect(response.items).toHaveLength(1);
    expect(response.items[0]!.category).toBe('ALARM');
    // A fonte de ocorrencias nem e consultada.
    expect(calls).not.toContain('listOccurrences');
  });

  it('tipo de occurrence nao consulta a fonte de alarmes e vice-versa', async () => {
    const { repo, calls } = repository({ alarms: [alarmRow()], occurrences: [occurrenceRow()] });
    const onlyOccurrence = await service(repo).list({ types: ['CRC_FCS'] });
    expect(onlyOccurrence.items.map((item) => item.category)).toEqual(['OCCURRENCE']);
    expect(calls).not.toContain('listAlarms');

    const { repo: second, calls: secondCalls } = repository({
      alarms: [alarmRow()],
      occurrences: [occurrenceRow()],
    });
    const onlyAlarm = await service(second).list({ types: ['INTERFACE_DOWN'] });
    expect(onlyAlarm.items.map((item) => item.category)).toEqual(['ALARM']);
    expect(secondCalls).not.toContain('listOccurrences');
  });

  it('estado RESOLVIDO/SUPRIMIDO nao consulta ocorrencias', async () => {
    const { repo, calls } = repository({ alarms: [alarmRow({ endedAt: new Date(NOW) })] });
    await service(repo).list({ state: 'RESOLVED' });
    await service(repo).list({ state: 'SUPPRESSED' });
    expect(calls.filter((call) => call === 'listOccurrences')).toHaveLength(0);
  });

  it('categoria unica devolve so a categoria pedida', async () => {
    const { repo } = repository({ alarms: [alarmRow()], occurrences: [occurrenceRow()] });
    expect((await service(repo).list({ category: 'OCCURRENCE' })).items).toHaveLength(1);
    expect((await service(repo).list({ category: 'ALARM' })).items).toHaveLength(1);
  });
});

describe('AlertCenterService — paginacao e ordenacao', () => {
  it('pagina no servidor com limit/offset e hasMore corretos', async () => {
    const alarms = Array.from({ length: 5 }, (_, index) =>
      alarmRow({
        id: `alarm-${index}`,
        updatedAt: new Date(NOW - index * HOUR),
      }),
    );
    const { repo, queries } = repository({ alarms, alarmTotal: 5 });
    const first = await service(repo).list({ limit: 2, offset: 0 });
    expect(first.items.map((item) => item.id)).toEqual(['alarm-0', 'alarm-1']);
    expect(first).toMatchObject({ total: 5, limit: 2, offset: 0, hasMore: true });

    const second = await service(repo).list({ limit: 2, offset: 4 });
    expect(second.items.map((item) => item.id)).toEqual(['alarm-4']);
    expect(second.hasMore).toBe(false);

    // A janela pedida a cada fonte cobre offset + limit (fusoes corretas).
    expect(queries.at(-1)?.take).toBe(6);
  });

  it('respeita o teto de 100 itens por pagina', async () => {
    const { repo, queries } = repository({ alarms: [] });
    await service(repo).list({ limit: 500 });
    expect(queries[0]?.take).toBe(100);
  });

  it('total soma as duas fontes', async () => {
    const { repo } = repository({
      alarms: [alarmRow()],
      occurrences: [occurrenceRow()],
      alarmTotal: 7,
      occurrenceTotal: 3,
    });
    const response = await service(repo).list();
    expect(response.total).toBe(10);
  });
});

describe('AlertCenterService — eficiencia e resumo', () => {
  it('uma pagina de 50 itens custa um numero CONSTANTE de consultas', async () => {
    const alarms = Array.from({ length: 50 }, (_, index) => alarmRow({ id: `alarm-${index}` }));
    const occurrences = Array.from({ length: 50 }, (_, index) =>
      occurrenceRow({ id: `occ-${index}` }),
    );
    const { repo, calls } = repository({ alarms, occurrences, alarmTotal: 50, occurrenceTotal: 50 });
    const response = await service(repo).list({ limit: 100 });

    expect(response.items).toHaveLength(100);
    expect(calls).toEqual([
      'listAlarms',
      'countAlarms',
      'listOccurrences',
      'countOccurrences',
      'summaryCounts',
      'mapIdsByDevice',
    ]);
  });

  it('devolve o resumo operacional junto da pagina', async () => {
    const summary: AlertCenterSummary = {
      ...emptySummary(),
      alarmsActive: 9,
      alarmsActiveCritical: 2,
      alarmsActiveUnacknowledged: 5,
      occurrencesUnacknowledged: 3,
    };
    const { repo } = repository({ summary });
    const response = await service(repo).list();
    expect(response.summary).toEqual(summary);
    expect(response.generatedAt).toBe(new Date(NOW).toISOString());
  });

  it('summary() exposto para o badge sem carregar itens', async () => {
    const { repo, calls } = repository({ summary: { ...emptySummary(), alarmsActive: 1 } });
    const summary = await service(repo).summary();
    expect(summary.alarmsActive).toBe(1);
    expect(calls).toEqual(['summaryCounts']);
  });

  it('periodo vira corte de historico no filtro enviado ao repositorio', async () => {
    const { repo, queries } = repository({ alarms: [], occurrences: [] });
    await service(repo).list({ period: '24h' });
    expect(queries[0]?.fromMs).toBe(NOW - 24 * HOUR);
    expect(queries[0]?.state).toBe('ACTIVE');

    const { repo: second, queries: secondQueries } = repository({ alarms: [] });
    await service(second).list({});
    expect(secondQueries[0]?.fromMs).toBeNull();
  });
});
