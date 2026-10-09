// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Alarm } from '@gmj/shared';

const media = vi.hoisted(() => ({
  getMediaIntegrationsByPurpose: vi.fn(),
  getRecentMediaLogs: vi.fn(),
  createMediaIntegration: vi.fn(),
  updateMediaIntegration: vi.fn(),
  testMediaAlarm: vi.fn(),
  MEDIA_STATUS_LABELS: {
    DISABLED: 'Desativado',
    NOT_CONFIGURED: 'Não configurado',
    NEVER_TESTED: 'Configurado · nunca testado',
    LAST_DELIVERY_OK: 'Último envio OK',
    LAST_DELIVERY_FAILED: 'Erro no último envio',
  },
  MEDIA_SOURCE_LABELS: {
    DATABASE: 'BANCO',
    ENV: 'ENV / LEGACY',
    MEMORY: 'MEMÓRIA (temporário)',
    NONE: 'NÃO CONFIGURADO',
  },
}));

const alarms = vi.hoisted(() => ({ useAlarmIndex: vi.fn(() => new Map()) }));

const api = vi.hoisted(() => ({ searchInterfaces: vi.fn() }));

vi.mock('@/lib/media-api', () => media);
vi.mock('@/lib/use-alarms', () => alarms);
vi.mock('@/lib/api', () => api);

import {
  AlarmTestChartSourceField,
  AlarmTestResultBanner,
  NetworkAlarmsMediaSection,
  alarmLogReference,
  alarmStatusRows,
  isNetworkAlarmEvent,
} from './network-alarms-media-section';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function overview(overrides: Record<string, unknown> = {}) {
  return {
    repositoryKind: 'DATABASE' as const,
    migrationReady: true,
    resolvedPurpose: 'NETWORK_ALARMS' as const,
    legacyEnv: {
      outboundUrlConfigured: false,
      outboundTokenConfigured: false,
      inboundTokenConfigured: false,
      inboundEndpointPath: '/api/integrations/n8n/mitigation-command',
    },
    integration: null,
    ...overrides,
  };
}

function integration(overrides: Record<string, unknown> = {}) {
  return {
    id: 'media-2',
    name: 'n8n — Alarmes de Rede',
    type: 'WEBHOOK' as const,
    purpose: 'NETWORK_ALARMS' as const,
    enabled: true,
    configSource: 'DATABASE' as const,
    status: 'LAST_DELIVERY_OK' as const,
    outboundConfigured: true,
    outboundUrl: 'https://n8n.exemplo.com/webhook/alarmes',
    outboundTokenConfigured: true,
    inboundEnabled: false,
    inboundConfigured: false,
    inboundTokenConfigured: false,
    inboundEndpointPath: '',
    lastOutboundAttemptAt: '2026-10-07T12:00:00.000Z',
    lastOutboundSuccessAt: '2026-10-07T12:00:00.000Z',
    lastOutboundFailureAt: null,
    lastOutboundStatusCode: 200,
    lastOutboundLatencyMs: 190,
    lastOutboundEvent: 'NETWORK_ALARM_OPENED',
    lastOutboundErrorSafe: null,
    lastInboundAt: null,
    lastInboundAction: null,
    lastInboundStatus: null,
    lastInboundRequestId: null,
    lastInboundErrorSafe: null,
    createdAt: '2026-10-07T11:00:00.000Z',
    updatedAt: '2026-10-07T12:00:00.000Z',
    ...overrides,
  };
}

const ALARM = {
  id: 'alarm-1',
  deviceName: 'BHE-VTA-S6750-MPLS-01',
  interfaceName: '100GE1/0/1',
  type: 'OPTICAL_RX_DEGRADATION',
  severity: 'MAJOR',
  metadata: { lane: 2 },
} as unknown as Alarm;

const ALARM_LOG = {
  id: 'log-1',
  direction: 'OUTBOUND' as const,
  event: 'NETWORK_ALARM_OPENED',
  action: null,
  profileId: null,
  requestId: 'alarm-1',
  status: 'SUCCESS' as const,
  httpStatus: 200,
  latencyMs: 190,
  idempotent: null,
  safeError: null,
  destination: 'https://n8n.exemplo.com',
  createdAt: '2026-10-07T12:00:00.000Z',
};

const MITIGATION_LOG = {
  ...ALARM_LOG,
  id: 'log-2',
  event: 'MITIGATION_VERIFIED',
  requestId: 'req-9',
};

describe('canal e eventos de alarme na camada de mídia', () => {
  it('identifica apenas eventos NETWORK_ALARM_*', () => {
    expect(isNetworkAlarmEvent('NETWORK_ALARM_OPENED')).toBe(true);
    expect(isNetworkAlarmEvent('NETWORK_ALARM_TEST')).toBe(true);
    expect(isNetworkAlarmEvent('MITIGATION_VERIFIED')).toBe(false);
    expect(isNetworkAlarmEvent(null)).toBe(false);
  });

  it('o status do canal de alarmes não tem inbound nem último comando', () => {
    const rows = alarmStatusRows(overview({ integration: integration() }) as never);
    expect(rows.map((row) => row.label)).toEqual([
      'Ativo',
      'Outbound configurado',
      'Configuração',
      'Último envio',
      'Resultado',
      'Último evento',
    ]);
    const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.value]));
    expect(byLabel).toMatchObject({
      Ativo: 'SIM',
      'Outbound configurado': 'SIM',
      Configuração: 'BANCO',
      Resultado: 'Último envio OK',
      'Último evento': 'NETWORK_ALARM_OPENED',
    });
    // Data formatada no fuso do navegador: basta não ser o placeholder.
    expect(byLabel['Último envio']).not.toBe('—');

    const empty = alarmStatusRows(overview() as never);
    expect(empty.find((row) => row.label === 'Resultado')?.value).toBe('Não configurado');
    expect(empty.find((row) => row.label === 'Ativo')?.value).toBe('—');
  });

  it('resolve a referência do alarme pelo requestId do log (sem payload bruto)', () => {
    expect(alarmLogReference(ALARM_LOG, new Map([['alarm-1', ALARM]]))).toBe(
      'BHE-VTA-S6750-MPLS-01 · 100GE1/0/1 · Lane 2 · RX OPTICO · MAJOR',
    );
    expect(alarmLogReference(ALARM_LOG, new Map())).toBe('');
  });

  it('banner do teste cobre sucesso, falha e não configurado', () => {
    const ok = renderToText(
      <AlarmTestResultBanner
        result={{
          ok: true,
          skipped: false,
          httpStatus: 200,
          latencyMs: 41,
          safeError: null,
          event: 'NETWORK_ALARM_TEST',
          checkedAt: '2026-10-07T12:00:00.000Z',
        }}
      />,
    );
    expect(ok).toContain('Webhook de alarme enviado com sucesso');
    expect(ok).toContain('HTTP 200');
    expect(ok).toContain('41 ms');

    const failed = renderToText(
      <AlarmTestResultBanner
        result={{
          ok: false,
          skipped: false,
          httpStatus: 500,
          latencyMs: 12,
          safeError: 'Webhook respondeu HTTP 500',
          event: 'NETWORK_ALARM_TEST',
          checkedAt: '2026-10-07T12:00:00.000Z',
        }}
      />,
    );
    expect(failed).toContain('Falha no webhook de alarmes · HTTP 500');
    expect(failed).toContain('Webhook respondeu HTTP 500');

    const skipped = renderToText(
      <AlarmTestResultBanner
        result={{
          ok: false,
          skipped: true,
          httpStatus: null,
          latencyMs: null,
          safeError: 'Webhook não configurado',
          event: 'NETWORK_ALARM_TEST',
          checkedAt: '2026-10-07T12:00:00.000Z',
        }}
      />,
    );
    expect(skipped).toContain('Webhook não configurado');
  });

  it('banner usa a mensagem segura do backend quando o grafico foi recusado', () => {
    const refused = renderToText(
      <AlarmTestResultBanner
        result={{
          ok: false,
          skipped: true,
          httpStatus: null,
          latencyMs: null,
          safeError: 'Selecione uma interface válida para gerar o gráfico de teste.',
          event: 'NETWORK_ALARM_TEST',
          checkedAt: '2026-10-07T12:00:00.000Z',
        }}
      />,
    );
    expect(refused).toContain('Selecione uma interface válida para gerar o gráfico de teste.');
    expect(refused).not.toContain('HTTP');
  });
});

function renderToText(element: ReactElement): string {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  const text = container.textContent ?? '';
  act(() => root.unmount());
  return text;
}

function clickCheckbox(input: HTMLInputElement | null): void {
  input?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

/** Input controlado no React: o value so muda pelo setter nativo + `input`. */
function typeInto(input: HTMLInputElement | null, value: string): void {
  if (!input) return;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function selectOption(select: HTMLSelectElement | null, value: string): void {
  if (!select) return;
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Espera ativa (debounce + react-query) ate a opcao aparecer na lista. */
async function waitForOption(scope: HTMLElement, text: string): Promise<HTMLButtonElement | null> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const found = [...scope.querySelectorAll('button')].find((item) =>
      item.textContent?.includes(text),
    );
    if (found) return found as HTMLButtonElement;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
  return null;
}

describe('campo de referência do gráfico (F9.5.2)', () => {
  it('busca no inventário, lista os resultados e devolve a escolha', async () => {
    const onSelect = vi.fn();
    api.searchInterfaces.mockResolvedValue([
      {
        interfaceId: 'if-f1a-48',
        deviceId: 'host-f1a',
        hostname: 'BHE-VTA-F1A-BGP-01',
        deviceName: 'BHE-VTA-F1A-BGP-01',
        interfaceName: '100GE0/1/48',
        alias: '',
        description: '',
        ifIndex: 48,
        status: 'UP',
        ip: null,
        vlan: null,
        maps: [],
      },
    ]);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(AlarmTestChartSourceField, { selected: null, onSelect, disabled: false }),
        ),
      );
    });
    const input = host.querySelector<HTMLInputElement>(
      'input[aria-label="Buscar interface de referência do gráfico"]',
    );
    await act(async () => {
      typeInto(input, '100GE0/1/48');
      await new Promise((resolve) => setTimeout(resolve, 320));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(api.searchInterfaces).toHaveBeenCalledWith('100GE0/1/48', 40);

    const option = await waitForOption(host, '100GE0/1/48');
    expect(option).not.toBeNull();
    await act(async () => {
      option?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ interfaceId: 'if-f1a-48', interfaceName: '100GE0/1/48' }),
    );
    await act(async () => root.unmount());
    host.remove();
  });
});

describe('editor da aba ALARMES DE REDE (F9.5)', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function mount(): Promise<void> {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const element: ReactElement = createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(NetworkAlarmsMediaSection),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(element);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  beforeEach(() => {
    media.getMediaIntegrationsByPurpose.mockResolvedValue(
      overview({ integration: integration() }),
    );
    media.getRecentMediaLogs.mockResolvedValue([ALARM_LOG, MITIGATION_LOG]);
    api.searchInterfaces.mockResolvedValue([]);
    media.testMediaAlarm.mockResolvedValue({
      ok: true,
      skipped: false,
      httpStatus: 200,
      latencyMs: 41,
      safeError: null,
      event: 'NETWORK_ALARM_TEST',
      checkedAt: '2026-10-07T12:00:00.000Z',
    });
    media.updateMediaIntegration.mockResolvedValue(integration());
    media.createMediaIntegration.mockResolvedValue(integration());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('mostra URL própria, token mascarado e nenhum bloco inbound', async () => {
    await mount();
    const text = container.textContent ?? '';

    expect(text).toContain('ALARMES DE REDE');
    expect(text).toContain('OUTBOUND — NetVision → n8n');
    expect(text).toContain('TESTAR ALARME');
    expect(text).toContain('Canal exclusivo dos alarmes');
    expect(text).not.toContain('INBOUND');
    expect(text).not.toContain('ÚLTIMOS COMANDOS');
    expect(text).not.toContain('GERAR NOVO TOKEN');

    const url = container.querySelector<HTMLInputElement>('input[type="url"]');
    expect(url?.value).toBe('https://n8n.exemplo.com/webhook/alarmes');
    const token = container.querySelector<HTMLInputElement>('input[aria-label="Token outbound de alarmes"]');
    expect(token?.type).toBe('password');
    expect(token?.value).toBe('');
  });

  it('lista somente entregas da própria integração (sem mitigação)', async () => {
    await mount();
    expect(media.getRecentMediaLogs).toHaveBeenCalledWith(
      { direction: 'OUTBOUND', limit: 30 },
      'media-2',
    );
    const text = container.textContent ?? '';
    expect(text).toContain('NETWORK_ALARM_OPENED');
    expect(text).not.toContain('MITIGATION_VERIFIED');
  });

  it('TESTAR ALARME usa o endpoint de alarmes e mostra o resultado', async () => {
    await mount();
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent?.includes('TESTAR ALARME'),
    );
    expect(button).toBeTruthy();

    await act(async () => {
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Defaults do simulador quando o operador não mexe nos seletores.
    expect(media.testMediaAlarm).toHaveBeenCalledWith('media-2', {
      type: 'INTERFACE_DOWN',
      event: 'OPENED',
      severity: 'CRITICAL',
      includeChart: false,
    });
    expect(container.textContent).toContain('Webhook de alarme enviado com sucesso');
    expect(container.textContent).toContain('HTTP 200');
  });

  it('simulador lista tipo/evento/severidade e avisa que nada é criado', async () => {
    await mount();
    const text = container.textContent ?? '';
    expect(text).toContain('TIPO DE TESTE');
    expect(text).toContain('EVENTO');
    expect(text).toContain('SEVERIDADE');
    expect(text).toContain('Simulação: não cria alarme no NetVision.');

    const typeSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Tipo de teste do alarme"]',
    );
    const options = [...(typeSelect?.options ?? [])].map((option) => option.value);
    expect(options).toEqual([
      'INTERFACE_DOWN',
      'INTERFACE_CRC',
      'INTERFACE_DISCARDS',
      'INTERFACE_ERRORS',
      'OPTICAL_RX_DEGRADATION',
    ]);
    const eventSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Evento do alarme de teste"]',
    );
    expect([...(eventSelect?.options ?? [])].map((option) => option.value)).toEqual([
      'OPENED',
      'ESCALATED',
      'RESOLVED',
    ]);
  });

  it('trocar o TIPO reposiciona a severidade no default daquele tipo', async () => {
    await mount();
    const typeSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Tipo de teste do alarme"]',
    );
    const severitySelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Severidade do alarme de teste"]',
    );
    expect(severitySelect?.value).toBe('CRITICAL');

    await act(async () => {
      if (typeSelect) {
        typeSelect.value = 'OPTICAL_RX_DEGRADATION';
        typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(severitySelect?.value).toBe('MAJOR');

    // O operador pode sobrescrever para testar formatação.
    await act(async () => {
      if (severitySelect) {
        severitySelect.value = 'CRITICAL';
        severitySelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(severitySelect?.value).toBe('CRITICAL');
  });

  /**
   * F9.5.2 — INCLUIR GRÁFICO ON pede a INTERFACE DE REFERÊNCIA: o seletor só
   * aparece para tipos com série, exige escolha antes de testar e manda apenas
   * o id no corpo (o texto do alarme continua sendo a fixture).
   */
  it('seletor de interface: só aparece para tipo com série e bloqueia o teste sem escolha', async () => {
    await mount();
    const toggle = container.querySelector<HTMLInputElement>(
      'input[aria-label="Incluir gráfico no alarme de teste"]',
    );
    expect(container.textContent).not.toContain('INTERFACE DE REFERÊNCIA DO GRÁFICO');

    // INTERFACE_DOWN não tem série: ligar o gráfico mostra o aviso, não exige nada.
    await act(async () => {
      clickCheckbox(toggle);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain('INCLUIR GRÁFICO [ON]');
    expect(container.textContent).toContain('não tem série histórica');
    expect(container.textContent).not.toContain('INTERFACE DE REFERÊNCIA DO GRÁFICO');

    // Tipo com série: o seletor aparece e o botão fica bloqueado até escolher.
    const typeSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Tipo de teste do alarme"]',
    );
    await act(async () => {
      selectOption(typeSelect, 'OPTICAL_RX_DEGRADATION');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain('INTERFACE DE REFERÊNCIA DO GRÁFICO');
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent?.includes('TESTAR ALARME'),
    );
    expect(button?.disabled).toBe(true);
  });

  it('seletor busca no inventário, escolhe a interface e envia chartInterfaceId', async () => {
    api.searchInterfaces.mockResolvedValue([
      {
        interfaceId: 'if-f1a-48',
        deviceId: 'host-f1a',
        hostname: 'BHE-VTA-F1A-BGP-01',
        deviceName: 'BHE-VTA-F1A-BGP-01',
        interfaceName: '100GE0/1/48',
        alias: 'BHE-VTA-S6750-MPLS-01-100GE1/0/1',
        description: '',
        ifIndex: 48,
        status: 'UP',
        ip: '10.0.0.1',
        vlan: null,
        maps: [],
      },
    ]);
    await mount();
    await act(async () => {
      selectOption(
        container.querySelector<HTMLSelectElement>('select[aria-label="Tipo de teste do alarme"]'),
        'OPTICAL_RX_DEGRADATION',
      );
      clickCheckbox(
        container.querySelector<HTMLInputElement>(
          'input[aria-label="Incluir gráfico no alarme de teste"]',
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const search = container.querySelector<HTMLInputElement>(
      'input[aria-label="Buscar interface de referência do gráfico"]',
    );
    await act(async () => {
      typeInto(search, '100GE0/1/48');
      await new Promise((resolve) => setTimeout(resolve, 320));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(api.searchInterfaces).toHaveBeenCalledWith('100GE0/1/48', 40);

    const option = await waitForOption(container, '100GE0/1/48');
    await act(async () => {
      option?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-testid="chart-source-selected"]')?.textContent).toContain(
      'BHE-VTA-F1A-BGP-01',
    );

    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent?.includes('TESTAR ALARME'),
    );
    expect(button?.disabled).toBe(false);
    await act(async () => {
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(media.testMediaAlarm).toHaveBeenCalledWith('media-2', {
      type: 'OPTICAL_RX_DEGRADATION',
      event: 'OPENED',
      severity: 'MAJOR',
      includeChart: true,
      chartInterfaceId: 'if-f1a-48',
    });
  });

  it('desligar INCLUIR GRÁFICO preserva a interface escolhida', async () => {
    await mount();
    const toggle = () =>
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Incluir gráfico no alarme de teste"]',
      );
    await act(async () => {
      selectOption(
        container.querySelector<HTMLSelectElement>('select[aria-label="Tipo de teste do alarme"]'),
        'INTERFACE_CRC',
      );
      clickCheckbox(toggle());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain('INTERFACE DE REFERÊNCIA DO GRÁFICO');

    await act(async () => {
      clickCheckbox(toggle());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).not.toContain('INTERFACE DE REFERÊNCIA DO GRÁFICO');

    await act(async () => {
      clickCheckbox(toggle());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.textContent).toContain('INTERFACE DE REFERÊNCIA DO GRÁFICO');
  });

  it('envia a seleção escolhida no corpo do teste', async () => {
    await mount();
    const typeSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Tipo de teste do alarme"]',
    );
    const eventSelect = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Evento do alarme de teste"]',
    );
    await act(async () => {
      if (typeSelect) {
        typeSelect.value = 'INTERFACE_CRC';
        typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (eventSelect) {
        eventSelect.value = 'RESOLVED';
        eventSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent?.includes('TESTAR ALARME'),
    );
    await act(async () => {
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(media.testMediaAlarm).toHaveBeenCalledWith('media-2', {
      type: 'INTERFACE_CRC',
      event: 'RESOLVED',
      severity: 'WARNING',
      includeChart: false,
    });
  });

  it('sem integração o canal aparece como não configurado e o teste fica bloqueado', async () => {
    media.getMediaIntegrationsByPurpose.mockResolvedValue(overview());
    media.getRecentMediaLogs.mockResolvedValue([]);
    await mount();

    const text = container.textContent ?? '';
    expect(text).toContain('Não configurado');
    expect(text).toContain('Nenhuma entrega de alarme registrada');
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent?.includes('TESTAR ALARME'),
    ) as HTMLButtonElement | undefined;
    expect(button?.disabled).toBe(true);
  });
});
