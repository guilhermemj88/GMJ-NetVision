// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const media = vi.hoisted(() => ({
  getMediaIntegrations: vi.fn(),
  getMediaSummary: vi.fn(),
  getRecentMediaLogs: vi.fn(),
  getMediaLogs: vi.fn(),
  createMediaIntegration: vi.fn(),
  updateMediaIntegration: vi.fn(),
  testMediaWebhook: vi.fn(),
  rotateMediaInboundToken: vi.fn(),
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

vi.mock('@/lib/media-api', () => media);

import { MediaIntegrationsPanel } from './media-integrations-panel';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const integration = {
  id: 'media-1',
  name: 'n8n — Mitigação DDoS',
  type: 'WEBHOOK' as const,
  purpose: 'BGP_MITIGATION' as const,
  enabled: true,
  configSource: 'DATABASE' as const,
  status: 'LAST_DELIVERY_OK' as const,
  outboundConfigured: true,
  outboundUrl: 'https://n8n.exemplo.com/webhook/abc',
  outboundTokenConfigured: true,
  inboundEnabled: true,
  inboundConfigured: true,
  inboundTokenConfigured: true,
  inboundEndpointPath: '/api/integrations/n8n/mitigation-command',
  lastOutboundAttemptAt: '2026-09-29T14:03:00.000Z',
  lastOutboundSuccessAt: '2026-09-29T14:03:00.000Z',
  lastOutboundFailureAt: null,
  lastOutboundStatusCode: 200,
  lastOutboundLatencyMs: 182,
  lastOutboundEvent: 'MITIGATION_VERIFIED',
  lastOutboundErrorSafe: null,
  lastInboundAt: '2026-09-29T14:10:00.000Z',
  lastInboundAction: 'REMOVE',
  lastInboundStatus: 'REMOVED_VERIFIED',
  lastInboundRequestId: 'in-1',
  lastInboundErrorSafe: null,
  createdAt: '2026-09-29T13:00:00.000Z',
  updatedAt: '2026-09-29T14:10:00.000Z',
};

let container: HTMLDivElement;
let root: Root;

async function render(element: ReactElement): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, element));
  });
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  media.getMediaIntegrations.mockResolvedValue({
    repositoryKind: 'DATABASE',
    migrationReady: true,
    legacyEnv: {
      outboundUrlConfigured: false,
      outboundTokenConfigured: false,
      inboundTokenConfigured: false,
      inboundEndpointPath: '/api/integrations/n8n/mitigation-command',
    },
    integration,
  });
  media.getRecentMediaLogs.mockResolvedValue([]);
  media.testMediaWebhook.mockResolvedValue({
    ok: true,
    skipped: false,
    httpStatus: 200,
    latencyMs: 182,
    safeError: null,
    event: 'MITIGATION_TEST',
    checkedAt: '2026-09-29T14:20:00.000Z',
  });
  media.rotateMediaInboundToken.mockResolvedValue({
    token: 'TOKEN-NOVO-1234567890',
    integration,
    warning: 'Este token não será exibido novamente. Atualize o n8n.',
  });
  media.createMediaIntegration.mockResolvedValue(integration);
  media.updateMediaIntegration.mockResolvedValue(integration);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('CONFIGURAÇÕES → MÍDIAS', () => {
  it('mostra o status da integração n8n sem exibir token', async () => {
    await render(createElement(MediaIntegrationsPanel));

    const text = container.textContent ?? '';
    expect(text).toContain('CONFIGURAÇÕES · MÍDIAS');
    expect(text).toContain('n8n — Mitigação DDoS');
    expect(text).toContain('Último envio OK');
    expect(text).toContain('MITIGATION_VERIFIED');
    expect(text).toContain('REMOVE');

    const tokenInput = container.querySelector<HTMLInputElement>('input[aria-label="Token outbound"]');
    expect(tokenInput?.type).toBe('password');
    expect(tokenInput?.value).toBe('');
    // Nunca usar o segredo REAL em fixture versionada (repo publico): o teste
    // so precisa provar que o token configurado NUNCA e renderizado.
    expect(container.innerHTML).not.toContain('SEGREDO-DE-TESTE-QUE-NAO-PODE-APARECER');
  });

  it('testa o webhook e mostra o resultado HTTP', async () => {
    await render(createElement(MediaIntegrationsPanel));

    const button = [...container.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('TESTAR WEBHOOK'),
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(media.testMediaWebhook).toHaveBeenCalledWith('media-1');
    expect(container.textContent).toContain('Webhook enviado com sucesso');
    expect(container.textContent).toContain('HTTP 200');
    expect(container.textContent).toContain('182 ms');
  });

  it('mostra o token de entrada uma única vez após gerar novo token', async () => {
    await render(createElement(MediaIntegrationsPanel));

    const rotateButton = [...container.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('GERAR NOVO TOKEN'),
    );
    await act(async () => {
      rotateButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.textContent).toContain('Novo token gerado. Copie agora.');
    expect(container.textContent).toContain('TOKEN-NOVO-1234567890');

    const hide = [...container.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === 'OCULTAR',
    );
    await act(async () => {
      hide?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).not.toContain('TOKEN-NOVO-1234567890');
  });

  it('lista as últimas entregas e os últimos comandos', async () => {
    media.getRecentMediaLogs.mockImplementation(
      (options: { direction?: string } = {}) =>
        Promise.resolve(
          options.direction === 'INBOUND'
            ? [
                {
                  id: 'log-in',
                  direction: 'INBOUND' as const,
                  event: null,
                  action: 'REMOVE',
                  profileId: 'profile-1',
                  requestId: 'in-1',
                  status: 'SUCCESS' as const,
                  httpStatus: 200,
                  latencyMs: null,
                  idempotent: false,
                  safeError: null,
                  destination: null,
                  createdAt: '2026-09-29T14:10:00.000Z',
                },
              ]
            : [
                {
                  id: 'log-out',
                  direction: 'OUTBOUND' as const,
                  event: 'MITIGATION_VERIFIED',
                  action: null,
                  profileId: 'profile-1',
                  requestId: 'evt-1',
                  status: 'SUCCESS' as const,
                  httpStatus: 200,
                  latencyMs: 182,
                  idempotent: null,
                  safeError: null,
                  destination: 'https://n8n.exemplo.com',
                  createdAt: '2026-09-29T14:03:00.000Z',
                },
              ],
        ),
    );

    await render(createElement(MediaIntegrationsPanel));

    const text = container.textContent ?? '';
    expect(text).toContain('ÚLTIMAS ENTREGAS');
    expect(text).toContain('MITIGATION_VERIFIED');
    expect(text).toContain('https://n8n.exemplo.com');
    expect(text).toContain('ÚLTIMOS COMANDOS');
    expect(text).toContain('REMOVE');
  });

  it('avisa quando a migration da fase ainda não está aplicada', async () => {
    media.getMediaIntegrations.mockResolvedValue({
      repositoryKind: 'DATABASE',
      migrationReady: false,
      legacyEnv: {
        outboundUrlConfigured: true,
        outboundTokenConfigured: true,
        inboundTokenConfigured: true,
        inboundEndpointPath: '/api/integrations/n8n/mitigation-command',
      },
      integration: null,
    });

    await render(createElement(MediaIntegrationsPanel));

    const text = container.textContent ?? '';
    expect(text).toContain('Migration da camada de mídias ainda não aplicada');
    expect(text).toContain('IMPORTAR PARA CONFIGURAÇÃO');
  });

  it('DESATIVA o outbound pelo botão, mantendo URL e token', async () => {
    await render(createElement(MediaIntegrationsPanel));

    const button = [...container.querySelectorAll('button')].find(
      (item) => (item.textContent ?? '').trim() === 'DESATIVAR',
    );
    expect(button).toBeTruthy();

    await act(async () => {
      button?.click();
      await flush();
    });

    expect(media.updateMediaIntegration).toHaveBeenCalledWith('media-1', { enabled: false });
  });

  it('ATIVA o outbound quando a integração está desativada (bug da tela)', async () => {
    media.getMediaIntegrations.mockResolvedValue({
      repositoryKind: 'DATABASE',
      migrationReady: true,
      legacyEnv: {
        outboundUrlConfigured: false,
        outboundTokenConfigured: false,
        inboundTokenConfigured: false,
        inboundEndpointPath: '/api/integrations/n8n/mitigation-command',
      },
      integration: { ...integration, enabled: false, status: 'DISABLED' as const },
    });

    await render(createElement(MediaIntegrationsPanel));

    const text = container.textContent ?? '';
    expect(text).toContain('Desativado');
    const button = [...container.querySelectorAll('button')].find(
      (item) => (item.textContent ?? '').trim() === 'ATIVAR',
    );
    expect(button, 'a tela precisa oferecer como ATIVAR o outbound desligado').toBeTruthy();

    await act(async () => {
      button?.click();
      await flush();
    });

    expect(media.updateMediaIntegration).toHaveBeenCalledWith('media-1', { enabled: true });
  });
});
