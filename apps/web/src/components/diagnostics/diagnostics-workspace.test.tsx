// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MplsHostOverview } from '@gmj/shared';

const api = vi.hoisted(() => ({
  getVsiDiagnosticStatus: vi.fn(),
  getHosts: vi.fn(),
  getHostMpls: vi.fn(),
}));
const auth = vi.hoisted(() => ({ useAuth: vi.fn() }));

vi.mock('@/lib/api', () => api);
vi.mock('@/app/providers', () => auth);

import { DiagnosticsWorkspace } from './diagnostics-workspace';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const APPROVAL_ID = '11111111-2222-4333-8444-555555555555';

const overview = {
  supported: true,
  capabilities: { vsi: true, pw: true, ac: true },
  source: 'SNMP',
  lastPollingAt: new Date().toISOString(),
  lastSuccessAt: new Date().toISOString(),
  lastErrorSafe: null,
  summary: {},
  vsis: [{ id: 'vsi-1', hostId: 'host-1', name: 'SERVICE-A', status: 'UP', pws: [], acs: [] }],
} as unknown as MplsHostOverview;

function approval() {
  const now = Date.now();
  return {
    approvalId: APPROVAL_ID,
    hostId: 'host-1',
    vsiId: 'vsi-1',
    createdBy: 'admin',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 600_000).toISOString(),
  };
}

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let deviceFetch: ReturnType<typeof vi.fn>;

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

function byText(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) => button.textContent === label) as
    | HTMLButtonElement
    | undefined;
}

async function renderAs(role: 'ADMIN' | 'VIEWER'): Promise<void> {
  auth.useAuth.mockReturnValue({
    user: { id: 'u1', name: 'QA', email: 'qa@local', username: 'qa', role },
    logout: vi.fn(),
  });
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(DiagnosticsWorkspace)),
    );
  });
  await settle();
}

beforeEach(() => {
  api.getHosts.mockResolvedValue([{ id: 'host-1', name: 'BHE-VTA-6730-MPLS-01' }]);
  api.getHostMpls.mockResolvedValue(overview);
  deviceFetch = vi.fn(async () => Response.json(approval()));
  vi.stubGlobal('fetch', deviceFetch);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('DiagnosticsWorkspace — gate de runtime', () => {
  it('com recurso desativado mostra DESATIVADO e nao dispara request de approval nem diagnose', async () => {
    api.getVsiDiagnosticStatus.mockResolvedValue({
      diagnosticEnabled: false,
      diagnosticTrust: 'UNAVAILABLE',
    });
    await renderAs('ADMIN');
    expect(container.textContent).toContain('Diagnóstico');
    expect(container.textContent).toContain('DESATIVADO');
    expect(container.textContent).toContain('indisponível');

    const selects = container.querySelectorAll('select');
    await choose(selects[0] as HTMLSelectElement, 'host-1');
    await choose(container.querySelectorAll('select')[1] as HTMLSelectElement, 'vsi-1');

    expect(container.textContent).toContain('Diagnóstico VSI desativado');
    expect(byText('Preparar janela')?.disabled).toBe(true);
    expect(byText('Diagnosticar')?.disabled).toBe(true);

    await act(async () => byText('Preparar janela')?.click());
    await act(async () => byText('Diagnosticar')?.click());
    expect(deviceFetch).not.toHaveBeenCalled();
  });

  it('com recurso ativado representa ATIVO e libera apenas a janela para ADMIN', async () => {
    api.getVsiDiagnosticStatus.mockResolvedValue({
      diagnosticEnabled: true,
      diagnosticTrust: 'AVAILABLE',
    });
    await renderAs('ADMIN');
    expect(container.textContent).toContain('ATIVO');
    expect(container.textContent).toContain('disponível');

    const selects = container.querySelectorAll('select');
    await choose(selects[0] as HTMLSelectElement, 'host-1');
    await choose(container.querySelectorAll('select')[1] as HTMLSelectElement, 'vsi-1');

    expect(byText('Preparar janela')?.disabled).toBe(false);
    expect(byText('Diagnosticar')?.disabled).toBe(true);

    await act(async () => byText('Preparar janela')?.click());
    expect(deviceFetch).toHaveBeenCalledWith(
      '/api/hosts/host-1/mpls/vsis/vsi-1/diagnostic-approvals',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(container.textContent).toContain('Janela one-shot válida');
    expect(byText('Diagnosticar')?.disabled).toBe(false);
    expect(deviceFetch).toHaveBeenCalledTimes(1);
  });

  it('usuario sem permissao de execucao ve a area, mas nao arma a janela', async () => {
    api.getVsiDiagnosticStatus.mockResolvedValue({
      diagnosticEnabled: true,
      diagnosticTrust: 'AVAILABLE',
    });
    await renderAs('VIEWER');
    const selects = container.querySelectorAll('select');
    await choose(selects[0] as HTMLSelectElement, 'host-1');
    await choose(container.querySelectorAll('select')[1] as HTMLSelectElement, 'vsi-1');
    expect(byText('Preparar janela')?.disabled).toBe(true);
    expect(byText('Diagnosticar')?.disabled).toBe(true);
    await act(async () => byText('Preparar janela')?.click());
    expect(deviceFetch).not.toHaveBeenCalled();
  });
});
