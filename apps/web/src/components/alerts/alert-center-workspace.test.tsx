// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AlertCenterItem, AlertCenterResponse, AlertCenterSummary, NetworkMap } from '@gmj/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMapStore } from '@/store/map-store';

const api = vi.hoisted(() => ({
  getAlertCenter: vi.fn(),
  getAlertCenterSummary: vi.fn(),
  acknowledgeAlarm: vi.fn(),
  acknowledgeOperationalOccurrence: vi.fn(),
  suppressAlarm: vi.fn(),
}));

vi.mock('@/lib/api', () => api);

import { AlertCenterWorkspace } from './alert-center-workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const NOW = new Date('2026-10-12T12:00:00.000Z').getTime();
const HOUR = 60 * 60 * 1000;

function summary(patch: Partial<AlertCenterSummary> = {}): AlertCenterSummary {
  return {
    alarmsActive: 2,
    alarmsActiveCritical: 1,
    alarmsActiveMajor: 1,
    alarmsActiveWarning: 0,
    alarmsActiveInfo: 0,
    alarmsActiveUnacknowledged: 1,
    alarmsActiveAcknowledged: 1,
    occurrencesUnacknowledged: 1,
    occurrencesAcknowledged: 0,
    occurrencesQuiet24h: 0,
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
    lastSeenAt: new Date(NOW - HOUR).toISOString(),
    endedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    valueSummary: 'DOWN',
    mapIds: ['map-1'],
    alarm: {
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
      message: 'Interface 100GE0/0/2 DOWN',
      linkId: null,
      linkLabel: null,
      resolutionReason: null,
      suppression: null,
      optical: null,
    },
    ...patch,
  };
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
    interfaceName: 'XGE0/0/15',
    interfaceAlias: 'SBA-GEN-UPLINK',
    interfaceLabel: 'SBA-GEN-UPLINK',
    ifIndex: 1015,
    startedAt: new Date(NOW - 5 * HOUR).toISOString(),
    lastSeenAt: new Date(NOW - 2 * HOUR).toISOString(),
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

function opticalItem(): AlertCenterItem {
  return alarmItem({
    id: 'alarm-optical',
    type: 'OPTICAL_RX_DEGRADATION',
    typeLabel: 'RX OPTICO',
    severity: 'MAJOR',
    valueSummary: '-10.02 dBm · LOW -12.31 dBm · margem 2.29 dB · lane 2',
    alarm: {
      ...alarmItem().alarm!,
      metricKey: 'LANE_2',
      currentValue: -10.02,
      thresholdValue: -12.31,
      unit: 'dBm',
      optical: {
        lane: 2,
        rxPowerDbm: -10.02,
        rxLowAlarmDbm: -12.31,
        rxHighAlarmDbm: 3.4,
        marginDb: 2.29,
        proximityPercent: 18.7,
        trendDropDb: 5.1,
        trendWindowMinutes: 30,
        triggerReasons: ['PROXIMITY', 'RAPID_DROP'],
        thresholdSource: 'DEVICE',
        currentPowerSource: 'SNMP',
      },
    },
  });
}

function response(items: AlertCenterItem[], patch: Partial<AlertCenterResponse> = {}): AlertCenterResponse {
  return {
    items,
    total: items.length,
    limit: 50,
    offset: 0,
    hasMore: false,
    state: 'ACTIVE',
    summary: summary(),
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

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.trim().includes(label),
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Botão não encontrado: ${label}`);
  return button;
}

function rows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll('tbody tr'));
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

describe('AlertCenterWorkspace (F9.3)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    api.getAlertCenterSummary.mockResolvedValue({ summary: summary() });
    api.acknowledgeAlarm.mockResolvedValue({});
    api.acknowledgeOperationalOccurrence.mockResolvedValue({
      occurrence: occurrenceItem(),
      acknowledged: true,
    });
    api.suppressAlarm.mockResolvedValue({ suppression: { id: 'sup-1' }, closedAlarms: 1 });
    api.getAlertCenter.mockResolvedValue(response([alarmItem(), occurrenceItem()]));
    useMapStore.setState({
      view: 'ALERTS',
      map: null,
      maps: [],
      activeMapId: null,
      selection: null,
      panel: null,
    });
    window.history.replaceState(null, '', '/?view=alerts');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    await act(async () => {
      root.render(
        createElement(QueryClientProvider, { client }, createElement(AlertCenterWorkspace)),
      );
    });
    await settle();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('renderiza os cards de resumo com os numeros do backend', () => {
    const text = container.textContent ?? '';
    expect(text).toContain('Ativos');
    expect(text).toContain('Críticos');
    expect(text).toContain('Avisos');
    expect(text).toContain('Ocorrências');
    expect(text).toContain('Reconhecidos');
    expect(text).toContain('2 item(ns) exigindo atenção');
    expect(container.querySelectorAll('.alerts-cards button')).toHaveLength(5);
  });

  it('renderiza a tabela com alarme e ocorrencia e badges corretos', () => {
    const all = rows(container);
    expect(all).toHaveLength(2);
    const alarmRow = all.find((row) => row.textContent?.includes('LINK DOWN'));
    expect(alarmRow?.textContent).toContain('RNS-FLOR-6730-MPLS-01');
    expect(alarmRow?.querySelector('.alerts-chip--critical')?.textContent).toBe('ATIVO');
    expect(alarmRow?.querySelector('.alerts-chip--critical')).not.toBeNull();

    const occurrenceRow = all.find((row) => row.textContent?.includes('CRC/FCS'));
    // Ocorrencia usa badge de categoria, NUNCA severidade inventada.
    expect(occurrenceRow?.textContent).toContain('OCORRÊNCIA');
    expect(occurrenceRow?.textContent).toContain('+17 CRC · 0.8/min');
    const severityLike = Array.from(
      occurrenceRow?.querySelectorAll('.alerts-chip') ?? [],
    ).map((chip) => chip.textContent);
    expect(severityLike).not.toContain('CRIT');
    expect(severityLike).not.toContain('MAJOR');
    expect(severityLike).not.toContain('WARN');
  });

  it('mostra o resumo e o total, com paginacao coerente', () => {
    expect(container.textContent).toContain('de 2');
    expect(findButton(container, 'Anterior').disabled).toBe(true);
    expect(findButton(container, 'Próxima').disabled).toBe(true);
  });

  it('pagina quando ha mais itens (offset enviado ao backend)', async () => {
    api.getAlertCenter.mockResolvedValue(
      response(
        Array.from({ length: 50 }, (_, index) => alarmItem({ id: `alarm-${index}` })),
        { total: 120, hasMore: true },
      ),
    );
    await act(async () => {
      await client.invalidateQueries();
    });
    await settle();
    await click(findButton(container, 'Próxima'));
    expect(api.getAlertCenter).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 50, offset: 50 }),
    );
    expect(findButton(container, 'Anterior').disabled).toBe(false);
  });

  it('aplica filtros de estado, categoria e severidade', async () => {
    const selects = Array.from(container.querySelectorAll('select'));
    const stateSelect = selects[0]!;
    await act(async () => {
      stateSelect.value = 'ALL';
      stateSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(api.getAlertCenter).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'ALL' }),
    );

    const categorySelect = selects[1]!;
    await act(async () => {
      categorySelect.value = 'OCCURRENCE';
      categorySelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(api.getAlertCenter).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: 'OCCURRENCE' }),
    );

    // Card CRITICOS aplica severidade (filtro que so existe em alarme).
    await click(findButton(container, 'Críticos'));
    expect(api.getAlertCenter).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'ACTIVE', severities: ['CRITICAL'] }),
    );
  });

  it('busca por texto envia o termo para o backend', async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'acme');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    expect(api.getAlertCenter).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: 'acme' }),
    );
  });

  it('seleciona itens reconheciveis e ignora os ja reconhecidos', async () => {
    const acked = alarmItem({
      id: 'alarm-acked',
      state: 'ACTIVE_ACKNOWLEDGED',
      acknowledgedAt: new Date(NOW - HOUR).toISOString(),
      acknowledgedBy: 'qa-preview',
      lastSeenAt: new Date(NOW - 30 * 60_000).toISOString(),
    });
    api.getAlertCenter.mockResolvedValue(response([alarmItem(), acked, occurrenceItem()]));
    await act(async () => {
      await client.invalidateQueries();
    });
    await settle();

    const checkboxes = Array.from(container.querySelectorAll<HTMLInputElement>('tbody input'));
    expect(checkboxes).toHaveLength(3);
    expect(checkboxes[1]!.disabled).toBe(true);
    await act(async () => {
      checkboxes[0]!.click();
    });
    await settle();
    expect(container.textContent).toContain('1 selecionado(s)');
  });

  it('reconhece um alarme pela linha', async () => {
    await click(findButton(container, 'Reconhecer'));
    expect(api.acknowledgeAlarm).toHaveBeenCalledWith('alarm-1');
    expect(container.textContent).toContain('Reconhecido');
  });

  it('reconhece uma ocorrencia pela linha (endpoint proprio)', async () => {
    const item = occurrenceItem();
    api.getAlertCenter.mockResolvedValue(response([item]));
    await act(async () => {
      await client.invalidateQueries();
    });
    await settle();
    await click(findButton(container, 'Reconhecer'));
    expect(api.acknowledgeOperationalOccurrence).toHaveBeenCalledWith('occ-1');
    expect(api.acknowledgeAlarm).not.toHaveBeenCalled();
  });

  it('reconhece em lote itens das duas categorias', async () => {
    const checkboxes = Array.from(container.querySelectorAll<HTMLInputElement>('tbody input'));
    await act(async () => {
      checkboxes[0]!.click();
      checkboxes[1]!.click();
    });
    await settle();
    await click(findButton(container, 'RECONHECER SELECIONADOS'));
    expect(api.acknowledgeAlarm).toHaveBeenCalledWith('alarm-1');
    expect(api.acknowledgeOperationalOccurrence).toHaveBeenCalledWith('occ-1');
    expect(container.textContent).toContain('2 reconhecido(s)');
  });

  it('reporta falha parcial do lote sem fingir sucesso total', async () => {
    api.acknowledgeOperationalOccurrence.mockRejectedValue(new Error('409 conflito'));
    const checkboxes = Array.from(container.querySelectorAll<HTMLInputElement>('tbody input'));
    await act(async () => {
      checkboxes[0]!.click();
      checkboxes[1]!.click();
    });
    await settle();
    await click(findButton(container, 'RECONHECER SELECIONADOS'));
    const text = container.textContent ?? '';
    expect(text).toContain('1 reconhecido(s)');
    expect(text).toContain('1 falhou(aram)');
    expect(text).toContain('409 conflito');
    expect(api.acknowledgeAlarm).toHaveBeenCalledTimes(1);
  });

  it('abre o detalhe do alarme com estado, tempo e ACK', async () => {
    await click(rows(container)[0]!);
    const drawer = container.querySelector('.alerts-drawer')!;
    const text = drawer.textContent ?? '';
    expect(text).toContain('Origem');
    expect(text).toContain('100GE0/0/2');
    expect(text).toContain('CLIENTE-ACME');
    expect(text).toContain('Duração');
    expect(text).toContain('Reconhecimento');
    expect(text).toContain('Não');
    expect(text).toContain('Interface 100GE0/0/2 DOWN');
  });

  it('abre o detalhe da ocorrencia com totais e midia N/A', async () => {
    await click(rows(container)[1]!);
    const text = container.querySelector('.alerts-drawer')!.textContent ?? '';
    expect(text).toContain('Ocorrência');
    expect(text).toContain('CRC acumulado');
    expect(text).toContain('17');
    expect(text).toContain('Taxa atual');
    expect(text).toContain('Pico');
    expect(text).toContain('Mídia');
    expect(text).toContain('N/A');
  });

  it('abre o detalhe optico com LOW, margem e criterios', async () => {
    api.getAlertCenter.mockResolvedValue(response([opticalItem()]));
    await act(async () => {
      await client.invalidateQueries();
    });
    await settle();
    await click(rows(container)[0]!);
    const text = container.querySelector('.alerts-drawer')!.textContent ?? '';
    expect(text).toContain('Óptico');
    expect(text).toContain('-12.31 dBm');
    expect(text).toContain('2.29 dB');
    expect(text).toContain('PROXIMITY, RAPID_DROP');
    expect(text).toContain('DEVICE');
    expect(text).toContain('SNMP');
  });

  it('retira o alarme reutilizando a supressao da F9.1', async () => {
    await click(rows(container)[0]!);
    await click(findButton(container, 'RETIRAR / SUPRIMIR'));
    const modal = container.querySelector('.alerts-modal')!;
    expect(modal.textContent).toContain('RETIRAR / SUPRIMIR ALARME');
    const selects = Array.from(modal.querySelectorAll('select'));
    await act(async () => {
      selects[0]!.value = 'UNTIL_TIME';
      selects[0]!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(modal.textContent).toContain('ATÉ');
    await click(findButton(modal as HTMLElement, 'CANCELAR'));
    expect(container.querySelector('.alerts-modal')).toBeNull();
  });

  it('envia a supressao com modo, motivo e nota', async () => {
    const { suppressAlarm } = api;
    await click(rows(container)[0]!);
    await click(findButton(container, 'RETIRAR / SUPRIMIR'));
    const modal = container.querySelector('.alerts-modal') as HTMLElement;
    const selects = Array.from(modal.querySelectorAll('select'));
    const note = modal.querySelector<HTMLInputElement>('input[type="text"]')!;
    await act(async () => {
      selects[1]!.value = 'MAINTENANCE';
      selects[1]!.dispatchEvent(new Event('change', { bubbles: true }));
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(note, 'janela do cliente');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    await click(findButton(modal, 'SUPRIMIR'));
    expect(suppressAlarm).toHaveBeenCalledWith('alarm-1', {
      mode: 'UNTIL_CLEAR',
      reason: 'MAINTENANCE',
      note: 'janela do cliente',
      expiresAt: null,
    });
    expect(container.textContent).toContain('Alarme retirado');
  });

  it('abre a interface no mapa ativo pelo ContextDrawer existente', async () => {
    useMapStore.setState({ map: mapFixture(), activeMapId: 'map-1' });
    await click(rows(container)[0]!);
    await click(findButton(container, 'ABRIR INTERFACE'));
    const state = useMapStore.getState();
    expect(state.view).toBe('MAP');
    expect(state.selection).toEqual({ kind: 'interface', id: 'iface-1', deviceId: 'dev-1' });
  });

  it('avisa quando o equipamento nao esta em nenhum mapa', async () => {
    useMapStore.setState({ map: null, activeMapId: null });
    const item = occurrenceItem({ mapIds: [] });
    api.getAlertCenter.mockResolvedValue(response([item]));
    await act(async () => {
      await client.invalidateQueries();
    });
    await settle();
    await click(rows(container)[0]!);
    await click(findButton(container, 'ABRIR NO MAPA'));
    expect(container.textContent).toContain('não está em nenhum mapa');
    expect(useMapStore.getState().view).toBe('ALERTS');
  });

  it('troca de mapa quando o item pertence a outro mapa', async () => {
    useMapStore.setState({ map: null, activeMapId: null });
    const item = alarmItem({ mapIds: ['map-9'] });
    api.getAlertCenter.mockResolvedValue(response([item]));
    await act(async () => {
      await client.invalidateQueries();
    });
    await settle();
    await click(rows(container)[0]!);
    await click(findButton(container, 'ABRIR NO MAPA'));
    const state = useMapStore.getState();
    expect(state.view).toBe('MAP');
    expect(state.activeMapId).toBe('map-9');
    expect(state.pendingDeviceNavigation).toEqual({ mapId: 'map-9', deviceId: 'dev-1' });
  });

  it('mostra skeleton durante o carregamento', async () => {
    // Remonta com uma leitura que nunca resolve: o skeleton precisa aparecer.
    await act(async () => root.unmount());
    api.getAlertCenter.mockImplementation(() => new Promise<AlertCenterResponse>(() => undefined));
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(QueryClientProvider, { client }, createElement(AlertCenterWorkspace)),
      );
    });
    expect(container.querySelector('.alerts-skeleton')).not.toBeNull();
  });

  it('mostra estado vazio com a mensagem dos filtros', async () => {
    api.getAlertCenter.mockResolvedValue(response([], { total: 0 }));
    await act(async () => {
      await client.invalidateQueries();
    });
    await settle();
    expect(container.textContent).toContain('Nenhum alerta para os filtros selecionados.');
  });

  it('mostra falha segura com retry disponivel', async () => {
    api.getAlertCenter.mockRejectedValue(new Error('API fora'));
    await act(async () => {
      await client.invalidateQueries();
    });
    await settle();
    const empty = container.querySelector('.alerts-empty')!;
    expect(empty.textContent).toContain('Falha ao carregar os alertas.');
    expect(empty.textContent).toContain('O restante do NetVision continua funcionando.');
    expect(findButton(empty as HTMLElement, 'Tentar novamente')).toBeInstanceOf(HTMLButtonElement);
    expect(container.textContent).not.toContain('Error');
  });
});
