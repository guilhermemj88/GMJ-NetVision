// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Alarm } from '@gmj/shared';

const media = vi.hoisted(() => ({
  getMediaIntegrationsByPurpose: vi.fn(),
  getRecentMediaLogs: vi.fn(),
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

const alarms = vi.hoisted(() => ({ useAlarmIndex: vi.fn() }));

vi.mock('@/lib/media-api', () => media);
vi.mock('@/lib/use-alarms', () => alarms);

import {
  NetworkAlarmsMediaSection,
  alarmLogReference,
  describeAlarmChannel,
  isNetworkAlarmEvent,
} from './network-alarms-media-section';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function overview(overrides: Record<string, unknown> = {}) {
  return {
    repositoryKind: 'DATABASE' as const,
    migrationReady: true,
    resolvedPurpose: 'NETWORK_ALARMS' as const,
    shared: false,
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
    name: 'n8n — Alarmes',
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
  deviceId: 'dev-1',
  deviceName: 'BHE-VTA-S6750-MPLS-01',
  interfaceId: 'if-1',
  interfaceName: '100GE1/0/1',
  interfaceLabel: 'TO-CORE-01',
  ifIndex: 1,
  linkId: null,
  linkLabel: null,
  type: 'OPTICAL_RX_DEGRADATION',
  severity: 'MAJOR',
  startedAt: '2026-10-07T11:50:00.000Z',
  endedAt: null,
  acknowledgedAt: null,
  acknowledgedBy: null,
  message: 'RX optico',
  metadata: { lane: 2 },
} as unknown as Alarm;

describe('canal e eventos de alarme na camada de mídia', () => {
  it('identifica apenas eventos NETWORK_ALARM_*', () => {
    expect(isNetworkAlarmEvent('NETWORK_ALARM_OPENED')).toBe(true);
    expect(isNetworkAlarmEvent('MITIGATION_VERIFIED')).toBe(false);
    expect(isNetworkAlarmEvent(null)).toBe(false);
  });

  it('descreve canal compartilhado com a mitigação DDoS', () => {
    const description = describeAlarmChannel(
      overview({
        shared: true,
        resolvedPurpose: 'BGP_MITIGATION',
        integration: integration({ purpose: 'BGP_MITIGATION', configSource: 'DATABASE' }),
      }) as never,
    );
    expect(description.channel).toBe('Canal compartilhado com Mitigação DDoS');
    expect(description.detail).toContain('resolvedPurpose=BGP_MITIGATION');
    expect(description.shared).toBe(true);
  });

  it('descreve canal próprio, ENV e não configurado (SKIPPED)', () => {
    expect(describeAlarmChannel(overview({ integration: integration() }) as never).channel)
      .toBe('Canal próprio');
    expect(
      describeAlarmChannel(
        overview({
          resolvedPurpose: null,
          legacyEnv: {
            outboundUrlConfigured: true,
            outboundTokenConfigured: true,
            inboundTokenConfigured: false,
            inboundEndpointPath: '',
          },
        }) as never,
      ).channel,
    ).toBe('ENV (legado)');
    const skipped = describeAlarmChannel(overview({ resolvedPurpose: null }) as never);
    expect(skipped.channel).toBe('NÃO CONFIGURADO');
    expect(skipped.detail).toContain('SKIPPED');
  });

  it('resolve a referência do alarme pelo requestId do log (sem payload bruto)', () => {
    const reference = alarmLogReference(
      {
        id: 'log-1',
        direction: 'OUTBOUND',
        event: 'NETWORK_ALARM_OPENED',
        action: null,
        profileId: null,
        requestId: 'alarm-1',
        status: 'SUCCESS',
        httpStatus: 200,
        latencyMs: 12,
        idempotent: null,
        safeError: null,
        destination: 'https://n8n.exemplo.com/webhook/abc',
        createdAt: '2026-10-07T12:00:00.000Z',
      },
      new Map([['alarm-1', ALARM]]),
    );
    expect(reference).toBe('BHE-VTA-S6750-MPLS-01 · 100GE1/0/1 · Lane 2 · RX OPTICO · MAJOR');
    expect(
      alarmLogReference(
        {
          id: 'log-2',
          direction: 'OUTBOUND',
          event: 'NETWORK_ALARM_OPENED',
          action: null,
          profileId: null,
          requestId: 'alarm-antigo',
          status: 'SUCCESS',
          httpStatus: 200,
          latencyMs: 12,
          idempotent: null,
          safeError: null,
          destination: null,
          createdAt: '2026-10-07T12:00:00.000Z',
        },
        new Map(),
      ),
    ).toBe('');
  });
});

describe('render da seção de alarmes na mídia', () => {
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
      overview({
        shared: true,
        resolvedPurpose: 'BGP_MITIGATION',
        integration: integration({ purpose: 'BGP_MITIGATION', outboundUrl: 'https://n8n.exemplo.com/webhook/abc?token=segredo' }),
      }),
    );
    media.getRecentMediaLogs.mockResolvedValue([
      {
        id: 'log-1',
        direction: 'OUTBOUND',
        event: 'NETWORK_ALARM_OPENED',
        action: null,
        profileId: null,
        requestId: 'alarm-1',
        status: 'SUCCESS',
        httpStatus: 200,
        latencyMs: 190,
        idempotent: null,
        safeError: null,
        destination: 'https://n8n.exemplo.com/webhook/abc',
        createdAt: '2026-10-07T12:00:00.000Z',
      },
      {
        id: 'log-2',
        direction: 'OUTBOUND',
        event: 'MITIGATION_VERIFIED',
        action: null,
        profileId: 'p1',
        requestId: 'req-9',
        status: 'SUCCESS',
        httpStatus: 200,
        latencyMs: 30,
        idempotent: null,
        safeError: null,
        destination: 'https://n8n.exemplo.com/webhook/abc',
        createdAt: '2026-10-07T12:01:00.000Z',
      },
    ]);
    alarms.useAlarmIndex.mockReturnValue(new Map([['alarm-1', ALARM]]));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('mostra canal compartilhado, última entrega e logs filtrados por purpose', async () => {
    await mount();

    expect(container.textContent).toContain('Canal compartilhado com Mitigação DDoS');
    expect(container.textContent).toContain('resolvedPurpose=BGP_MITIGATION');
    expect(container.textContent).toContain('NETWORK_ALARM_OPENED');
    expect(container.textContent).toContain('BHE-VTA-S6750-MPLS-01 · 100GE1/0/1 · Lane 2');
    expect(container.textContent).toContain('HTTP 200');
    expect(container.textContent).toContain('190 ms');
    // Log de mitigação não é log de alarme.
    expect(container.textContent).not.toContain('MITIGATION_VERIFIED');
  });

  it('nunca renderiza token, segredo ou URL sensível', async () => {
    await mount();
    const text = container.textContent ?? '';
    expect(text).toContain('ALARMES DE REDE');
    for (const forbidden of ['segredo', 'token', 'X-NetVision-Token', 'community', 'senha']) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
