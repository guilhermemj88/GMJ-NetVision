// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  AlertCenterItem,
  AlertCenterListQuery,
  AlertCenterResponse,
  AlertCenterSummary,
  NetworkMap,
  OpticalTriggerReason,
} from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMapStore } from '@/store/map-store';

const api = vi.hoisted(() => ({
  getAlertCenter: vi.fn(),
  getAlertCenterSummary: vi.fn(),
  acknowledgeAlarm: vi.fn(),
  acknowledgeOperationalOccurrence: vi.fn(),
  suppressAlarm: vi.fn(),
  // Rotas antigas: o painel NAO pode mais reconstruir a visao por elas.
  getAlarms: vi.fn(),
  getAlarmOccurrences: vi.fn(),
  getRecentResolvedAlarms: vi.fn(),
}));

vi.mock('@/lib/api', () => api);

import { AlarmPanel } from './alarm-panel';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const NOW = new Date('2026-10-12T12:00:00.000Z').getTime();
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Dados servidos pelos mocks: cada teste troca os arrays e invalida. */
let activeFixture: AlertCenterItem[] = [];
let occurrenceFixture: AlertCenterItem[] = [];
let resolvedFixture: AlertCenterItem[] = [];
let suppressedFixture: AlertCenterItem[] = [];
let activeTotal = 0;
let occurrenceTotal = 0;
let summaryFixture: AlertCenterSummary = {
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

function summary(patch: Partial<AlertCenterSummary> = {}): AlertCenterSummary {
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
    ...patch,
  };
}

type AlarmDetailFixture = NonNullable<AlertCenterItem['alarm']>;

function alarmDetail(patch: Partial<AlarmDetailFixture> = {}): AlarmDetailFixture {
  return {
    ruleId: 'rule-1',
    ruleName: 'Link down',
    metricKey: null,
    direction: null,
    currentValue: null,
    thresholdValue: null,
    unit: null,
    ratePerMinute: null,
    thresholdPerMinute: null,
    delta: null,
    message: 'Interface DOWN',
    linkId: null,
    linkLabel: null,
    resolutionReason: null,
    suppression: null,
    optical: null,
    ...patch,
  };
}

function alarmItem(patch: Partial<AlertCenterItem> = {}): AlertCenterItem {
  return {
    id: 'alarm-1',
    category: 'ALARM',
    state: 'ACTIVE_UNACKNOWLEDGED',
    severity: 'CRITICAL',
    type: 'INTERFACE_DOWN',
    typeLabel: 'LINK DOWN',
    deviceId: 'dev-1',
    deviceName: 'RNS-FLOR-6730-MPLS-01',
    deviceHostname: 'rns-flor-6730-mpls-01',
    site: 'RNS',
    interfaceId: 'iface-1',
    interfaceName: '100GE0/0/2',
    interfaceAlias: 'CLIENTE-ACME',
    interfaceLabel: 'CLIENTE-ACME',
    ifIndex: 67502222,
    startedAt: new Date(NOW - 3 * HOUR).toISOString(),
    lastSeenAt: new Date(NOW - MINUTE).toISOString(),
    endedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    valueSummary: 'DOWN',
    mapIds: ['map-1'],
    alarm: alarmDetail(),
    ...patch,
  };
}

function metricAlarm(patch: Partial<AlertCenterItem> = {}): AlertCenterItem {
  return alarmItem({
    id: 'alarm-crc',
    type: 'INTERFACE_CRC',
    typeLabel: 'CRC/FCS',
    severity: 'WARNING',
    interfaceName: 'XGE0/0/15',
    interfaceLabel: 'SBA-GEN-UPLINK',
    alarm: alarmDetail({
      metricKey: 'FCS',
      direction: 'RX',
      currentValue: 0.8,
      thresholdValue: 5,
      unit: 'crc',
      ratePerMinute: 0.8,
      thresholdPerMinute: 5,
      delta: '17',
    }),
    ...patch,
  });
}

function opticalDetail(patch: Partial<NonNullable<AlarmDetailFixture['optical']>> = {}) {
  return {
    lane: 2,
    rxPowerDbm: -10.02,
    rxLowAlarmDbm: -12.31,
    rxHighAlarmDbm: 3.4,
    marginDb: 2.29,
    proximityPercent: 91.3,
    trendDropDb: 4.3,
    trendWindowMinutes: 30,
    triggerReasons: ['PROXIMITY', 'RAPID_DROP'] as OpticalTriggerReason[],
    thresholdSource: 'DEVICE' as const,
    currentPowerSource: 'SNMP' as const,
    ...patch,
  };
}

function opticalItem(patch: Partial<AlertCenterItem> = {}): AlertCenterItem {
  return alarmItem({
    id: 'alarm-optical',
    type: 'OPTICAL_RX_DEGRADATION',
    typeLabel: 'RX ÓPTICO',
    severity: 'MAJOR',
    alarm: alarmDetail({
      metricKey: 'LANE_2',
      currentValue: -10.02,
      thresholdValue: -12.31,
      unit: 'dBm',
      optical: opticalDetail(),
    }),
    ...patch,
  });
}

function occurrenceItem(patch: Partial<AlertCenterItem> = {}): AlertCenterItem {
  return {
    id: 'occ-1',
    category: 'OCCURRENCE',
    state: 'UNACKNOWLEDGED',
    severity: null,
    type: 'CRC_FCS',
    typeLabel: 'CRC/FCS',
    deviceId: 'dev-2',
    deviceName: 'SBA-GEN-6730-MPLS-01',
    deviceHostname: 'sba-gen-6730-mpls-01',
    site: 'SBA',
    interfaceId: 'iface-2',
    interfaceName: 'XGigabitEthernet0/0/15',
    interfaceAlias: 'SBA-GEN-UPLINK',
    interfaceLabel: 'SBA-GEN-UPLINK',
    ifIndex: 1015,
    startedAt: new Date(NOW - 5 * HOUR).toISOString(),
    lastSeenAt: new Date(NOW - 3 * MINUTE).toISOString(),
    endedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    valueSummary: '+17 CRC · 0.8/min',
    mapIds: [],
    occurrence: {
      occurrenceCount: 4,
      crcDeltaTotal: 17,
      rxDiscardDeltaTotal: 0,
      txDiscardDeltaTotal: 0,
      currentRatePerMin: 0.8,
      peakRatePerMin: 4.2,
      closeReason: null,
      closedAt: null,
      mediaAvailable: false,
    },
    ...patch,
  };
}

function discardItem(patch: Partial<AlertCenterItem> = {}): AlertCenterItem {
  return occurrenceItem({
    id: 'occ-dc',
    type: 'DISCARDS',
    typeLabel: 'DISCARDS',
    interfaceName: 'Eth-Trunk33',
    interfaceLabel: 'Eth-Trunk33',
    lastSeenAt: new Date(NOW - 7 * MINUTE).toISOString(),
    valueSummary: 'RX 23 · TX 1364 · 90.9/min',
    occurrence: {
      ...occurrenceItem().occurrence!,
      occurrenceCount: 6,
      crcDeltaTotal: 0,
      rxDiscardDeltaTotal: 23,
      txDiscardDeltaTotal: 1364,
      currentRatePerMin: 90.9,
      peakRatePerMin: 142.3,
    },
    ...patch,
  });
}

function response(
  items: AlertCenterItem[],
  patch: Partial<AlertCenterResponse> = {},
): AlertCenterResponse {
  return {
    items,
    total: items.length,
    limit: 50,
    offset: 0,
    hasMore: false,
    state: 'ACTIVE',
    summary: summaryFixture,
    generatedAt: new Date(NOW).toISOString(),
    ...patch,
  };
}

/** Mapa minimo no store: permite testar "abrir interface" e "abrir no mapa". */
function mapFixture(): NetworkMap {
  return {
    id: 'map-1',
    name: 'Backbone',
    description: '',
    mode: 'HYBRID',
    isDefault: true,
    settings: {
      nodeDisplayMode: 'ICON_2D',
      linkDisplayStyle: 'HYBRID',
      linkMetricDisplay: 'BOTH',
      trafficLabelMode: 'CARD',
      filters: {
        showTraffic: true,
        showUtilization: true,
        showLabels: true,
        showOffline: true,
        showInterfaces: false,
        showTrafficAnimation: true,
      },
      viewport: { x: 0, y: 0, zoom: 1 },
      nodeScale: 100,
      linkScale: 100,
      labelScale: 100,
    },
    devices: [
      {
        id: 'dev-1',
        name: 'RNS-FLOR-6730-MPLS-01',
        interfaces: [{ id: 'iface-1', name: '100GE0/0/2' }],
      },
    ],
    nodes: [],
    links: [],
    widgets: [],
  } as unknown as NetworkMap;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function findButton(scope: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(scope.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.trim().includes(label),
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Botão não encontrado: ${label}`);
  return button;
}

function hasButton(scope: HTMLElement, label: string): boolean {
  return Array.from(scope.querySelectorAll('button')).some((candidate) =>
    candidate.textContent?.trim().includes(label),
  );
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

function cards(scope: HTMLElement, selector: string): Element[] {
  return Array.from(scope.querySelectorAll(selector));
}

describe('AlarmPanel compacto (F9.4)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  async function render(): Promise<void> {
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(AlarmPanel)));
    });
    await settle();
  }

  async function reload(): Promise<void> {
    await act(async () => {
      await client.invalidateQueries();
    });
    await settle();
  }

  function alertCenterQueries(): AlertCenterListQuery[] {
    return api.getAlertCenter.mock.calls.map(([query]) => query as AlertCenterListQuery);
  }

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    summaryFixture = summary();
    api.getAlertCenterSummary.mockImplementation(async () => ({ summary: summaryFixture }));
    api.acknowledgeAlarm.mockResolvedValue({});
    api.acknowledgeOperationalOccurrence.mockResolvedValue({ acknowledged: true });
    api.suppressAlarm.mockResolvedValue({ suppression: { id: 'sup-1' }, closedAlarms: 1 });
    api.getAlertCenter.mockImplementation(async (query: AlertCenterListQuery) => {
      if (query.state === 'ACTIVE') {
        return response(activeFixture, {
          total: activeTotal || activeFixture.length,
          state: 'ACTIVE',
        });
      }
      if (query.state === 'UNACKNOWLEDGED') {
        return response(occurrenceFixture, {
          total: occurrenceTotal || occurrenceFixture.length,
          state: 'UNACKNOWLEDGED',
        });
      }
      if (query.state === 'RESOLVED') return response(resolvedFixture, { state: 'RESOLVED' });
      if (query.state === 'SUPPRESSED') return response(suppressedFixture, { state: 'SUPPRESSED' });
      return response([]);
    });
    activeFixture = [alarmItem()];
    occurrenceFixture = [];
    resolvedFixture = [];
    suppressedFixture = [];
    activeTotal = 0;
    occurrenceTotal = 0;
    window.localStorage.clear();
    useMapStore.setState({
      view: 'MAP',
      map: mapFixture(),
      activeMapId: 'map-1',
      maps: [],
      selection: null,
      panel: null,
      toast: null,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    await render();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('le a Central de Alertas e nao usa as rotas antigas de alarme', () => {
    const queries = alertCenterQueries();
    expect(queries).toContainEqual({ state: 'ACTIVE', category: 'ALARM', limit: 25 });
    expect(queries).toContainEqual({ state: 'UNACKNOWLEDGED', category: 'OCCURRENCE', limit: 5 });
    expect(queries).toContainEqual({ state: 'RESOLVED', category: 'ALARM', period: '24h', limit: 3 });
    expect(queries).toContainEqual({
      state: 'SUPPRESSED',
      category: 'ALARM',
      period: '24h',
      limit: 3,
    });
    expect(api.getAlarms).not.toHaveBeenCalled();
    expect(api.getAlarmOccurrences).not.toHaveBeenCalled();
    expect(api.getRecentResolvedAlarms).not.toHaveBeenCalled();
    expect(api.getAlertCenterSummary).toHaveBeenCalled();
  });

  it('mostra o alarme ativo com severidade, equipamento, interface e down desde', () => {
    const text = container.textContent ?? '';
    expect(text).toContain('LINK DOWN');
    expect(text).toContain('CRIT');
    expect(text).toContain('RNS-FLOR-6730-MPLS-01');
    expect(text).toContain('CLIENTE-ACME');
    expect(text).toContain('Down desde');
    expect(cards(container, '.alarm-panel__item:not(.alarm-panel__item--occurrence)')).toHaveLength(1);
  });

  it('mantem o alarme ativo de 40 dias na lista (idade nao esconde ativo)', async () => {
    activeFixture = [
      alarmItem({
        startedAt: new Date(NOW - 40 * 24 * HOUR).toISOString(),
        lastSeenAt: new Date(NOW - 40 * 24 * HOUR).toISOString(),
      }),
    ];
    await reload();
    expect(container.textContent).toContain('LINK DOWN');
    expect(container.textContent).toContain('Down desde');
  });

  it('alarme reconhecido continua ativo, atenuado e sem novo ACK', async () => {
    activeFixture = [
      alarmItem({
        state: 'ACTIVE_ACKNOWLEDGED',
        acknowledgedAt: new Date(NOW - 30 * MINUTE).toISOString(),
        acknowledgedBy: 'operador.noite',
      }),
    ];
    await reload();
    expect(container.querySelector('.alarm-panel__row--ack')).not.toBeNull();
    expect(container.textContent).toContain('✓ RECONHECIDO por operador.noite');
    expect(hasButton(container, 'Reconhecer')).toBe(false);
    expect(container.querySelectorAll('.alarm-panel__section--resolved')).toHaveLength(0);
  });

  it('ordena ativos por severidade nao reconhecida antes dos reconhecidos', async () => {
    activeFixture = [
      alarmItem({
        id: 'alarm-ack',
        severity: 'WARNING',
        typeLabel: 'ACK',
        state: 'ACTIVE_ACKNOWLEDGED',
        acknowledgedAt: new Date(NOW - MINUTE).toISOString(),
      }),
      alarmItem({ id: 'alarm-warn', severity: 'WARNING', typeLabel: 'WARN' }),
      alarmItem({ id: 'alarm-crit', severity: 'CRITICAL', typeLabel: 'CRIT' }),
    ];
    await reload();
    const labels = cards(container, '.alarm-panel__item-body strong').map((node) => node.textContent);
    expect(labels.slice(0, 3)).toEqual(['CRIT', 'WARN', 'ACK']);
  });

  it('reconhece o alarme pelo endpoint da F9.1 sem resolve-lo', async () => {
    await click(findButton(container, 'Reconhecer'));
    expect(api.acknowledgeAlarm).toHaveBeenCalledWith('alarm-1');
    activeFixture = [
      alarmItem({
        state: 'ACTIVE_ACKNOWLEDGED',
        acknowledgedAt: new Date(NOW).toISOString(),
        acknowledgedBy: 'qa-preview',
      }),
    ];
    await reload();
    expect(container.textContent).toContain('✓ RECONHECIDO por qa-preview');
    expect(container.querySelectorAll('.alarm-panel__section--resolved')).toHaveLength(0);
  });

  it('mostra o card de ERROS com taxa, limite e delta do periodo', async () => {
    activeFixture = [
      metricAlarm({ type: 'INTERFACE_ERRORS', typeLabel: 'ERROS', severity: 'MAJOR' }),
    ];
    await reload();
    const text = container.textContent ?? '';
    expect(text).toContain('RX 0.8 erros/min');
    expect(text).toContain('Limite 5/min');
    expect(text).toContain('+17 no período');
  });

  it('card de CRC com limite 0 mostra QUALQUER OCORRÊNCIA (preset delta > 0)', async () => {
    activeFixture = [
      metricAlarm({
        alarm: alarmDetail({
          metricKey: 'FCS',
          direction: 'RX',
          ratePerMinute: 0,
          thresholdPerMinute: 0,
        }),
      }),
    ];
    await reload();
    expect(container.textContent).toContain('QUALQUER OCORRÊNCIA');
  });

  it('card de DISCARDS mostra a direcao avaliada', async () => {
    activeFixture = [
      metricAlarm({
        type: 'INTERFACE_DISCARDS',
        typeLabel: 'DISCARDS',
        alarm: alarmDetail({
          metricKey: 'DISCARDS',
          direction: 'TX',
          ratePerMinute: 42,
          thresholdPerMinute: 20,
        }),
      }),
    ];
    await reload();
    expect(container.textContent).toContain('TX 42 discards/min');
    expect(container.textContent).toContain('Limite 20/min');
  });

  it('card optico escalar nao mostra lane', async () => {
    activeFixture = [
      opticalItem({
        alarm: alarmDetail({
          optical: opticalDetail({
            lane: null,
            rxPowerDbm: -11.5,
            rxHighAlarmDbm: null,
            marginDb: 0.81,
            proximityPercent: 88,
            trendDropDb: null,
            trendWindowMinutes: null,
            triggerReasons: ['PROXIMITY'],
          }),
        }),
      }),
    ];
    await reload();
    const text = container.textContent ?? '';
    expect(text).toContain('RX atual -11.50 dBm');
    expect(text).toContain('LOW -12.31 dBm');
    expect(text).toContain('Margem 0.8 dB');
    expect(text).not.toContain('Lane');
  });

  it('card optico por lane mostra lane, RX, LOW, HIGH, proximidade e queda', async () => {
    activeFixture = [opticalItem()];
    await reload();
    const text = container.textContent ?? '';
    expect(text).toContain('Lane 2');
    expect(text).toContain('RX atual -10.02 dBm');
    expect(text).toContain('HIGH +3.40 dBm');
    expect(text).toContain('Proximidade 91.3%');
    expect(text).toContain('Queda ↓ 4.3 dB / 30 min');
  });

  it('mostra apenas a proximidade quando a queda nao sustenta o alarme', async () => {
    activeFixture = [
      opticalItem({
        alarm: alarmDetail({
          optical: opticalDetail({ triggerReasons: ['PROXIMITY'] }),
        }),
      }),
    ];
    await reload();
    expect(container.textContent).toContain('Proximidade 91.3%');
    expect(container.textContent).not.toContain('Queda');
  });

  it('mostra apenas a queda quando so RAPID_DROP sustenta o alarme', async () => {
    activeFixture = [
      opticalItem({
        alarm: alarmDetail({
          optical: opticalDetail({ triggerReasons: ['RAPID_DROP'] }),
        }),
      }),
    ];
    await reload();
    expect(container.textContent).toContain('Queda ↓ 4.3 dB / 30 min');
    expect(container.textContent).not.toContain('Proximidade');
  });

  it('card de ocorrencia CRC mostra deltas, ocorrencias, taxa, pico e ultima', async () => {
    occurrenceFixture = [occurrenceItem()];
    await reload();
    const text = container.textContent ?? '';
    expect(text).toContain('OCORRÊNCIA');
    expect(text).toContain('CRC/FCS');
    expect(text).toContain('+17 CRC');
    expect(text).toContain('4 ocorrências');
    expect(text).toContain('Atual 0.8/min');
    expect(text).toContain('Pico 4.2/min');
    expect(text).toContain('Última há 3 min');
    expect(cards(container, '.alarm-panel__item--occurrence')).toHaveLength(1);
  });

  it('agrega RX e TX de discard em UM card, sem severidade inventada', async () => {
    activeFixture = [];
    occurrenceFixture = [discardItem()];
    await reload();
    const text = container.textContent ?? '';
    expect(text).toContain('DISCARDS');
    expect(text).toContain('RX +23 · TX +1364');
    expect(text).toContain('6 ocorrências');
    expect(text).toContain('Atual 90.9/min');
    expect(text).toContain('Pico 142.3/min');
    expect(cards(container, '.alarm-panel__item--occurrence')).toHaveLength(1);
    const card = container.querySelector('.alarm-panel__item--occurrence')!;
    expect(card.textContent).toContain('OCORRÊNCIA');
    // O card de ocorrencia nunca ganha severidade de regra.
    expect(card.textContent).not.toContain('CRIT');
    expect(card.textContent).not.toContain('MAJOR');
    expect(card.textContent).not.toContain('WARN');
  });

  it('ocorrencia vigente a 23h59 continua no painel', async () => {
    occurrenceFixture = [
      occurrenceItem({ lastSeenAt: new Date(NOW - (23 * HOUR + 59 * MINUTE)).toISOString() }),
    ];
    await reload();
    expect(container.textContent).toContain('CRC/FCS');
    expect(container.textContent).toContain('Última há 23h59m');
  });

  it('ocorrencia parada ha mais de 24h nao aparece no painel', async () => {
    occurrenceFixture = [occurrenceItem({ lastSeenAt: new Date(NOW - 25 * HOUR).toISOString() })];
    await reload();
    expect(container.querySelectorAll('.alarm-panel__item--occurrence')).toHaveLength(0);
    expect(container.textContent).not.toContain('Ocorrências não reconhecidas');
  });

  it('ACK de ocorrencia reconhece e tira o card do painel', async () => {
    activeFixture = [];
    occurrenceFixture = [occurrenceItem()];
    await reload();
    await click(findButton(container, 'Reconhecer'));
    expect(api.acknowledgeOperationalOccurrence).toHaveBeenCalledWith('occ-1');
    occurrenceFixture = [];
    await reload();
    expect(container.querySelectorAll('.alarm-panel__item--occurrence')).toHaveLength(0);
  });

  it('novo episodio depois do ACK aparece como card novo', async () => {
    occurrenceFixture = [];
    await reload();
    occurrenceFixture = [occurrenceItem({ id: 'occ-2', lastSeenAt: new Date(NOW).toISOString() })];
    await reload();
    expect(cards(container, '.alarm-panel__item--occurrence')).toHaveLength(1);
    expect(container.textContent).toContain('Última agora');
  });

  it('conta somente alarmes nos contadores e mostra EVENTOS separado', async () => {
    activeFixture = [
      alarmItem({ id: 'a1', severity: 'CRITICAL' }),
      alarmItem({ id: 'a2', severity: 'MAJOR' }),
      alarmItem({
        id: 'a3',
        severity: 'MAJOR',
        state: 'ACTIVE_ACKNOWLEDGED',
        acknowledgedAt: new Date(NOW).toISOString(),
      }),
    ];
    occurrenceFixture = [occurrenceItem(), discardItem()];
    summaryFixture = summary({
      alarmsActive: 3,
      alarmsActiveCritical: 1,
      alarmsActiveMajor: 2,
      alarmsActiveUnacknowledged: 2,
      alarmsActiveAcknowledged: 1,
      occurrencesUnacknowledged: 2,
    });
    await reload();
    const counters = cards(container, '.alarm-panel__counter').map((node) =>
      node.textContent?.trim(),
    );
    expect(counters).toEqual(['CRIT 1', 'MAJOR 2', 'WARN 0', 'EVENTOS 2']);
    expect(container.querySelector('.alarm-panel__count')?.textContent).toBe('3');
  });

  it('resolvido tecnico aparece com normalizacao e duracao', async () => {
    resolvedFixture = [
      alarmItem({
        id: 'alarm-res',
        state: 'RESOLVED',
        startedAt: new Date(NOW - 2 * HOUR).toISOString(),
        lastSeenAt: new Date(NOW - 10 * MINUTE).toISOString(),
        endedAt: new Date(NOW - 10 * MINUTE).toISOString(),
      }),
    ];
    await reload();
    const text = container.textContent ?? '';
    expect(text).toContain('RESOLVIDO');
    expect(text).toContain('Normalizado (recuperação técnica)');
    expect(text).toContain('Duração');
    expect(text).toContain('Resolvido às');
  });

  it('resolvido administrativo mostra o motivo e marca SUPRIMIDO', async () => {
    suppressedFixture = [
      alarmItem({
        id: 'alarm-sup',
        state: 'SUPPRESSED',
        endedAt: new Date(NOW - 5 * MINUTE).toISOString(),
        alarm: alarmDetail({
          resolutionReason: 'MANUAL_SUPPRESSION',
          suppression: {
            id: 'sup-1',
            mode: 'UNTIL_CLEAR',
            reason: 'MAINTENANCE',
            note: 'janela do cliente',
            suppressedBy: 'operador.noite',
            suppressedAt: new Date(NOW - 5 * MINUTE).toISOString(),
            expiresAt: null,
          },
        }),
      }),
    ];
    await reload();
    const text = container.textContent ?? '';
    expect(text).toContain('SUPRIMIDO');
    expect(text).toContain('Manutenção');
  });

  it('resolvidos recentes entram misturados e limitados a 3, do mais novo', async () => {
    resolvedFixture = [
      alarmItem({
        id: 'r1',
        typeLabel: 'RES-1',
        state: 'RESOLVED',
        endedAt: new Date(NOW - 30 * MINUTE).toISOString(),
      }),
      alarmItem({
        id: 'r2',
        typeLabel: 'RES-2',
        state: 'RESOLVED',
        endedAt: new Date(NOW - 20 * MINUTE).toISOString(),
      }),
      alarmItem({
        id: 'r3',
        typeLabel: 'RES-3',
        state: 'RESOLVED',
        endedAt: new Date(NOW - 40 * MINUTE).toISOString(),
      }),
    ];
    suppressedFixture = [
      alarmItem({
        id: 's1',
        typeLabel: 'SUP-1',
        state: 'SUPPRESSED',
        endedAt: new Date(NOW - 2 * MINUTE).toISOString(),
      }),
    ];
    await reload();
    const labels = cards(container, '.alarm-panel__resolved-body strong').map(
      (node) => node.textContent,
    );
    expect(labels).toHaveLength(3);
    expect(labels[0]).toContain('SUP-1');
    expect(labels[1]).toContain('RES-2');
    expect(labels[2]).toContain('RES-1');
  });

  it('limita ativos a 5 e ocorrencias a 5 indicando quanto ficou de fora', async () => {
    activeFixture = Array.from({ length: 6 }, (_, index) => alarmItem({ id: `a${index}` }));
    occurrenceFixture = Array.from({ length: 7 }, (_, index) =>
      occurrenceItem({ id: `o${index}`, lastSeenAt: new Date(NOW - index * MINUTE).toISOString() }),
    );
    activeTotal = 6;
    occurrenceTotal = 7;
    await reload();
    expect(cards(container, '.alarm-panel__item:not(.alarm-panel__item--occurrence)')).toHaveLength(5);
    expect(cards(container, '.alarm-panel__item--occurrence')).toHaveLength(5);
    expect(container.textContent).toContain('+1');
    expect(container.textContent).toContain('+2');
  });

  it('abre o detalhe reutilizando o drawer da Central', async () => {
    await click(container.querySelector<HTMLButtonElement>('.alarm-panel__item')!);
    const drawer = container.querySelector('.alerts-drawer');
    expect(drawer).not.toBeNull();
    expect(drawer!.textContent).toContain('RNS-FLOR-6730-MPLS-01');
    expect(drawer!.textContent).toContain('LINK DOWN');
    expect(drawer!.textContent).toContain('CLIENTE-ACME');
  });

  it('retirar abre o modal da F9.1 e envia o payload escolhido', async () => {
    await click(findButton(container, 'Retirar'));
    const modal = container.querySelector('.alerts-modal') as HTMLElement;
    expect(modal.textContent).toContain('RETIRAR / SUPRIMIR ALARME');
    const select = modal.querySelectorAll('select')[1] as HTMLSelectElement;
    await act(async () => {
      select.value = 'MAINTENANCE';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const note = modal.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => {
      // Setter nativo: sem ele o React nao enxerga o valor do input controlado.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(note, 'janela do cliente');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    await click(findButton(modal, 'SUPRIMIR'));
    expect(api.suppressAlarm).toHaveBeenCalledWith('alarm-1', {
      mode: 'UNTIL_CLEAR',
      reason: 'MAINTENANCE',
      note: 'janela do cliente',
      expiresAt: null,
    });
  });

  it('depois de suprimir o alarme sai dos ativos e nao vira recuperacao tecnica', async () => {
    await click(findButton(container, 'Retirar'));
    const modal = container.querySelector('.alerts-modal') as HTMLElement;
    await click(findButton(modal, 'SUPRIMIR'));
    expect(api.suppressAlarm).toHaveBeenCalled();
    activeFixture = [];
    suppressedFixture = [
      alarmItem({
        id: 'alarm-1',
        state: 'SUPPRESSED',
        endedAt: new Date(NOW).toISOString(),
        alarm: alarmDetail({
          resolutionReason: 'MANUAL_SUPPRESSION',
          suppression: {
            id: 'sup-1',
            mode: 'UNTIL_CLEAR',
            reason: 'INTENTIONAL_SHUTDOWN',
            note: null,
            suppressedBy: 'qa',
            suppressedAt: new Date(NOW).toISOString(),
            expiresAt: null,
          },
        }),
      }),
    ];
    await reload();
    expect(container.textContent).not.toContain('Down desde');
    expect(container.textContent).toContain('SUPRIMIDO');
  });

  it('VER TODOS OS ALERTAS abre o workspace sem tirar o mapa do contexto', async () => {
    await click(findButton(container, 'VER TODOS OS ALERTAS'));
    expect(useMapStore.getState().view).toBe('ALERTS');
    expect(useMapStore.getState().map?.id).toBe('map-1');
  });

  it('estado vazio vira faixa compacta com atalho para a Central', async () => {
    activeFixture = [];
    occurrenceFixture = [];
    await reload();
    const strip = container.querySelector('.alarm-panel--compact') as HTMLElement;
    expect(strip.textContent).toContain('Alarmes');
    expect(strip.textContent).toContain('Nenhum alerta exigindo atenção.');
    await click(findButton(strip, 'Ver Central'));
    expect(useMapStore.getState().view).toBe('ALERTS');
  });

  it('loading discreto enquanto a Central nao responde', async () => {
    await act(async () => root.unmount());
    api.getAlertCenter.mockImplementation(() => new Promise<AlertCenterResponse>(() => undefined));
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(AlarmPanel)));
    });
    expect(container.textContent).toContain('Carregando alertas…');
    expect(container.textContent).not.toContain('Não foi possível carregar alertas.');
  });

  it('falha da Central mostra erro seguro e retry sem quebrar o mapa', async () => {
    api.getAlertCenter.mockRejectedValue(new Error('API fora'));
    await reload();
    expect(container.textContent).toContain('Não foi possível carregar alertas.');
    expect(container.textContent).not.toContain('Error');
    const error = container.querySelector('.alarm-panel__error') as HTMLElement;
    api.getAlertCenter.mockImplementation(async () => response([alarmItem()]));
    await click(findButton(error, 'Tentar novamente'));
    expect(container.textContent).toContain('LINK DOWN');
  });

  it('badge flutuante conta ativos nao reconhecidos + ocorrencias vigentes', async () => {
    occurrenceFixture = [occurrenceItem()];
    summaryFixture = summary({
      alarmsActive: 4,
      alarmsActiveCritical: 2,
      alarmsActiveUnacknowledged: 2,
      alarmsActiveAcknowledged: 2,
      occurrencesUnacknowledged: 1,
    });
    await reload();
    await click(
      container.querySelector<HTMLButtonElement>(
        '.alarm-panel__actions button[aria-label="Ocultar painel de alertas"]',
      )!,
    );
    const reveal = container.querySelector('.alarm-panel__reveal') as HTMLButtonElement;
    expect(reveal.textContent).toContain('3');
    expect(reveal.className).toContain('alarm-panel__reveal--active');
    await click(reveal);
    expect(container.querySelector('.alarm-panel')).not.toBeNull();
  });

  it('mantem escala e posicao do painel (Normal, Grande, Extra)', async () => {
    expect(container.querySelector('.alarm-panel__scale .is-active')?.textContent).toBe('Grande');
    await click(findButton(container, 'Extra'));
    expect(window.localStorage.getItem('gmj:alarms:panel-scale')).toBe('150');
    expect(findButton(container, 'Extra').className).toContain('is-active');
    expect(
      (container.querySelector('.alarm-panel') as HTMLElement).style.getPropertyValue(
        '--alarm-scale',
      ),
    ).toBe('1.5');
  });

  it('respeita posicao salva a direita', async () => {
    window.localStorage.setItem('gmj:alarms:panel-position', 'RIGHT');
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(container.querySelector('.alarm-panel--right')).not.toBeNull();
  });

  it('abrir interface usa a mesma acao da Central (foca a interface no mapa)', async () => {
    activeFixture = [metricAlarm()];
    await reload();
    await click(container.querySelector<HTMLButtonElement>('.alarm-panel__item')!);
    await click(findButton(container, 'ABRIR INTERFACE'));
    expect(useMapStore.getState().selection).toEqual({
      kind: 'interface',
      id: 'iface-1',
      deviceId: 'dev-1',
    });
    expect(useMapStore.getState().interfaceSectionRequest?.section).toBe('METRICS');
  });

  it('sem mapa ativo o alerta avisa sem quebrar o painel', async () => {
    useMapStore.setState({ map: null, activeMapId: null });
    activeFixture = [alarmItem({ mapIds: [] })];
    await reload();
    await click(container.querySelector<HTMLButtonElement>('.alarm-panel__item')!);
    await click(findButton(container, 'ABRIR NO MAPA'));
    expect(useMapStore.getState().toast).toContain('não está em nenhum mapa');
    expect(container.querySelector('.alarm-panel')).not.toBeNull();
  });
});
