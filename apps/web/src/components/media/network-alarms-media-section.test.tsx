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

vi.mock('@/lib/media-api', () => media);
vi.mock('@/lib/use-alarms', () => alarms);

import {
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
    expect(skipped).toContain('Webhook de alarmes não configurado');
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
